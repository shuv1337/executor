/** Address construction and parsing share one configured suffix and format; forwarding headers never select an app. */
import { AppSlug, HttpUrl, type App } from "@executor-js/sdk/core";
import { UiFailed } from "apps/ui/contracts";
import { Effect, Option, Schema } from "effect";
import {
  AppUiAddressInvalid,
  AppUiHostnameLabel,
  type AppUiBaseUrl,
  type AppUiHostFormat,
} from "../contracts/app-ui.ts";
import { OrganizationSlug } from "../contracts/organization.ts";

const flatSeparator = "--";

export interface AppAddressOptions {
  /** `nested` (default) serves `<app>.<org>.<base>`; `flat` serves `<app>--<org>.<base>`. */
  readonly format?: AppUiHostFormat;
  /**
   * One organization whose apps live directly under the base (`<app>.<base>`). A single-tenant
   * self-host drops the organization from every address this way; other organizations keep the
   * format's shape. Every app still has exactly one address: the bare form is used whenever it
   * parses back unambiguously, and the full form otherwise.
   */
  readonly defaultOrganization?: OrganizationSlug | undefined;
}

/** Hosted app addresses resolve current names before authorizing immutable identities. */
export const appAddresses = (
  dashboardOrigin: string,
  baseUrl: AppUiBaseUrl | undefined,
  options: AppAddressOptions = {},
) => {
  const format = options.format ?? "nested";
  const defaultOrganization = options.defaultOrganization;
  const base = baseUrl === undefined ? undefined : new URL(baseUrl);
  const dashboardHost = new URL(dashboardOrigin).host;
  /** Whether an app in the default organization is addressed as `<app>.<base>`. */
  const bare = (app: string, slug: string) =>
    slug === defaultOrganization && (format === "nested" || !app.includes(flatSeparator));
  const labelsFor = (app: string, slug: string): ReadonlyArray<string> =>
    bare(app, slug) ? [app] : format === "flat" ? [`${app}${flatSeparator}${slug}`] : [app, slug];
  const origin = (app: Pick<App, "slug">, slug: OrganizationSlug) =>
    Effect.gen(function* () {
      if (base === undefined) return yield* new UiFailed({ reason: "unavailable" });
      const candidates = labelsFor(app.slug, slug);
      const labels = yield* Schema.decodeUnknownEffect(Schema.Array(AppUiHostnameLabel))(
        candidates,
      ).pipe(
        Effect.mapError(
          () =>
            new AppUiAddressInvalid({
              reason: candidates.some((label) => label.length > 63) ? "too_long" : "invalid_slug",
            }),
        ),
      );
      const url = new URL(base);
      const hostname = `${labels.join(".")}.${base.hostname}`;
      url.hostname = hostname;
      if (url.hostname !== hostname)
        return yield* new AppUiAddressInvalid({ reason: "invalid_slug" });
      if (url.hostname.length > 253) return yield* new AppUiAddressInvalid({ reason: "too_long" });
      return HttpUrl.make(url.origin);
    });
  /** The app and organization names under the base, or none unless the host is that app's one address. */
  const names = (labels: ReadonlyArray<string>): Option.Option<readonly [string, string]> => {
    const canonical = ([app, slug]: readonly [string, string]) =>
      labelsFor(app, slug).join(".") === labels.join(".")
        ? Option.some([app, slug] as const)
        : Option.none();
    if (labels.length === 2 && format === "nested") return canonical([labels[0]!, labels[1]!]);
    if (labels.length !== 1) return Option.none();
    const label = labels[0]!;
    const at = format === "flat" ? label.lastIndexOf(flatSeparator) : -1;
    if (at >= 1) return canonical([label.slice(0, at), label.slice(at + flatSeparator.length)]);
    return defaultOrganization === undefined
      ? Option.none()
      : canonical([label, defaultOrganization]);
  };
  const fromHost = (host: string | undefined) => {
    if (base === undefined || host === undefined) return Option.none();
    const url = URL.parse(`${base.protocol}//${host}`);
    const suffix = `.${base.hostname}`;
    if (
      url === null ||
      url.host !== host.toLowerCase() ||
      url.port !== base.port ||
      !url.hostname.endsWith(suffix)
    )
      return Option.none();
    const labels = url.hostname.slice(0, -suffix.length).split(".");
    return Option.flatMap(
      Schema.decodeUnknownOption(Schema.Array(AppUiHostnameLabel))(labels),
      (valid) =>
        Option.flatMap(names(valid), ([app, slug]) =>
          Schema.decodeUnknownOption(
            Schema.Struct({
              find: Schema.Struct({ slug: AppSlug }),
              slug: OrganizationSlug,
              origin: HttpUrl,
            }),
          )({ find: { slug: app }, slug, origin: url.origin }),
        ),
    );
  };
  return {
    dashboardOrigin,
    enabled: base !== undefined,
    format,
    defaultOrganization,
    origin,
    fromHost,
    ownsHost: (host: string | undefined) =>
      base !== undefined &&
      host !== undefined &&
      host.toLowerCase() !== dashboardHost &&
      (URL.parse(`${base.protocol}//${host}`)?.hostname.endsWith(`.${base.hostname}`) ?? false),
  };
};
