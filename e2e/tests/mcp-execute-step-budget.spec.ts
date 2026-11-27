/**
 * Execute runs programs in an interpreter on the product's own thread. A program that only computes
 * used to run until its five-minute wall-time budget, keeping the product busy all that time: on
 * production one program spent 203 s in the interpreter and other requests slowed until clients
 * gave up. The step budget stops such a program with `TimeoutExceeded` long before its wall time,
 * whatever its own `catch` does, while other requests keep answering and an ordinary program that
 * calls tools and loops still completes. Native calls are charged for the data they read and
 * return, so a loop of large `split` calls, one step each, stops in seconds too, and so are
 * operators that walk or coerce a whole value. A value a call returns that the program already
 * holds, such as a group `Map.get` returns, is not charged, so grouping many rows into few groups
 * completes. Storing a value walks it once to reject cycles; that walk is charged, and a value
 * whose graph was walked is not walked again until something changes inside it, so attaching one
 * shared value to every row completes, even one of 1,000 records, while storing a row into that
 * shared value is still rejected as a cycle.
 * Storing the value a property already holds skips that walk, so grouping row objects with
 * `g[k] = g[k] || []` completes. Joining strings with `+` or a template is charged by the length
 * of the result, so a loop that joins a megabyte string stops in seconds.
 */
import { expect, layer } from "@effect/vitest";
import { Deferred, Duration, Effect, Exit, Fiber, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { McpClient } from "../support/mcp-client.ts";

/** The products' default `maxSteps` (`defaultMcpLimits` in packages/mcp). */
const defaultMaxSteps = 5_000_000;
/** The products' default wall-time budget, which the runaway program must end well inside. */
const defaultTimeoutMs = 5 * 60_000;

const Executed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({
    ok: Schema.Boolean,
    value: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.Struct({ kind: Schema.String, message: Schema.String })),
    toolCalls: Schema.Array(Schema.Struct({ name: Schema.String, outcome: Schema.String })),
  }),
});

const WalkCacheFuzzResult = Schema.Struct({
  mismatch: Schema.String,
  accepted: Schema.Number,
  cyclesRejected: Schema.Number,
  sortOps: Schema.Number,
  partialSortOps: Schema.Number,
  jsonChecks: Schema.Number,
});

const barrierAppSource = (
  origin: string,
) => `import { defineApp, query, object, string, router } from "apps";
export default defineApp({}, async () => ({ tools: router({
  checkpoint: query(
    { input: object({ stage: string() }), description: "Coordinate walk-cache overlap barrier" },
    async (ctx, { stage }) => {
      const response = await ctx.fetch(${JSON.stringify(origin)} + "/" + stage, {
        method: "POST",
        signal: ctx.signal,
      });
      if (!response.ok) throw new Error("Barrier failed: " + response.status);
      return await response.json();
    },
  ),
}) }));`;

/**
 * Loopback coordination server that observes the exact server-side interleaving between the
 * victim program and the noisy program. Holds `/victim-warm` open until `/noise-hit` arrives from
 * a concurrent execution (or times out after 15 s if executions were serialized).
 */
const startWalkBarrier = () =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const events: Array<string> = [];
      const victimWarmed = yield* Deferred.make<void>();
      let victimHeld = false;
      let victimDone = false;
      let noiseHitsWhileVictimHeld = 0;
      let noiseHitsBeforeVictimDone = 0;
      let releaseVictim: ((timedOut: boolean) => void) | undefined;

      const server = createServer((req, res) => {
        const sendJson = (target: ServerResponse, status: number, payload: unknown) => {
          if (target.writableEnded) return;
          target.writeHead(status, { "content-type": "application/json" });
          target.end(JSON.stringify(payload));
        };

        if (req.method === "POST" && req.url === "/victim-warm") {
          events.push("victim-warm");
          victimHeld = true;
          let finished = false;
          const finish = (timedOut: boolean) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            victimHeld = false;
            if (releaseVictim === finish) releaseVictim = undefined;
            sendJson(res, timedOut ? 504 : 200, { released: !timedOut, timedOut });
          };
          const timer = setTimeout(() => finish(true), 15_000);
          releaseVictim = finish;
          req.on("close", () => {
            if (!finished) {
              clearTimeout(timer);
              victimHeld = false;
              if (releaseVictim === finish) releaseVictim = undefined;
            }
          });
          Deferred.doneUnsafe(victimWarmed, Exit.void);
          return;
        }

        if (req.method === "POST" && req.url === "/noise-hit") {
          events.push("noise-hit");
          const held = victimHeld;
          if (held) noiseHitsWhileVictimHeld += 1;
          if (!victimDone) noiseHitsBeforeVictimDone += 1;
          releaseVictim?.(false);
          sendJson(res, 200, { ok: true, whileVictimHeld: held });
          return;
        }

        if (req.method === "POST" && req.url === "/victim-done") {
          events.push("victim-done");
          victimDone = true;
          sendJson(res, 200, { ok: true });
          return;
        }

        sendJson(res, 404, { error: "not found" });
      });

      const port = yield* Effect.callback<number>((resume) => {
        server.once("error", (error) => resume(Effect.die(error)));
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (address === null || typeof address === "string") {
            resume(Effect.die(new Error("Walk barrier server did not bind a TCP port")));
            return;
          }
          resume(Effect.succeed(address.port));
        });
      });

      return {
        origin: `http://127.0.0.1:${port}`,
        events,
        victimWarmed,
        snapshot: () => ({
          events: [...events],
          noiseHitsWhileVictimHeld,
          noiseHitsBeforeVictimDone,
        }),
        close: () => {
          releaseVictim?.(true);
          server.close();
        },
      };
    }),
    (barrier) => Effect.sync(() => barrier.close()),
  );

