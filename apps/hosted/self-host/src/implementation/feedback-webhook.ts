/** Explicit feedback delivery to an operator-owned receiver, independent of usage analytics. */
import { CurrentUsage, ProductAnalytics } from "@executor-js/hosted-server";
import { FeedbackUnavailable } from "@executor-js/telemetry/product-analytics";
import { Config, DateTime, Effect, Option, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { SqlClient } from "effect/sql";

const Person = Schema.Struct({ email: Schema.String });

/** An unset URL leaves the existing analytics sink (including its opt-out) untouched. */
export const selfHostFeedbackWebhook = (origin: string) =>
  Effect.gen(function* () {
    const configured = yield* Config.Redacted("EXECUTOR_FEEDBACK_WEBHOOK_URL").pipe(Config.option);
    if (Option.isNone(configured) || Redacted.value(configured.value).trim() === "")
      return undefined;
    const destination = URL.parse(Redacted.value(configured.value));
    if (
      destination === null ||
      !["https:", "http:"].includes(destination.protocol) ||
      destination.username !== "" ||
      destination.password !== ""
    ) {
      yield* Effect.logWarning(
        "EXECUTOR_FEEDBACK_WEBHOOK_URL must be an HTTP(S) URL without embedded credentials",
      );
      return () => Effect.fail(new FeedbackUnavailable());
    }
    const secret = yield* Config.Redacted("EXECUTOR_FEEDBACK_WEBHOOK_SECRET").pipe(Config.option);
    const sql = yield* SqlClient.SqlClient;

    const submit: typeof ProductAnalytics.Service.submitFeedback = (feedback) =>
      Effect.gen(function* () {
        const caller = yield* CurrentUsage;
        const rows = yield* sql`select email from "user" where id = ${feedback.userId}`;
        const person = Schema.decodeUnknownOption(Person)(rows[0]);
        const user = {
          id: feedback.userId,
          ...(Option.isSome(person) ? { email: person.value.email } : {}),
        };
        const submittedAt = DateTime.formatIso(yield* DateTime.now);
        const who = [user.email ?? user.id, caller.client_name].filter(Boolean).join(" / ");
        const payload = {
          message: feedback.message,
          submittedAt,
          organization: { id: feedback.organizationId },
          user,
          caller,
          instanceOrigin: origin,
          // Common notification receivers can consume these without a translation service.
          title: "Executor feedback",
          body: `${feedback.message.slice(0, 1500)}\nFrom: ${who.slice(0, 300)}`,
        };
        const request = HttpClientRequest.post(destination.href).pipe(
          HttpClientRequest.bodyJsonUnsafe(payload),
          HttpClientRequest.setHeader("Idempotency-Key", crypto.randomUUID()),
        );
        const response = yield* HttpClient.execute(
          Option.isSome(secret) && Redacted.value(secret.value) !== ""
            ? HttpClientRequest.bearerToken(request, secret.value)
            : request,
        );
        if (response.status < 200 || response.status >= 300)
          return yield* new FeedbackUnavailable();
      }).pipe(
        Effect.timeout("10 seconds"),
        Effect.tapError(() => Effect.logWarning("Feedback webhook delivery failed")),
        Effect.mapError(() => new FeedbackUnavailable()),
        // Do not trace the URL, authorization or response: all may contain receiver secrets.
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.provide(FetchHttpClient.layer),
      );
    return submit;
  });
