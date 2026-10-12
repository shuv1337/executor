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

/** Hosted app addresses resolve current names before authorizing immutable identities. */
export const appAddresses = (
  dashboardOrigin: string,
  baseUrl: AppUiBaseUrl | undefined,
  format: AppUiHostFormat = "nested",
) => {
  const base = baseUrl === undefined ? undefined : new URL(baseUrl);
  const dashboardHost = new URL(dashboardOrigin).host;
  const origin = (app: Pick<App, "slug">, slug: OrganizationSlug) =>
    Effect.gen(function* () {
      if (base === undefined) return yield* new UiFailed({ reason: "unavailable" });
      const candidates =
        format === "flat" ? [`${app.slug}${flatSeparator}${slug}`] : [app.slug, slug];
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
  /** The app and organization names under the base, or none when the host has another shape. */
  const names = (labels: ReadonlyArray<string>): Option.Option<readonly [string, string]> => {
    if (format === "nested")
      return labels.length === 2 ? Option.some([labels[0]!, labels[1]!]) : Option.none();
    const label = labels.length === 1 ? labels[0]! : undefined;
    const at = label?.lastIndexOf(flatSeparator) ?? -1;
    return label === undefined || at < 1
      ? Option.none()
      : Option.some([label.slice(0, at), label.slice(at + flatSeparator.length)]);
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
    origin,
    fromHost,
    ownsHost: (host: string | undefined) =>
      base !== undefined &&
      host !== undefined &&
      host.toLowerCase() !== dashboardHost &&
      (URL.parse(`${base.protocol}//${host}`)?.hostname.endsWith(`.${base.hostname}`) ?? false),
  };
};