type Connected = Effect.Success<ReturnType<Effect.Success<typeof McpClient>["connect"]>>;

const execute = (client: Connected, name: string, code: string) =>
  Effect.gen(function* () {
    const [took, { execution }] = yield* client
      .use(`Run the ${name} program`, (client, signal) =>
        client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
      )
      .pipe(
        Effect.flatMap((result) => Schema.decodeUnknownEffect(Executed)(result.structuredContent)),
        Effect.timed,
      );
    const ms = Math.round(Duration.toMillis(took));
    yield* (yield* Evidence).json(`${name}.json`, { ms, execution });
    return { ms, execution };
  });

/** Connects to hosted MCP execute with a new API key for the owner, deleted when the case ends. */
const connectHosted = (label: string) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors,
      mcp = yield* McpClient;
    const key = yield* body(
      Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
      yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", { name: label }),
    );
    yield* Effect.addFinalizer(() =>
      api
        .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
        .pipe(Effect.orDie),
    );
    return yield* mcp.connect(key.key, label, { organization: actors.organization.id });
  });

/** Calls a tool every product serves without setup, then loops briefly, as ordinary programs do. */
const ordinary = `
const found = await tools.search({ query: 'executor', limit: 1 });
let sum = 0;
for (let i = 0; i < 1000; i++) sum += i;
return { items: Array.isArray(found.items), sum };`;
const ordinaryValue = { items: true, sum: 499_500 };

/**
 * Never returns on its own, and tries to outlast the budget: each iteration catches what it
 * throws and runs a finally block, and the program returns from its outer catch.
 */
const runaway = `
let n = 0;
try {
  while (true) {
    try { n++; if (n % 1000 === 0) throw new Error('again'); } catch (e) { n++; } finally { n++; }
  }
} catch (e) {
  return 'caught: ' + String(e);
}`;

/**
 * The review's proof that native calls escaped the budget: each `split` is one step, but builds a
 * million-element array. Uncharged, it ran 83 s and outlasted a 60 s wall-time budget.
 */
const nativeRunaway = `
const s = "x".repeat(1000000);
let n = 0;
for (let i = 0; i < 100000; i++) { n += s.split("").length }
return n;`;

/**
 * The review's proof that operators escaped the budget: comparing a million-element array to a
 * string coerces the whole array each time, in one step. Uncharged, it ran to the wall clock.
 */
const operatorRunaway = `
const a = Array.from({ length: 1000000 }, (_, i) => i);
let n = 0;
for (let i = 0; i < 100000; i++) { if (a == "x") n++ }
return n;`;

/**
 * The review's realistic operator proof: merging 20,000 records into an index of 20,000 by checking
 * `id in index`. `in` walked the whole index on every check and this ran to the 120 s wall
 * clock; it reads one key now.
 */
const dedupeWithIn = `
const a = Array.from({ length: 20000 }, (_, i) => ({ id: 'r' + i, name: 'n' + i, tags: ['x', 'y'] }));
const b = Array.from({ length: 20000 }, (_, i) => ({ id: 'r' + i * 2, name: 'm' + i, tags: ['z'] }));
const byId = {};
for (const r of a) byId[r.id] = r;
let added = 0;
for (const r of b) { if (!(r.id in byId)) { byId[r.id] = r; added++ } }
return added;`;

/**
 * Groups 50,000 rows into a few groups with `Map.get`, which returns a group of thousands of rows
 * every time. Charging that group as if copied stopped it in under a second.
 */
const groupBy = (groups: number) => `
const rows = Array.from({ length: 50000 }, (_, i) => ({ k: 'k' + (i % ${groups}), v: i }));
const g = new Map();
for (const r of rows) { const a = g.get(r.k) ?? []; a.push(r.v); g.set(r.k, a) }
return g.size;`;

/**
 * The same grouping into an object, reassigning each group after the push. Storing a group walked
 * it to reject cycles, thousands of rows every time, uncharged; the walk now stops at groups
 * already known to hold no objects.
 */
const groupByObject = `
const rows = Array.from({ length: 50000 }, (_, i) => ({ k: 'k' + (i % 10), v: i }));
const g = {};
for (const r of rows) { const a = g[r.k] || []; a.push(r.v); g[r.k] = a }
return Object.keys(g).length;`;

/**
 * Attaches one shared value of 50,000 columns to each of 20,000 rows. Each store walked all
 * 50,000 columns, uncharged, and ran for minutes.
 */
const sharedMeta = `
const meta = { columns: Array.from({ length: 50000 }, (_, i) => 'c' + i) };
const rows = Array.from({ length: 20000 }, (_, i) => ({ id: i }));
for (const r of rows) { r.meta = meta }
return rows.length;`;

/**
 * Attaches one shared value of 1,000 records, each an object, to each of 20,000 rows. Each store
 * walked all 1,000 records, about 500 steps, and the program stopped at the budget halfway.
 */
const sharedRecordsMeta = `
const meta = { records: Array.from({ length: 1000 }, (_, i) => ({ id: 'm' + i, label: 'L' + i, w: i })) };
const rows = [];
for (let i = 0; i < 20000; i++) rows.push({ id: i, meta });
return rows.length;`;

/**
 * Stores rows holding the shared value, then a row into one of its records: the walk must not stop
 * at the shared value it walked before, because the record it changes is inside it.
 */
