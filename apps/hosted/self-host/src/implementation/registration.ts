/** Atomic setup and invitation redemption over Better Auth's transaction adapter. */
import { getCurrentAdapter, runWithTransaction } from "@better-auth/core/context";
import type {
  BetterAuthOptions,
  BetterAuthPlugin,
  GenericEndpointContext,
} from "@better-auth/core";
import { APIError, createAuthEndpoint, isAPIError } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { SsoRefusal } from "@executor-js/hosted-self-host-web/sso";
import { Cause, Effect, Exit, Schema } from "effect";
import { z } from "zod";
import type { selfHostAuthSettings } from "./auth-options.ts";
import { rootModel, rootRecordId } from "./root-organization.ts";

const Organization = Schema.Struct({ id: Schema.String });
const Invitation = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  organizationId: Schema.String,
  role: Schema.Literals(["admin", "member"]),
  status: Schema.String,
  expiresAt: Schema.Date,
});
const credentials = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.email(),
  password: z.string().min(8).max(128),
});
const call = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      isAPIError(cause)
        ? cause
        : new APIError("SERVICE_UNAVAILABLE", {
            message: "Authentication is unavailable. Try again.",
          }),
  });
const run = <A>(effect: Effect.Effect<A, APIError>) =>
  Effect.runPromiseExit(effect).then(
    Exit.match({
      onSuccess: (value) => value,
      onFailure: (cause) => {
        throw Cause.squash(cause);
      },
    }),
  );
const decode = <S extends Schema.Top>(schema: S, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(
      () => new APIError("FORBIDDEN", { message: "This account cannot join the instance." }),
    ),
  );
const deny = (message: string) => Effect.fail(new APIError("FORBIDDEN", { message }));
/** Better Auth returns a coded refusal of its callback to the login page, which explains it. */
const refuseSso = (code: (typeof SsoRefusal)[keyof typeof SsoRefusal], message: string) =>
  Effect.fail(new APIError("FORBIDDEN", { code, message }));
const adapterFor = (ctx: GenericEndpointContext) =>
  call(() => getCurrentAdapter(ctx.context.adapter));
const isSsoCallback = (ctx: GenericEndpointContext) =>
  ctx.path === "/callback/:id" && ctx.params?.id === "sso";
const notMember = "Your account is not a member of this instance.";

/**
 * Invitations are the only way in after setup. SSO signs in people who already belong to an
 * organization; it never creates an account or a membership.
 */
export const selfHostUserHooks = (settings: Effect.Success<typeof selfHostAuthSettings>) =>
  ({
    user: {
      create: {
        before: (user, ctx) =>
          run(
            Effect.gen(function* () {
              if (ctx?.path === "/self-host/setup" || ctx?.path === "/self-host/register") return;
              if (!ctx || !isSsoCallback(ctx) || settings.sso === null)
                return yield* deny("Create the first account through setup, or use an invitation.");
              // A provider problem is explained before the missing membership is.
              if (!user.emailVerified)
                return yield* refuseSso(
                  SsoRefusal.emailUnverified,
                  "The identity provider did not verify this email address.",
                );
              const domain = user.email.toLowerCase().split("@")[1];
              if (!domain || !settings.sso.allowedDomains.includes(domain))
                return yield* refuseSso(
                  SsoRefusal.domainNotAllowed,
                  "Use an account from an approved SSO domain.",
                );
              const adapter = yield* adapterFor(ctx);
              if ((yield* call(() => adapter.count({ model: "organization" }))) === 0)
                return yield* refuseSso(
                  SsoRefusal.instanceNotReady,
                  "This instance is not set up yet.",
                );
              return yield* refuseSso(SsoRefusal.notMember, notMember);
            }),
          ),
      },
    },
    session: {
      create: {
        before: (session, ctx) =>
          run(
            Effect.gen(function* () {
              if (!ctx) return yield* deny("A sign-in request is required.");
              const adapter = yield* adapterFor(ctx);
              const member = yield* call(() =>
                adapter.findOne({
                  model: "member",
                  where: [{ field: "userId", value: session.userId }],
                  select: ["id"],
                }),
              );
              if (member === null)
                return yield* isSsoCallback(ctx)
                  ? refuseSso(SsoRefusal.notMember, notMember)
                  : deny(notMember);
            }),
          ),
      },
    },
  }) satisfies NonNullable<BetterAuthOptions["databaseHooks"]>;

