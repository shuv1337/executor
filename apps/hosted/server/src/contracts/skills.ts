import { withLegacyKeys } from "@executor-js/utils/legacy-keys";
import { RequiredAction } from "./authorization.ts";
import { ConnectionAccountUnlinked } from "./app-accounts.ts";
/** Organization-scoped skill reads expose only the skill directory, never general app source. */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import {
  AppId,
  SkillSelection,
  AppSkillName,
  AppSkillCatalog,
  AppSkillBundle,
  AppSkillDocument,
  AppSkillErrors,
  AppSkillNotFound,
  SourceFilePath,
} from "@executor-js/sdk/core";
import { OrganizationReference, RequireOrganization } from "./organization.ts";

const errors = [...AppSkillErrors, ConnectionAccountUnlinked] as const;
const app = { organization: OrganizationReference, app: AppId };
const version = { version: SkillSelection.version, revision: SkillSelection.revision };
const prefix = "/api/organizations/:organization/apps/:app/skills";
/** App and account permissions authorize dynamic skill discovery. */
export const HostedSkills = HttpApiGroup.make("skills")
  .add(
    HttpApiEndpoint.get("bundle", "/api/organizations/:organization/apps/:app/skill-bundle", {
      params: app,
      query: Schema.Struct(version).pipe(withLegacyKeys({ version: "deployment" })),
      success: AppSkillBundle,
      error: errors,
    }).annotate(RequiredAction, "discover"),
  )
  .add(
    HttpApiEndpoint.get("list", prefix, {
      params: app,
      query: Schema.Struct(version).pipe(withLegacyKeys({ version: "deployment" })),
      success: AppSkillCatalog,
      error: errors,
    }).annotate(RequiredAction, "discover"),
  )
  .add(
    HttpApiEndpoint.get("read", `${prefix}/:name`, {
      params: { ...app, name: AppSkillName },
      query: Schema.Struct({ ...version, file: Schema.optional(SourceFilePath) }).pipe(
        withLegacyKeys({ version: "deployment" }),
      ),
      success: AppSkillDocument,
      error: [...errors, AppSkillNotFound],
    }).annotate(RequiredAction, "discover"),
  )
  .middleware(RequireOrganization);
