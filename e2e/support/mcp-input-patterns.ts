import { Effect, Schema } from "effect";

const ListedTools = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    inputSchema: Schema.Struct({ properties: Schema.Record(Schema.String, Schema.Unknown) }),
  }),
);
const PatternedString = Schema.Struct({ pattern: Schema.optional(Schema.String) });
const Property = Schema.Struct({
  pattern: Schema.optional(Schema.String),
  anyOf: Schema.optional(Schema.Array(PatternedString)),
});

export const wholeStringInputPattern = (tools: unknown, tool: string, property: string) =>
  Effect.gen(function* () {
    const listed = yield* Schema.decodeUnknownEffect(ListedTools)(tools);
    const advertised = listed.find((entry) => entry.name === tool)?.inputSchema.properties[
      property
    ];
    if (advertised === undefined)
      return yield* Effect.die(`MCP tool ${tool} does not advertise ${property}`);
    const { pattern, anyOf = [] } = yield* Schema.decodeUnknownEffect(Property)(advertised);
    const patterns = [pattern, ...anyOf.map((branch) => branch.pattern)].filter(
      (source) => source !== undefined,
    );
    return new RegExp(`^(?:${patterns.map((source) => `(?:${source})`).join("|")})$`, "u");
  });

/**
 * Syntax the hosted Apps connector does not keep. A non-capturing group or a `\s` / `\S` class
 * is reduced to the literal prefix (`^apr_` for an approval id) and then matched against the
 * whole string, so `apr_<uuid>` fails before Executor sees it.
 */
const connectorUnsupported = /\(\?:|\\[sSdDwW]/u;

/** Literals up to the first metacharacter, using only the first alternative of a `(?:…)` group. */
const literalPrefix = (pattern: string) => {
  let index = 0;
  const read = (): string => {
    let chunk = "";
    while (index < pattern.length) {
      if (pattern.startsWith("(?:", index)) {
        index += 3;
        const first = read();
        let depth = 1;
        while (index < pattern.length && depth > 0) {
          const char = pattern[index];
          if (char === "(") depth += 1;
          else if (char === ")") depth -= 1;
          index += 1;
        }
        chunk += first;
        continue;
      }
      const char = pattern[index];
      if (char === undefined) break;
      if (char === "^" && chunk.length === 0) {
        chunk += char;
        index += 1;
        continue;
      }
      if ("\\.+*?{[(|)$".includes(char)) break;
      chunk += char;
      index += 1;
    }
    return chunk;
  };
  return read();
};

/**
 * Whether `value` survives the hosted connector's reading of one advertised pattern: the pattern
 * itself when it stays in the interoperable subset, otherwise its literal prefix, always against
 * the whole string.
 */
export const hostedConnectorMatches = (pattern: string, value: string) => {
  const source = connectorUnsupported.test(pattern) ? literalPrefix(pattern) : pattern;
  return new RegExp(`^(?:${source})$`, "u").test(value);
};

/** Patterns `resume.requestId` advertises, including each `anyOf` branch. */
export const advertisedInputPatterns = (tools: unknown, tool: string, property: string) =>
  Effect.gen(function* () {
    const listed = yield* Schema.decodeUnknownEffect(ListedTools)(tools);
    const advertised = listed.find((entry) => entry.name === tool)?.inputSchema.properties[
      property
    ];
    if (advertised === undefined)
      return yield* Effect.die(`MCP tool ${tool} does not advertise ${property}`);
    const { pattern, anyOf = [] } = yield* Schema.decodeUnknownEffect(Property)(advertised);
    return [pattern, ...anyOf.map((branch) => branch.pattern)].filter(
      (source) => source !== undefined,
    );
  });
