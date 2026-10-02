/** ChatGPT verifies the Cloud domain by reading a fixed token from one exact path. */
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { HttpClient } from "effect/unstable/http";
import { scenarios } from "../test-plan.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";

layer(TestLive, { excludeTestServices: true })("OpenAI apps challenge", (it) => {
  it.effect(scenarios.openAiAppsChallenge.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient;
        const origin = (yield* Target).metadata.origin;
        const read = (path: string) =>
          http.get(`${origin}${path}`).pipe(
            Effect.flatMap((response) =>
              Effect.map(response.text, (text) => ({
                status: response.status,
                contentType: response.headers["content-type"],
                cacheControl: response.headers["cache-control"],
                text,
              })),
            ),
          );
        const challenge = yield* read("/.well-known/openai-apps-challenge");
        expect(challenge.status).toBe(200);
        expect(challenge.contentType).toBe("text/plain; charset=utf-8");
        expect(challenge.cacheControl).toBe("public, max-age=300");
        expect(challenge.text).toBe("P_fW7WgF8HkXXQkP85B7aDZD_RuZv8YmQA2Zq9JoIfc");
        const extra = yield* read("/.well-known/openai-apps-challenge/extra");
        expect(extra.status).toBe(404);
        expect(extra.text).not.toContain("P_fW7WgF8HkXXQkP85B7aDZD_RuZv8YmQA2Zq9JoIfc");
      }),
    ),
  );
});
