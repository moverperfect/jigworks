import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export interface AccessConfig {
  /** The Access team domain, such as `example.cloudflareaccess.com`. */
  teamDomain: string | undefined;
  /** The Access application's AUD tag. */
  audience: string | undefined;
}

/** Who Access let through: a person by email, or a service token by its client ID. */
export type AccessIdentity = { kind: "person"; email: string } | { kind: "service-token"; clientId: string };

const keySets = new Map<string, JWTVerifyGetKey>();

/**
 * Checks the Access token that Cloudflare Access adds to every request it lets
 * through. Returns the identity, or null when the request must be refused.
 * Without a team domain and an audience, every request is refused, so a
 * Worker deployed before its Access application exists stays closed.
 */
export async function verifyAccess(
  request: Request,
  config: AccessConfig,
  keys: JWTVerifyGetKey | undefined = undefined,
): Promise<AccessIdentity | null> {
  const { teamDomain, audience } = config;
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!teamDomain || !audience || !token) return null;
  const issuer = `https://${teamDomain}`;
  let keySet = keys ?? keySets.get(issuer);
  if (!keySet) {
    keySet = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    keySets.set(issuer, keySet);
  }
  try {
    const { payload } = await jwtVerify(token, keySet, { issuer, audience });
    if (typeof payload.email === "string" && payload.email) return { kind: "person", email: payload.email };
    if (typeof payload.common_name === "string" && payload.common_name) {
      return { kind: "service-token", clientId: payload.common_name };
    }
    return null;
  } catch {
    return null;
  }
}