const register = (
  ctx: GenericEndpointContext,
  input: z.infer<typeof credentials>,
  admission: { readonly organizationName: string } | { readonly invitation: string },
) =>
  run(
    call(
      async () =>
        await runWithTransaction(ctx.context.adapter, () =>
          run(
            Effect.gen(function* () {
              // PGlite reserves its only connection for this whole transaction. Concurrent
              // first-run requests therefore cannot both observe an empty user table.
              const adapter = yield* adapterFor(ctx);
              const email = input.email.toLowerCase();
              let organizationId: string;
              let role: "owner" | "admin" | "member";
              if ("organizationName" in admission) {
                const users = yield* call(() => adapter.count({ model: "user" }));
                const organizations = yield* call(() => adapter.count({ model: "organization" }));
                if (users !== 0 || organizations !== 0)
                  return yield* deny(
                    "Setup is already complete. Sign in or ask an administrator for an invitation.",
                  );
                const org = yield* call(() =>
                  adapter.create({
                    model: "organization",
                    data: {
                      name: admission.organizationName,
                      slug: "executor",
                      createdAt: new Date(),
                    },
                  }),
                ).pipe(Effect.flatMap((value) => decode(Organization, value)));
                yield* call(() =>
                  adapter.create({
                    model: rootModel,
                    data: { id: rootRecordId, organizationId: org.id, createdAt: new Date() },
                    forceAllowId: true,
                  }),
                );
                organizationId = org.id;
                role = "owner";
              } else {
                const invitation = yield* call(() =>
                  adapter.findOne({
                    model: "invitation",
                    where: [{ field: "id", value: admission.invitation }],
                  }),
                ).pipe(Effect.flatMap((value) => decode(Invitation, value)));
                if (
                  invitation.status !== "pending" ||
                  invitation.expiresAt.getTime() <= Date.now() ||
                  invitation.email.toLowerCase() !== email
                )
                  return yield* deny(
                    "This invitation is invalid, expired, or for a different email.",
                  );
                organizationId = invitation.organizationId;
                role = invitation.role;
                yield* call(() =>
                  adapter.update({
                    model: "invitation",
                    where: [{ field: "id", value: invitation.id }],
                    update: { status: "accepted" },
                  }),
                );
              }
              const existing = yield* call(() =>
                ctx.context.internalAdapter.findUserByEmail(email, { includeAccounts: true }),
              );
              const user = yield* Effect.gen(function* () {
                if (existing) {
                  // A new invitation can readmit a removed member, but cannot replace their password.
                  const account = existing.accounts.find(
                    (account) => account.providerId === "credential",
                  );
                  const passwordHash = account?.password;
                  if (
                    !passwordHash ||
                    !(yield* call(() =>
                      ctx.context.password.verify({ hash: passwordHash, password: input.password }),
                    ))
                  )
                    return yield* deny("Use your existing password to accept this invitation.");
                  return existing.user;
                }
                const hash = yield* call(() => ctx.context.password.hash(input.password));
                const created = yield* call(() =>
                  ctx.context.internalAdapter.createUser(
                    { name: input.name, email, emailVerified: false },
                    { method: "email-password" },
                  ),
                );
                yield* call(() =>
                  ctx.context.internalAdapter.linkAccount({
                    userId: created.id,
                    accountId: created.id,
                    providerId: "credential",
                    password: hash,
                  }),
                );
                return created;
              });
              yield* call(() =>
                adapter.create({
                  model: "member",
                  data: { organizationId, userId: user.id, role, createdAt: new Date() },
                }),
              );
              const session = yield* call(() => ctx.context.internalAdapter.createSession(user.id));
              if (!session) return yield* Effect.fail(new APIError("INTERNAL_SERVER_ERROR"));
              return { user, session };
            }),
          ),
        ),
    ).pipe(
      Effect.flatMap((result) =>
        call(async () => {
          await setSessionCookie(ctx, result);
          return ctx.json({ status: true });
        }),
      ),
    ),
  );

/** Public capability discovery contains no users, emails, or SSO credentials. */
export const selfHostRegistration = (settings: Effect.Success<typeof selfHostAuthSettings>) =>
  ({
    id: "executor-self-host-registration",
    endpoints: {
      selfHostConfiguration: createAuthEndpoint("/self-host/config", { method: "GET" }, (ctx) =>
        run(
          Effect.gen(function* () {
            const adapter = yield* adapterFor(ctx);
            const users = yield* call(() => adapter.count({ model: "user" }));
            const organizations = yield* call(() => adapter.count({ model: "organization" }));
            return ctx.json({
              setup: users === 0 && organizations === 0,
              sso: settings.sso !== null,
            });
          }),
        ),
      ),
      setupSelfHost: createAuthEndpoint(
        "/self-host/setup",
        {
          method: "POST",
          body: credentials.extend({ organizationName: z.string().trim().min(1).max(100) }),
        },
        (ctx) => register(ctx, ctx.body, { organizationName: ctx.body.organizationName }),
      ),
      registerSelfHost: createAuthEndpoint(
        "/self-host/register",
        { method: "POST", body: credentials.extend({ invitation: z.string().min(1) }) },
        (ctx) => register(ctx, ctx.body, { invitation: ctx.body.invitation }),
      ),
    },
  }) satisfies BetterAuthPlugin;
