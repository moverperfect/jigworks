import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { BuildReport } from "../src/shared/build-report";
import type { Deployment } from "../src/shared/deployment";
import { accessToken, testAccess } from "./helpers/access";
import { call, create } from "./helpers/api";
import { connect, history, runTurn, textOf } from "./helpers/conversation";

// App secrets: the Developer gives a Workspace secrets, which its app reads
// from env in the Preview and the Deployment. The Agent sees their names,
// and the platform keeps their values out of what the Agent reads (ADR 0016).

const build = async (id: string) => {
  const response = await call(`/api/workspaces/${id}/build`, { method: "POST" });
  expect(response.status).toBe(200);
  return response.json<BuildReport>();
};

const save = async (id: string, path: string, text: string) => {
  const response = await call(`/api/workspaces/${id}/files/${path}`, { method: "PUT", text });
  expect(response.status).toBe(204);
};

const setSecret = (id: string, name: string, value: unknown, email?: string) =>
  call(`/api/workspaces/${id}/secrets/${name}`, { method: "PUT", body: { value }, email });

const secretNames = async (id: string) => {
  const response = await call(`/api/workspaces/${id}/secrets`);
  expect(response.status).toBe(200);
  return (await response.json<{ secrets: { name: string; updatedAt: string }[] }>()).secrets.map(({ name }) => name);
};

/** An app that answers with the names in its env, and the value of the one a path names. */
const envApp = `export default {
  fetch(request: Request, env: Record<string, unknown>) {
    const name = new URL(request.url).pathname.slice(1);
    if (name === "names") return Response.json(Object.keys(env).sort());
    if (name === "log") {
      console.log("the key is", env.API_KEY);
      return new Response("logged");
    }
    return new Response(String(env[name] ?? "(none)"));
  },
};
`;

const envWorkspace = async (name: string) => {
  const workspace = await create(name);
  await save(workspace.id, "src/index.ts", envApp);
  expect(await build(workspace.id)).toMatchObject({ ok: true });
  return workspace;
};

/** What the app answers in the Preview, signed in as the pane is, so nothing is hidden. */
const inPreview = async (id: string, path: string) => {
  const link = await call(`/api/workspaces/${id}/preview/sign-in`, { method: "POST", body: { to: path } });
  const { url } = await link.json<{ url: string }>();
  const signedIn = await exports.default.fetch(new Request(url, { headers: { "Sec-Fetch-Dest": "iframe" }, redirect: "manual" }));
  const cookie = signedIn.headers.getSetCookie()[0]!.split(";", 1)[0]!;
  const page = new URL(signedIn.headers.get("Location")!, url);
  return (await exports.default.fetch(new Request(page, { headers: { Cookie: cookie, "Sec-Fetch-Dest": "iframe" } }))).text();
};

const inDeployment = async (url: string, path: string) => {
  const token = await accessToken({ email: "colleague@example.com" }, { audience: testAccess.appsAudience });
  return (await exports.default.fetch(new Request(new URL(path, url), { headers: { "Cf-Access-Jwt-Assertion": token } }))).text();
};

describe("a Workspace's secrets", () => {
  it("can be added, replaced and removed, and their values are never shown again", async () => {
    const workspace = await create("Secrets Kept");
    expect(await secretNames(workspace.id)).toEqual([]);
    expect((await setSecret(workspace.id, "API_KEY", "first-value")).status).toBe(204);
    expect((await setSecret(workspace.id, "OTHER_KEY", "other-value")).status).toBe(204);
    expect((await setSecret(workspace.id, "API_KEY", "second-value")).status).toBe(204);
    const listed = await call(`/api/workspaces/${workspace.id}/secrets`);
    const text = await listed.text();
    expect(JSON.parse(text)).toEqual({
      secrets: [
        { name: "API_KEY", updatedAt: expect.any(String) },
        { name: "OTHER_KEY", updatedAt: expect.any(String) },
      ],
    });
    expect(text).not.toContain("value");
    expect((await call(`/api/workspaces/${workspace.id}/secrets/OTHER_KEY`, { method: "DELETE" })).status).toBe(204);
    expect(await secretNames(workspace.id)).toEqual(["API_KEY"]);
  });

  it("refuses names and values the app couldn't use", async () => {
    const workspace = await create("Secrets Refused");
    for (const [name, value] of [
      ["1KEY", "x"],
      ["has-dash", "x"],
      ["__jigworks_app_data", "x"],
      ["EMPTY", ""],
      ["NOT_TEXT", 42],
      ["TOO_LONG", "x".repeat(5121)],
    ] as const) {
      const response = await setSecret(workspace.id, name, value);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: expect.any(String) });
    }
    expect(await secretNames(workspace.id)).toEqual([]);
  });

  it("are the Workspace's own Developer's only", async () => {
    const workspace = await create("Secrets Private");
    expect((await setSecret(workspace.id, "API_KEY", "x", testAccess.secondDeveloper)).status).toBe(404);
    expect((await call(`/api/workspaces/${workspace.id}/secrets`, { email: testAccess.secondDeveloper })).status).toBe(404);
  });
});

