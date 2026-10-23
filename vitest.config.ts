import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { exportJWK, generateKeyPair } from "jose";
import { defineConfig } from "vitest/config";
import { testAccess } from "./test/fixtures/access-settings.ts";
import { agentScripts } from "./test/fixtures/agent-scripts.ts";
import { fakeAnthropic } from "./test/fixtures/fake-anthropic.ts";
import { fakeRegistry } from "./test/fixtures/fake-registry.ts";
import { registryPackages } from "./test/fixtures/registry-data.ts";

const registry = fakeRegistry(registryPackages);
const anthropicKey = "test-anthropic-key";
const anthropic = fakeAnthropic(agentScripts, { apiKey: anthropicKey });

// The tests sign Access tokens with a key made for this run, so no private key
// is ever committed. Its public half is served where the platform fetches
// Access's signing keys, and its private half reaches the tests as a binding.
const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
const [publicJwk, privateJwk] = await Promise.all([exportJWK(publicKey), exportJWK(privateKey)]);

export default defineConfig({
  test: {
    // The first Check and the first Build in an isolate compile large
    // WebAssembly modules, so each test is allowed two minutes.
    projects: [
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              bindings: {
                ACCESS_TEAM_DOMAIN: testAccess.teamDomain,
                ACCESS_AUD: testAccess.audience,
                DEVELOPER_LIST: `${testAccess.developer},${testAccess.secondDeveloper},${testAccess.developerDomain}`,
                PLATFORM_ORIGIN: testAccess.origin,
                // Tests never sign in, or reach a model, through a local .dev.vars.
                DEV_SIGNED_IN_AS: "",
                AGENT_BASE_URL: "",
                ANTHROPIC_API_KEY: anthropicKey,
                TEST_ACCESS_SIGNING_KEY: privateJwk,
              },
              // Outbound requests reach only the fake Access keys, the fake npm
              // registry and the scripted model.
              outboundService: async (request: Request) => {
                if (new URL(request.url).href === `https://${testAccess.teamDomain}/cdn-cgi/access/certs`) {
                  return Response.json({ keys: [publicJwk] });
                }
                return (
                  (await registry(request)) ??
                  (await anthropic(request)) ??
                  new Response("No outbound requests in tests", { status: 502 })
                );
              },
            },
          }),
        ],
        test: { name: "platform", include: ["test/**/*.test.ts"], testTimeout: 120_000 },
      },
    ],
  },
});
