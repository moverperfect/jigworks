import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { verifyAccess } from "../src/access";

const config = { teamDomain: "example.cloudflareaccess.com", audience: "example-aud" };
let keys: ReturnType<typeof createLocalJWKSet>;
let sign: (payload: JWTPayload, overrides?: { issuer?: string; audience?: string }) => Promise<string>;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" }] });
  sign = (payload, overrides = {}) =>
    new SignJWT(payload)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(overrides.issuer ?? `https://${config.teamDomain}`)
      .setAudience(overrides.audience ?? config.audience)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
});

const requestWith = (token: string) => new Request("https://app.jigworks.example/", { headers: { "Cf-Access-Jwt-Assertion": token } });

describe("verifyAccess", () => {
  it("lets a signed-in person through", async () => {
    const token = await sign({ email: "developer@example.com" });
    expect(await verifyAccess(requestWith(token), config, keys)).toEqual({ kind: "person", email: "developer@example.com" });
  });

  it("lets a service token through", async () => {
    const token = await sign({ common_name: "abc123.access" });
    expect(await verifyAccess(requestWith(token), config, keys)).toEqual({ kind: "service-token", clientId: "abc123.access" });
  });

  it("refuses a token for another Access application", async () => {
    const token = await sign({ email: "developer@example.com" }, { audience: "another-aud" });
    expect(await verifyAccess(requestWith(token), config, keys)).toBeNull();
  });

  it("refuses a token from another team", async () => {
    const token = await sign({ email: "developer@example.com" }, { issuer: "https://elsewhere.cloudflareaccess.com" });
    expect(await verifyAccess(requestWith(token), config, keys)).toBeNull();
  });

  it("refuses everything while the team domain or audience is unset", async () => {
    const token = await sign({ email: "developer@example.com" });
    expect(await verifyAccess(requestWith(token), { teamDomain: "", audience: "" }, keys)).toBeNull();
  });
});