const sharedMetaCycle = `
const meta = { records: Array.from({ length: 1000 }, (_, i) => ({ id: 'm' + i })) };
const rows = [];
for (let i = 0; i < 10; i++) rows.push({ id: i, meta });
try { meta.records[5].back = rows[3]; return 'stored'; } catch (e) { return String(e) }`;

/**
 * The review's proof that string `+` escaped the budget: joining a megabyte string to a number is
 * one step, and reading the result copies the megabyte. Uncharged, it ran to the wall clock.
 */
const concatRunaway = `
const s = "x".repeat(1000000);
let n = 0;
for (let i = 0; i < 1000000; i++) { const t = s + i; n += t.charCodeAt(500000) }
return n;`;

/**
 * Groups 50,000 row objects into 10 groups by storing each group back into itself before the push.
 * The store walked the whole group, every row in it, on every row, and stopped at the budget.
 */
const groupRowsOrPush = `
const rows = Array.from({ length: 50000 }, (_, i) => ({ k: 'k' + (i % 10), v: i, name: 'n' + i }));
const g = {};
for (const r of rows) { g[r.k] = g[r.k] || []; g[r.k].push(r) }
return Object.keys(g).length;`;

/** The same grouping in the `reduce` form. */
const groupRowsReduce = `
const rows = Array.from({ length: 50000 }, (_, i) => ({ k: 'k' + (i % 10), v: i, name: 'n' + i }));
const g = rows.reduce((acc, r) => { (acc[r.k] = acc[r.k] || []).push(r); return acc }, {});
return Object.keys(g).length;`;

/**
 * The review's proof that templates escaped the budget: interpolating a megabyte string is one
 * step, and reading the result copies the megabyte. Uncharged, it ran to the wall clock.
 */
const templateRunaway = `
const s = "x".repeat(1000000);
let n = 0;
for (let i = 0; i < 1000000; i++) { const t = \`\${s}\${i}\`; n += t.charCodeAt(500000) }
return n;`;

/** Filters and maps 10,000 records, as programs do with a large tool result. */
const recordsTransform = `
const records = Array.from({ length: 10000 }, (_, i) => ({ id: 'r' + i, price: i % 100, tags: ['a', 'b'] }));
const cheap = records.filter((record) => record.price < 50).map((record) => ({ id: record.id, price: record.price * 2 }));
return { kept: cheap.length, json: JSON.stringify(cheap).length > 0 };`;

/**
 * Three tool calls with a 200,000-iteration loop between them: several times the interpreter work
 * of the programs agents send, which spend well under a second before their first call.
 */
const heavyButFine = `
const first = await tools.search({ query: 'executor', limit: 1 });
let total = 0;
for (let i = 0; i < 200000; i++) total = (total + i) % 1000003;
const second = await tools.search({ query: 'github', limit: 1 });
const third = await tools.search({ query: 'slack', limit: 1 });
return { total, calls: [first, second, third].length };`;

/**
 * Attaches a 1,000-record shared `meta` to 20,000 rows while yielding periodically. With a
 * per-execution WalkCache, `meta` is walked once regardless of concurrent executions; with a
 * module-global epoch, concurrent mutations invalidate `meta` on every yield and exhaust the
 * 5,000,000-step budget.
 */
const sharedMetaUnderNoiseVictim = (barrierSlug?: string) => `
const meta = {
  records: Array.from({ length: 1000 }, (_, i) => ({
    id: 'm' + i,
    label: 'L' + i,
    w: i,
    a: i + 1,
    b: i + 2,
    c: i + 3,
    d: i + 4,
    e: i + 5,
    f: i + 6,
    g: i + 7,
  })),
};
const rows = [];
rows.push({ id: 0, meta });
${
  barrierSlug === undefined
    ? ""
    : `const gate = await tools[${JSON.stringify(barrierSlug)}].checkpoint({ stage: 'victim-warm' });
if (!gate.released) throw new Error('Victim barrier did not observe concurrent noise');`
}
for (let i = 1; i < 20000; i++) {
  rows.push({ id: i, meta });
  if (i % 2 === 0) await 0;
}
${
  barrierSlug === undefined
    ? ""
    : `await tools[${JSON.stringify(barrierSlug)}].checkpoint({ stage: 'victim-done' });`
}
return rows.length;`;

/**
 * Repeatedly mutates an object held inside a walked outer object, yielding between steps, and
 * signals the barrier server after warming and mutating so overlap is observed server-side.
 */
const walkEpochNoise = (barrierSlug: string) => `
const inner = { v: 1 };
const outer = { inner };
const init = [];
init.push(outer);
const box = {};
for (let i = 0; i < 4000; i++) {
  box.a = inner;
  inner.x = { n: i };
  box.a = null;
  if (i === 500) await tools[${JSON.stringify(barrierSlug)}].checkpoint({ stage: 'noise-hit' });
  if (i % 2 === 0) await 0;
}
return 4000;`;

/**
 * Comparator empties `t` and links `t` into `x`. Placing a valid object before `x` proves that a
 * later item's rejection leaves zero partial write-back (`t.length === 0`).
 */
const sortDirectCycle = `
const x = {};
const t = [{ ok: 1 }, x, 1];
let err = '';
try {
  t.sort(() => { t.splice(0); x.t = t; return 0; });
} catch (e) {
  err = String(e);
}
return { err, len: t.length };`;

/** Comparator empties `t` and caches `t` as a leaf; write-back must invalidate `t`'s leaf cache. */
const sortLeafCacheCycle = `
const x = {};
const keep = [];
const t = [x, {}];
t.sort(() => { t.splice(0); keep.push(t); return 0; });
let err = '';
try {
  x.k = { t };
} catch (e) {
  err = String(e);
}
return err;`;

