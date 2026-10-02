/**
 * A new Cloud team's Executor app is installed by the write request that dispatched its setup,
 * right after the team's durable workflow exists. The workflow runs the same job as well: it
 * waits for a fresh claim, finishes an attempt the request could not, and finds a finished job
 * done. Locally the workflow starts at once and often claims first, so both attempts then run
 * together; whatever the order, the team ends with one Executor app and one default profile per
 * manager.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Inventory } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { managementApp } from "../support/management-app.ts";

const Directory = Schema.Struct({ pendingApp: Schema.Boolean });

/** Every delivered attempt at the organization's team job, by runner. */
const teamAttempts = (organization: string) =>
  Effect.gen(function* () {
    const telemetry = yield* Telemetry;
    const claimed = yield* telemetry.search("hosted.provision", {
      "executor.organization.id": organization,
      "executor.provisioning.kind": "team",
    });
    const job = claimed.data[0]?.span.tags["executor.provisioning.job"];
    if (job === undefined) return yield* Effect.fail(new Error("No team attempt has arrived"));
    const attempts = (yield* telemetry.search("hosted.provision", {
      "executor.provisioning.job": job,
    })).data.map(({ traceId, span }) => ({
      traceId,
      runner: span.tags["executor.provisioning.runner"],
      claimed: span.tags["executor.provisioning.claimed"],
      status: span.status,
    }));
    const request = attempts.filter((attempt) => attempt.runner === "request");
    const background = attempts.filter((attempt) => attempt.runner === "background");
    if (request.length === 0 || background.length === 0)
      return yield* Effect.fail(new Error("Both team attempts have not arrived"));
    return { job, request, background };
  }).pipe(Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 60 }));

layer(HostedLive, { excludeTestServices: true })("Team installation", (it) => {
  it.effect(scenarios.teamInstallationFromRequest.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence;
        const organization = actors.organization.id;
        // Fixture setup ends with ordinary write requests; nothing else starts the installation.
        const { app } = yield* managementApp(actors.owner);
        const directory = yield* body(
          Directory,
          yield* api.request(actors.owner, "GET", `/api/organizations/${organization}/resources`),
        );
        expect(directory.pendingApp).toBe(false);
        const attempts = yield* teamAttempts(organization);
        yield* evidence.json("team-attempts.json", attempts);
        // The request ran the job itself and completed it, rather than waiting for the workflow.
        expect(attempts.request).toEqual([
          expect.objectContaining({ claimed: "true", status: "ok" }),
        ]);
        // The workflow, the durable path, exists for the same job and ran too.
        expect(attempts.background.length).toBeGreaterThan(0);
        expect(attempts.background.every((attempt) => attempt.status === "ok")).toBe(true);
        expect(app.name).toBe("Executor");
      }),
    ),
  );

  it.effect(scenarios.teamInstallationConcurrent.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence;
        const organization = actors.organization.id;
        const { app } = yield* managementApp(actors.owner);
        const attempts = yield* teamAttempts(organization);
        yield* evidence.json("team-attempts.json", attempts);
        const all = [...attempts.request, ...attempts.background];
        // A claim fails once the job has succeeded, so two completed claims ran together. A
        // workflow that finds the request's claim waits for it and then finds the job done.
        const completed = all.filter(
          (attempt) => attempt.claimed === "true" && attempt.status === "ok",
        ).length;
        yield* evidence.json("team-attempts-overlapped.json", { overlapped: completed >= 2 });
        expect(all.every((attempt) => attempt.status === "ok")).toBe(true);
        expect(completed).toBeGreaterThanOrEqual(1);
        const inventory = yield* body(
          Inventory,
          yield* api.request(actors.owner, "GET", `/api/organizations/${organization}/inventory`),
        );
        expect(inventory.apps.filter((item) => item.name === "Executor")).toEqual([
          expect.objectContaining({ id: app.id }),
        ]);
        // Each manager gets exactly one default profile on that app.
        for (const manager of [actors.owner, actors.admin])
          expect((yield* managementApp(manager)).app.id).toBe(app.id);
      }),
    ),
  );
});
