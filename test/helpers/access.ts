import { env } from "cloudflare:workers";
import { importJWK, SignJWT, type JWK, type JWTPayload } from "jose";
import { testAccess } from "../fixtures/access-settings";

export { testAccess };

/** A token like the one Cloudflare Access adds to a request it lets through. */
export async function accessToken(
  payload: JWTPayload = { email: testAccess.developer },
  { audience = testAccess.audience } = {},
): Promise<string> {
  // Only the tests have this binding: the key vitest.config.ts made for this run.
  const { TEST_ACCESS_SIGNING_KEY } = env as Env & { TEST_ACCESS_SIGNING_KEY: JWK };
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(`https://${testAccess.teamDomain}`)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(await importJWK(TEST_ACCESS_SIGNING_KEY, "RS256"));
}