/** Comparator empties `t` and caches `outer = { t }`; write-back must advance the walk epoch. */
const sortAncestorCacheCycle = `
const x = {};
const keep = [];
const t = [x, {}];
const outer = { t };
t.sort(() => { t.splice(0); keep.push(outer); return 0; });
let err = '';
try {
  x.o = outer;
} catch (e) {
  err = String(e);
}
return err;`;

/** Control: comparator sort preserves explicit `undefined` vs. trailing sparse holes. */
const sortSparseControl = `
const a = [{ k: 2 }, undefined, , { k: 1 }];
a.sort((l, r) => l.k - r.k);
return [
  a.length,
  a[0].k,
  a[1].k,
  Object.hasOwn(a, 2),
  a[2] === undefined,
  Object.hasOwn(a, 3),
].join(',');`;

/** Control: sorting 5,000 10-key objects with a comparator stays well within the step budget. */
const sortLargeObjectsControl = `
const items = Array.from({ length: 5000 }, (_, i) => ({
  id: (i * 7919) % 5000,
  k0: i,
  k1: i + 1,
  k2: i + 2,
  k3: i + 3,
  k4: i + 4,
  k5: i + 5,
  k6: i + 6,
  k7: i + 7,
  k8: i + 8,
}));
items.sort((l, r) => l.id - r.id);
for (let i = 1; i < items.length; i++) {
  if (items[i - 1].id > items[i].id) return -1;
}
return items.length;`;

/**
 * Deterministic differential fuzz of WalkCache and every mutating graph operation against an
 * independent BFS reachability oracle on a shadow adjacency list.
 */