describe("an app's secrets", () => {
  it("reach the app's env in the Preview and the Deployment, and changes reach it without a new Build", async () => {
    const workspace = await envWorkspace("Secrets In Env");
    expect(await inPreview(workspace.id, "/API_KEY")).toBe("(none)");
    await setSecret(workspace.id, "API_KEY", "first-value");
    expect(await inPreview(workspace.id, "/API_KEY")).toBe("first-value");
    const published = await call(`/api/workspaces/${workspace.id}/deployment`, { method: "POST", body: { replaces: null } });
    const { url } = await published.json<Deployment>();
    expect(await inDeployment(url, "/API_KEY")).toBe("first-value");

    await setSecret(workspace.id, "API_KEY", "second-value");
    expect(await inPreview(workspace.id, "/API_KEY")).toBe("second-value");
    expect(await inDeployment(url, "/API_KEY")).toBe("second-value");
    await call(`/api/workspaces/${workspace.id}/secrets/API_KEY`, { method: "DELETE" });
    expect(await inPreview(workspace.id, "/API_KEY")).toBe("(none)");
  });

  it("are all the app's env holds, with its vars: none of the platform's own secrets", async () => {
    const workspace = await envWorkspace("Secrets Platform");
    await setSecret(workspace.id, "API_KEY", "value-1234");
    expect(JSON.parse(await inPreview(workspace.id, "/names"))).toEqual(["API_KEY", "GREETING"]);
  });

  it("reach the app's Durable Objects too", async () => {
    const workspace = await create("Secrets Objects");
    await save(
      workspace.id,
      "wrangler.jsonc",
      JSON.stringify({
        name: "app",
        main: "src/index.ts",
        compatibility_date: "2026-10-01",
        durable_objects: { bindings: [{ name: "KEEPER", class_name: "Keeper" }] },
      }),
    );
    await save(
      workspace.id,
      "src/index.ts",
      `import { DurableObject } from "cloudflare:workers";
export class Keeper extends DurableObject<{ API_KEY?: string }> {
  key() { return this.env.API_KEY ?? "(none)"; }
}
export default {
  async fetch(_request: Request, env: { KEEPER: DurableObjectNamespace<Keeper> }) {
    return new Response(await env.KEEPER.getByName("x").key());
  },
};
`,
    );
    expect(await build(workspace.id)).toMatchObject({ ok: true });
    await setSecret(workspace.id, "API_KEY", "first-value");
    expect(await inPreview(workspace.id, "/")).toBe("first-value");
    await setSecret(workspace.id, "API_KEY", "second-value");
    expect(await inPreview(workspace.id, "/")).toBe("second-value");
  });
});

describe("the Agent and secrets", () => {
  it("lists the secrets' names with list_secrets", async () => {
    const workspace = await create("Secrets Names");
    await setSecret(workspace.id, "API_KEY", "a-long-secret-value");
    await setSecret(workspace.id, "OTHER_KEY", "another-secret-value");
    await runTurn(workspace.id, await connect(workspace.id), "[script:list-secrets] Which secrets are there?");
    const [, reply] = await history(workspace.id);
    expect(textOf(reply!)).toBe("The tool said: API_KEY, OTHER_KEY");
  });

  it("never reads a secret's value in what the Preview answers or logs", async () => {
    const workspace = await envWorkspace("Secrets Hidden");
    await setSecret(workspace.id, "API_KEY", "a-long-secret-value");
    const agent = env.WORKSPACES.getByName(workspace.id);
    expect((await agent.requestPreview({ method: "GET", path: "/API_KEY" })).body).toBe("[secret API_KEY]");
    expect((await agent.requestPreview({ method: "GET", path: "/log" })).body).toBe("logged");
    let logs: { message: string }[] = [];
    for (let attempt = 0; attempt < 50 && logs.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      logs = await agent.previewLogs();
    }
    expect(logs.map(({ message }) => message)).toEqual(["the key is [secret API_KEY]"]);
  });
});
