/** Registry diagnostics shared by the build errors and the provisioning log. */
import { Schema } from "effect";

const NpmPackageName = Schema.String.check(
  Schema.isMaxLength(214),
  Schema.isPattern(/^(?:[a-z0-9][a-z0-9._-]*|@[a-z0-9][a-z0-9._-]*\/[a-z0-9_-][a-z0-9._-]*)$/u),
  Schema.makeFilter((name) => name !== "node_modules" && name !== "favicon.ico"),
);
const ExactSemver = Schema.String.check(
  Schema.isMaxLength(200),
  Schema.isPattern(
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/u,
  ),
);
const HttpStatus = Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 }));

export const safeNpmPackageName = (value: unknown) =>
  Schema.is(NpmPackageName)(value) ? value : undefined;
export const safeExactSemver = (value: unknown) =>
  Schema.is(ExactSemver)(value) ? value : undefined;
export const safeHttpStatus = (value: unknown) =>
  Schema.is(HttpStatus)(value) ? value : undefined;
export const safeRegistryOrigin = (value: unknown) => {
  const url = typeof value === "string" ? URL.parse(value) : null;
  return url?.protocol === "http:" || url?.protocol === "https:" ? url.origin : undefined;
};

const RegistryOrigin = Schema.String.check(
  Schema.makeFilter((value) => safeRegistryOrigin(value) === value),
);

export const RegistryBuildFailureFields = {
  package: Schema.optionalKey(NpmPackageName),
  version: Schema.optionalKey(ExactSemver),
  registry: Schema.optionalKey(RegistryOrigin),
  status: Schema.optionalKey(HttpStatus),
};

/** Project the usable fields and leave unavailable keys absent on the wire. */
export const safeRegistryBuildFailure = (
  failure: Partial<Record<keyof typeof RegistryBuildFailureFields, unknown>> | undefined,
) => {
  const packageName = safeNpmPackageName(failure?.package);
  const version = safeExactSemver(failure?.version);
  const registry = safeRegistryOrigin(failure?.registry);
  const status = safeHttpStatus(failure?.status);
  return {
    ...(packageName === undefined ? {} : { package: packageName }),
    ...(version === undefined ? {} : { version }),
    ...(registry === undefined ? {} : { registry }),
    ...(status === undefined ? {} : { status }),
  };
};