const walkCacheSeededFuzz = `
const seeds = [101, 202, 303, 404, 505];
const keys = ['a', 'b', 'c', 'd'];
let accepted = 0;
let cyclesRejected = 0;
let sortOps = 0;
let partialSortOps = 0;
let jsonChecks = 0;
let mismatch = '';

for (const initialSeed of seeds) {
  let state = initialSeed >>> 0;
  const nextInt = (bound) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state >>> 16) % bound;
  };

  const nodes = [];
  const shadow = [];
  const keep = [];
  for (let i = 0; i < 10; i++) {
    if (i % 2 === 0) {
      nodes.push({});
      shadow.push({});
    } else {
      nodes.push([]);
      shadow.push([]);
    }
  }
  const objIndices = [0, 2, 4, 6, 8];
  const arrIndices = [1, 3, 5, 7, 9];

  const canReach = (start, target) => {
    if (start === target) return true;
    const visited = new Set([start]);
    const queue = [start];
    for (let head = 0; head < queue.length; head++) {
      const cur = queue[head];
      const edges = shadow[cur];
      if (Array.isArray(edges)) {
        for (let i = 0; i < edges.length; i++) {
          if (!Object.hasOwn(edges, i)) continue;
          const nxt = edges[i];
          if (nxt === target) return true;
          if (nxt >= 0 && !visited.has(nxt)) {
            visited.add(nxt);
            queue.push(nxt);
          }
        }
      } else {
        for (const k of Object.keys(edges)) {
          const nxt = edges[k];
          if (nxt === target) return true;
          if (nxt >= 0 && !visited.has(nxt)) {
            visited.add(nxt);
            queue.push(nxt);
          }
        }
      }
    }
    return false;
  };

  for (let step = 0; step < 420 && mismatch === ''; step++) {
    const op = nextInt(9);
    if (op === 0) {
      const u = objIndices[nextInt(objIndices.length)];
      const k = keys[nextInt(keys.length)];
      const v = nextInt(10);
      const same = Object.hasOwn(shadow[u], k) && shadow[u][k] === v;
      const expected = same ? false : canReach(v, u);
      let threw = false;
      try {
        nodes[u][k] = nodes[v];
      } catch (e) {
        threw = String(e).includes('contains a circular value');
        if (!threw) mismatch = 'unexpected error on obj assign: ' + String(e);
      }
      if (mismatch === '' && threw !== expected) {
        mismatch = 'seed ' + initialSeed + ' step ' + step + ' obj assign expected=' + expected + ' threw=' + threw;
      }
      if (threw) cyclesRejected++;
      else {
        shadow[u][k] = v;
        accepted++;
      }
    } else if (op === 1) {
      const u = objIndices[nextInt(objIndices.length)];
      const k = keys[nextInt(keys.length)];
      delete nodes[u][k];
      delete shadow[u][k];
      accepted++;
    } else if (op === 2) {
      const u = arrIndices[nextInt(arrIndices.length)];
      const idx = nextInt(Math.min(shadow[u].length + 1, 5));
      const v = nextInt(10);
      const same = Object.hasOwn(shadow[u], idx) && shadow[u][idx] === v;
      const expected = same ? false : canReach(v, u);
      let threw = false;
      try {
        nodes[u][idx] = nodes[v];
      } catch (e) {
        threw = String(e).includes('contains a circular value');
        if (!threw) mismatch = 'unexpected error on arr assign: ' + String(e);
      }
      if (mismatch === '' && threw !== expected) {
        mismatch = 'seed ' + initialSeed + ' step ' + step + ' arr assign expected=' + expected + ' threw=' + threw;
      }
      if (threw) cyclesRejected++;
      else {
        shadow[u][idx] = v;
        accepted++;
      }
    } else if (op === 3) {
      const u = arrIndices[nextInt(arrIndices.length)];
      if (shadow[u].length >= 5) {
        nodes[u].splice(0, 2);
        shadow[u].splice(0, 2);
      }
      const count = 1 + nextInt(2);
      const vals = [];
      for (let c = 0; c < count; c++) vals.push(nextInt(10));
      const expected = vals.some((v) => canReach(v, u));
      let threw = false;
      try {
        nodes[u].push(...vals.map((v) => nodes[v]));
      } catch (e) {
        threw = String(e).includes('contains a circular value');
        if (!threw) mismatch = 'unexpected error on push: ' + String(e);
      }
      if (mismatch === '' && threw !== expected) {
        mismatch = 'seed ' + initialSeed + ' step ' + step + ' push expected=' + expected + ' threw=' + threw;
      }
      if (threw) cyclesRejected++;
      else {
        shadow[u].push(...vals);
        accepted++;
      }
    } else if (op === 4) {
      const u = arrIndices[nextInt(arrIndices.length)];
      if (shadow[u].length >= 5) {
        nodes[u].pop();
        shadow[u].pop();
      }
      const v = nextInt(10);
      const expected = canReach(v, u);
      let threw = false;
      try {
        nodes[u].unshift(nodes[v]);
      } catch (e) {
        threw = String(e).includes('contains a circular value');
        if (!threw) mismatch = 'unexpected error on unshift: ' + String(e);
      }
      if (mismatch === '' && threw !== expected) {
        mismatch = 'seed ' + initialSeed + ' step ' + step + ' unshift expected=' + expected + ' threw=' + threw;
      }
      if (threw) cyclesRejected++;
      else {
        shadow[u].unshift(v);
        accepted++;
      }
    } else if (op === 5) {
      const u = arrIndices[nextInt(arrIndices.length)];
      const start = nextInt(shadow[u].length + 1);
      const del = nextInt(3);
      const insert = nextInt(2) === 0 ? [] : [nextInt(10)];
      const expected = insert.some((v) => canReach(v, u));
      let threw = false;
      try {
        nodes[u].splice(start, del, ...insert.map((v) => nodes[v]));
      } catch (e) {
        threw = String(e).includes('contains a circular value');
        if (!threw) mismatch = 'unexpected error on splice: ' + String(e);
      }
      if (mismatch === '' && threw !== expected) {
        mismatch = 'seed ' + initialSeed + ' step ' + step + ' splice expected=' + expected + ' threw=' + threw;
      }
      if (threw) cyclesRejected++;
      else {
        shadow[u].splice(start, del, ...insert);
        accepted++;
      }
    } else if (op === 6) {
      const u = arrIndices[nextInt(arrIndices.length)];
      if (shadow[u].length === 0) continue;
      const v = nextInt(10);
      const end = Math.min(2, shadow[u].length);
      const expected = canReach(v, u);
      let threw = false;
      try {
        nodes[u].fill(nodes[v], 0, end);
      } catch (e) {
        threw = String(e).includes('contains a circular value');
        if (!threw) mismatch = 'unexpected error on fill: ' + String(e);
      }
      if (mismatch === '' && threw !== expected) {
        mismatch = 'seed ' + initialSeed + ' step ' + step + ' fill expected=' + expected + ' threw=' + threw;
      }
      if (threw) cyclesRejected++;
      else {
        shadow[u].fill(v, 0, end);
        accepted++;
      }
    } else if (op === 7) {
      const u = objIndices[nextInt(objIndices.length)];
      const s = objIndices[nextInt(objIndices.length)];
      if (u === s) continue;
      const committed = [];
      let expected = false;
      for (const k of Object.keys(shadow[s])) {
        const v = shadow[s][k];
        if (canReach(v, u)) {
          expected = true;
          break;
        }
        committed.push([k, v]);
      }
      let threw = false;
      try {
        Object.assign(nodes[u], nodes[s]);
      } catch (e) {
        threw = String(e).includes('contains a circular value');
        if (!threw) mismatch = 'unexpected error on Object.assign: ' + String(e);
      }
      if (mismatch === '' && threw !== expected) {
        mismatch = 'seed ' + initialSeed + ' step ' + step + ' assign expected=' + expected + ' threw=' + threw;
      }
      for (const [k, v] of committed) shadow[u][k] = v;
      if (threw) cyclesRejected++;
      else accepted++;
    } else {
      const u = arrIndices[nextInt(arrIndices.length)];
      if (shadow[u].length < 2) continue;
      sortOps++;
      const origItems = shadow[u].slice();
      const mode = nextInt(3);
      const partialRemoval = origItems.length >= 2 && nextInt(2) === 1;
      const removeCount = partialRemoval ? 1 + nextInt(origItems.length - 1) : origItems.length;
      if (partialRemoval) partialSortOps++;
      const targetObj = objIndices[nextInt(objIndices.length)];
      const targetKey = keys[nextInt(keys.length)];
      let mutated = false;
      let threw = false;
      try {
        nodes[u].sort(() => {
          if (!mutated) {
            mutated = true;
            nodes[u].splice(0, removeCount);
            shadow[u].splice(0, removeCount);
            if (mode === 0) {
              const innerSame = Object.hasOwn(shadow[targetObj], targetKey) && shadow[targetObj][targetKey] === u;
              const innerExpected = innerSame ? false : canReach(u, targetObj);
              let innerThrew = false;
              try {
                nodes[targetObj][targetKey] = nodes[u];
              } catch (e) {
                innerThrew = String(e).includes('contains a circular value');
                if (!innerThrew) mismatch = 'unexpected inner sort error: ' + String(e);
              }
              if (mismatch === '' && innerThrew !== innerExpected) {
                mismatch = 'seed ' + initialSeed + ' step ' + step + ' sort inner expected=' + innerExpected + ' threw=' + innerThrew;
              }
              if (!innerThrew) shadow[targetObj][targetKey] = u;
            } else if (mode === 1) {
              keep.push(nodes[u]);
            } else {
              keep.push({ u: nodes[u] });
              keep.push(nodes[targetObj]);
            }
          }
          return 0;
        });
      } catch (e) {
        threw = String(e).includes('contains a circular value');
        if (!threw) mismatch = 'unexpected error on sort: ' + String(e);
      }
      const expected = origItems.some((v) => v >= 0 && canReach(v, u));
      if (mismatch === '' && threw !== expected) {
        mismatch = 'seed ' + initialSeed + ' step ' + step + ' sort write-back expected=' + expected + ' threw=' + threw;
      }
      if (threw) {
        cyclesRejected++;
        if (mismatch === '' && nodes[u].length !== shadow[u].length) {
          mismatch = 'seed ' + initialSeed + ' step ' + step + ' sort partial write-back len=' + nodes[u].length;
        }
      } else {
        origItems.forEach((v, idx) => {
          shadow[u][idx] = v;
        });
        accepted++;
      }
    }

    if (mismatch === '' && step % 50 === 49) {
      JSON.stringify(nodes);
      jsonChecks++;
    }
  }
  if (mismatch === '') {
    JSON.stringify(nodes);
    jsonChecks++;
  }
}

return { mismatch, accepted, cyclesRejected, sortOps, partialSortOps, jsonChecks };`;

