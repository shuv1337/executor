import type { AuthConfig } from "convex/server";

const trim = (value: string | undefined): string | undefined => {
  const candidate = value?.trim();
  return candidate && candidate.length > 0 ? candidate : undefined;
};

const rawClientId = trim(process.env.WORKOS_CLIENT_ID);
const clientId = rawClientId && rawClientId !== "disabled" ? rawClientId : undefined;

const providers: AuthConfig["providers"] = clientId
  ? [
      {
        type: "customJwt",
        issuer: "https://api.workos.com/",
        algorithm: "RS256",
        applicationID: clientId,
        jwks: `https://api.workos.com/sso/jwks/${clientId}`,
      },
      {
        type: "customJwt",
        issuer: `https://api.workos.com/user_management/${clientId}`,
        algorithm: "RS256",
        jwks: `https://api.workos.com/sso/jwks/${clientId}`,
      },
    ]
  : [];

const authConfig: AuthConfig = {
  providers,
};

export default authConfig;