layer(HostedLive, { excludeTestServices: true })("Hosted MCP execute step budget", (it) => {
  it.effect(
    scenarios.mcpExecuteStepBudget.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const evidence = yield* Evidence;
          const runner = yield* connectHosted("execute-step-budget-runaway");
          const other = yield* connectHosted("execute-step-budget-other");

          // How long the ordinary program takes on this server when nothing else runs.
          const quiet: Array<number> = [];
          for (let round = 0; round < 3; round++) {
            const { ms, execution } = yield* execute(other, `ordinary-quiet-${round}`, ordinary);
            expect(execution).toMatchObject({ ok: true, value: ordinaryValue });
            quiet.push(ms);
          }

          // The runaway program runs while the other caller keeps sending ordinary programs.
          const running = yield* Effect.forkChild(execute(runner, "runaway", runaway));
          const finished = Effect.sync(() => running.pollUnsafe() !== undefined);
          const busy: Array<number> = [];
          while (!(yield* finished)) {
            const { ms, execution } = yield* execute(
              other,
              `ordinary-busy-${busy.length}`,
              ordinary,
            );
            expect(execution).toMatchObject({ ok: true, value: ordinaryValue });
            // Only rounds that ended while the runaway program still ran count as beside it.
            if (!(yield* finished)) busy.push(ms);
          }
          const stopped = yield* Fiber.join(running);

          // It fails as a timeout that names the budget, although its own catch tried to return.
          expect(stopped.execution).toMatchObject({
            ok: false,
            error: {
              kind: "TimeoutExceeded",
              message: expect.stringContaining(
                `Execution exceeded its compute budget of ${defaultMaxSteps} interpreter steps`,
              ),
            },
            toolCalls: [],
          });
          expect(stopped.execution.error?.message).toContain("move heavy computation");
          // Far inside the five-minute wall-time budget it would otherwise have run to.
          expect(stopped.ms).toBeLessThan(defaultTimeoutMs / 5);

          // Other callers kept being answered while it ran, and promptly.
          expect(busy.length).toBeGreaterThanOrEqual(3);
          const slowestQuiet = Math.max(...quiet);
          expect(Math.max(...busy)).toBeLessThan(Math.max(5_000, slowestQuiet * 20));

          // An ordinary program that calls tools between longer loops still completes.
          const fine = yield* execute(runner, "heavy-but-fine", heavyButFine);
          expect(fine.execution).toMatchObject({
            ok: true,
            value: { total: expect.any(Number), calls: 3 },
          });
          expect(fine.execution.toolCalls.map((call) => call.outcome)).toEqual([
            "success",
            "success",
            "success",
          ]);

          // A loop of large native calls stops at the same budget, in seconds.
          const native = yield* execute(runner, "native-runaway", nativeRunaway);
          expect(native.execution).toMatchObject({
            ok: false,
            error: {
              kind: "TimeoutExceeded",
              message: expect.stringContaining(
                `Execution exceeded its compute budget of ${defaultMaxSteps} interpreter steps`,
              ),
            },
          });
          expect(native.ms).toBeLessThan(20_000);

          // So does a loop of operators that coerce a whole array.
          const operator = yield* execute(runner, "operator-runaway", operatorRunaway);
          expect(operator.execution).toMatchObject({
            ok: false,
            error: {
              kind: "TimeoutExceeded",
              message: expect.stringContaining(
                `Execution exceeded its compute budget of ${defaultMaxSteps} interpreter steps`,
              ),
            },
          });
          expect(operator.ms).toBeLessThan(20_000);

          // Checking membership with `in` against a large index stays fast and inside it.
          const dedupe = yield* execute(runner, "dedupe-with-in", dedupeWithIn);
          expect(dedupe.execution).toMatchObject({ ok: true, value: 10000 });
          expect(dedupe.ms).toBeLessThan(20_000);

          // Grouping 50,000 rows into 10 or 50 groups completes.
          const grouped10 = yield* execute(runner, "group-by-10", groupBy(10));
          expect(grouped10.execution).toMatchObject({ ok: true, value: 10 });
          const grouped50 = yield* execute(runner, "group-by-50", groupBy(50));
          expect(grouped50.execution).toMatchObject({ ok: true, value: 50 });

          // Grouping into an object and attaching a shared value to every row complete promptly.
          const groupedObject = yield* execute(runner, "group-by-object", groupByObject);
          expect(groupedObject.execution).toMatchObject({ ok: true, value: 10 });
          expect(groupedObject.ms).toBeLessThan(20_000);
          const shared = yield* execute(runner, "shared-meta", sharedMeta);
          expect(shared.execution).toMatchObject({ ok: true, value: 20000 });
          expect(shared.ms).toBeLessThan(20_000);
          // Also when that value holds 1,000 records, each an object.
          const sharedRecords = yield* execute(runner, "shared-records-meta", sharedRecordsMeta);
          expect(sharedRecords.execution).toMatchObject({ ok: true, value: 20000 });
          expect(sharedRecords.ms).toBeLessThan(5_000);
          // Storing a row into the shared value it already walked is still a cycle.
          const cycle = yield* execute(runner, "shared-meta-cycle", sharedMetaCycle);
          expect(cycle.execution).toMatchObject({
            ok: true,
            value: expect.stringContaining("contains a circular value"),
          });

          // Grouping row objects by storing each group back into itself completes, in both forms.
          const groupedRows = yield* execute(runner, "group-rows-or-push", groupRowsOrPush);
          expect(groupedRows.execution).toMatchObject({ ok: true, value: 10 });
          expect(groupedRows.ms).toBeLessThan(20_000);
          const reducedRows = yield* execute(runner, "group-rows-reduce", groupRowsReduce);
          expect(reducedRows.execution).toMatchObject({ ok: true, value: 10 });
          expect(reducedRows.ms).toBeLessThan(20_000);

          // A loop that interpolates a megabyte string stops at the budget, in seconds.
          const template = yield* execute(runner, "template-runaway", templateRunaway);
          expect(template.execution).toMatchObject({
            ok: false,
            error: {
              kind: "TimeoutExceeded",
              message: expect.stringContaining(
                `Execution exceeded its compute budget of ${defaultMaxSteps} interpreter steps`,
              ),
            },
          });
          expect(template.ms).toBeLessThan(20_000);

          // A loop that joins a megabyte string stops at the budget, in seconds.
          const concat = yield* execute(runner, "concat-runaway", concatRunaway);
          expect(concat.execution).toMatchObject({
            ok: false,
            error: {
              kind: "TimeoutExceeded",
              message: expect.stringContaining(
                `Execution exceeded its compute budget of ${defaultMaxSteps} interpreter steps`,
              ),
            },
          });
          expect(concat.ms).toBeLessThan(20_000);

          // Transforming 10,000 records with native calls stays well inside it.
          const records = yield* execute(runner, "records-transform", recordsTransform);
          expect(records.execution).toMatchObject({ ok: true, value: { kept: 5000, json: true } });

          yield* evidence.measure("runaway-ms", stopped.ms);
          yield* evidence.measure("ordinary-quiet-max-ms", slowestQuiet);
          yield* evidence.measure("ordinary-busy-max-ms", Math.max(...busy));
          yield* evidence.json("summary.json", {
            stepsPerSecond: Math.round(defaultMaxSteps / (stopped.ms / 1000)),
            busyRounds: busy.length,
            quiet,
            busy,
          });
          yield* evidence.measure("heavy-but-fine-ms", fine.ms);
          yield* evidence.measure("native-runaway-ms", native.ms);
          yield* evidence.measure("records-transform-ms", records.ms);
          yield* evidence.measure("operator-runaway-ms", operator.ms);
          yield* evidence.measure("dedupe-with-in-ms", dedupe.ms);
          yield* evidence.measure("group-by-10-ms", grouped10.ms);
          yield* evidence.measure("group-by-50-ms", grouped50.ms);
          yield* evidence.measure("group-by-object-ms", groupedObject.ms);
          yield* evidence.measure("shared-meta-ms", shared.ms);
          yield* evidence.measure("shared-records-meta-ms", sharedRecords.ms);
          yield* evidence.measure("concat-runaway-ms", concat.ms);
          yield* evidence.measure("group-rows-or-push-ms", groupedRows.ms);
          yield* evidence.measure("group-rows-reduce-ms", reducedRows.ms);
          yield* evidence.measure("template-runaway-ms", template.ms);
        }).pipe(Effect.provide(McpClient.layer)),
      ),
    { timeout: 180_000 },
  );

  it.effect(
    scenarios.mcpExecuteWalkCache.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors,
            evidence = yield* Evidence;
          const barrier = yield* startWalkBarrier();
          const barrierApp = yield* body(
            App,
            yield* api.request(
              actors.owner,
              "POST",
              `/api/organizations/${actors.organization.id}/apps/deploy`,
              {
                name: `Walk barrier ${randomUUID().slice(0, 8)}`,
                files: [
                  { path: "index.ts", content: barrierAppSource(barrier.origin) },
                  appsManifest,
                ],
              },
            ),
          );
          const victimClient = yield* connectHosted("execute-walk-cache-victim");
          const noiseClient = yield* connectHosted("execute-walk-cache-noise");

          // M2: quiet control establishes that the 1,000-record shared-meta victim fits easily.
          const quiet = yield* execute(
            victimClient,
            "shared-meta-quiet-control",
            sharedMetaUnderNoiseVictim(),
          );
          expect(quiet.execution).toMatchObject({ ok: true, value: 20_000 });

          // Run the same victim concurrently alongside a bounded noisy fiber coordinated through
          // the server-side barrier app: the victim warms `meta` and holds at `/victim-warm` until
          // a concurrent noisy execution runs nested-store mutations and hits `/noise-hit`.
          const maxNoisyBursts = 20;
          let stopNoisy = false;
          let noisyBursts = 0;

          const victimFiber = yield* Effect.forkChild(
            execute(
              victimClient,
              "shared-meta-under-noise",
              sharedMetaUnderNoiseVictim(barrierApp.slug),
            ),
          );

          const noiseProgram = walkEpochNoise(barrierApp.slug);
          let noisyFiber: Fiber.Fiber<void, unknown> | undefined;

          const underNoise = yield* Effect.gen(function* () {
            yield* Effect.raceFirst(
              Deferred.await(barrier.victimWarmed),
              Fiber.await(victimFiber).pipe(Effect.asVoid),
            );
            noisyFiber = yield* Effect.forkChild(
              Effect.gen(function* () {
                while (!stopNoisy && noisyBursts < maxNoisyBursts) {
                  const burstIndex = noisyBursts;
                  const burst = yield* execute(
                    noiseClient,
                    `walk-epoch-noise-${burstIndex}`,
                    noiseProgram,
                  );
                  expect(burst.execution).toMatchObject({ ok: true, value: 4000 });
                  noisyBursts += 1;
                }
              }),
            );
            const result = yield* Fiber.join(victimFiber);
            stopNoisy = true;
            yield* Fiber.join(noisyFiber);
            return result;
          }).pipe(
            Effect.ensuring(
              Effect.suspend(() => {
                stopNoisy = true;
                return Effect.all(
                  [
                    Fiber.interrupt(victimFiber),
                    ...(noisyFiber === undefined ? [] : [Fiber.interrupt(noisyFiber)]),
                  ],
                  { concurrency: "unbounded" },
                );
              }),
            ),
          );

          const barrierState = barrier.snapshot();

          // M3: comparator Array.prototype.sort write-back validation and controls.
          const direct = yield* execute(victimClient, "sort-direct-cycle", sortDirectCycle);
          const leaf = yield* execute(victimClient, "sort-leaf-cache-cycle", sortLeafCacheCycle);
          const ancestor = yield* execute(
            victimClient,
            "sort-ancestor-cache-cycle",
            sortAncestorCacheCycle,
          );
          const sparse = yield* execute(victimClient, "sort-sparse-control", sortSparseControl);
          const largeSort = yield* execute(
            victimClient,
            "sort-large-objects-control",
            sortLargeObjectsControl,
          );

          // N4: deterministic seeded differential graph-mutation fuzz against BFS oracle.
          const fuzz = yield* execute(victimClient, "walk-cache-seeded-fuzz", walkCacheSeededFuzz);

          yield* evidence.measure("shared-meta-quiet-ms", quiet.ms);
          yield* evidence.measure("shared-meta-under-noise-ms", underNoise.ms);
          yield* evidence.measure("sort-large-objects-ms", largeSort.ms);
          yield* evidence.measure("walk-cache-fuzz-ms", fuzz.ms);
          yield* evidence.json("walk-cache-summary.json", {
            quietMs: quiet.ms,
            underNoiseMs: underNoise.ms,
            underNoiseOk: underNoise.execution.ok,
            underNoiseError: underNoise.execution.error,
            noisyBursts,
            barrier: barrierState,
            direct: direct.execution,
            leaf: leaf.execution,
            ancestor: ancestor.execution,
            sparse: sparse.execution,
            largeSortMs: largeSort.ms,
            largeSort: largeSort.execution,
            fuzz: fuzz.execution,
          });

          const firstNoiseIndex = barrierState.events.indexOf("noise-hit");
          const victimDoneIndex = barrierState.events.lastIndexOf("victim-done");
          expect(barrierState.events[0]).toBe("victim-warm");
          expect(firstNoiseIndex).toBeGreaterThan(0);
          expect(victimDoneIndex).toBeGreaterThan(firstNoiseIndex);
          expect(barrierState.noiseHitsWhileVictimHeld).toBeGreaterThanOrEqual(1);
          expect(barrierState.noiseHitsBeforeVictimDone).toBeGreaterThanOrEqual(1);
          expect(noisyBursts).toBeGreaterThanOrEqual(1);
          expect(underNoise.execution).toMatchObject({ ok: true, value: 20_000 });

          expect(direct.execution).toMatchObject({
            ok: true,
            value: {
              err: expect.stringContaining("contains a circular value"),
              len: 0,
            },
          });

          expect(leaf.execution).toMatchObject({
            ok: true,
            value: expect.stringContaining("contains a circular value"),
          });

          expect(ancestor.execution).toMatchObject({
            ok: true,
            value: expect.stringContaining("contains a circular value"),
          });

          expect(sparse.execution).toMatchObject({
            ok: true,
            value: "4,1,2,true,true,false",
          });

          expect(largeSort.execution).toMatchObject({ ok: true, value: 5000 });

          expect(fuzz.execution.ok).toBe(true);
          const fuzzValue = yield* Schema.decodeUnknownEffect(WalkCacheFuzzResult)(
            fuzz.execution.value,
          );
          expect(fuzzValue.mismatch).toBe("");
          expect(fuzzValue.accepted).toBeGreaterThan(0);
          expect(fuzzValue.cyclesRejected).toBeGreaterThan(0);
          expect(fuzzValue.sortOps).toBeGreaterThan(0);
          expect(fuzzValue.partialSortOps).toBeGreaterThan(0);
          expect(fuzzValue.jsonChecks).toBeGreaterThan(0);
        }).pipe(Effect.provide(McpClient.layer)),
      ),
    { timeout: 180_000 },
  );
});
