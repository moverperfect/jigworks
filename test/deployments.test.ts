import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { browserErrorsPath, labelOf, sessionCookie } from "../src/apphost";
import type { BuildReport } from "../src/shared/build-report";
import type { Deployment } from "../src/shared/deployment";
import { accessToken, testAccess } from "./helpers/access";
import { call, create } from "./helpers/api";
import { startTurn } from "./helpers/conversation";

// Deployments, through the platform Worker as a browser sees them. Publish
// copies the Build the Preview runs; the apps' Access application decides
// who opens it (ADR 0006, ADR 0012).

const build = async (id: string) => {
  const response = await call(`/api/workspaces/${id}/build`, { method: "POST" });
  expect(response.status).toBe(200);
  return response.json<BuildReport>();
};

const save = async (id: string, path: string, text: string) => {
  const response = await call(`/api/workspaces/${id}/files/${path}`, { method: "PUT", text });
  expect(response.status).toBe(204);
};

const say = (text: string) => `export default { fetch: () => new Response(${JSON.stringify(text)}) };\n`;

const deployment = async (id: string) => {
  const response = await call(`/api/workspaces/${id}/deployment`);
  expect(response.status).toBe(200);
  return response.json<Deployment>();
};

/** Publishes, replacing the Deployment whose Build is `replaces`, or none. */
const publish = (id: string, replaces: string | null = null, email?: string) =>
  call(`/api/workspaces/${id}/deployment`, { method: "POST", body: { replaces }, email });

/** A request to a Deployment, as a browser signed in to the apps' Access application sends it. */
const open = async (url: string, init: RequestInit & { cookie?: string } = {}) => {
  const headers = new Headers(init.headers);
  if (!headers.has("Cf-Access-Jwt-Assertion")) {
    headers.set("Cf-Access-Jwt-Assertion", await accessToken({ email: "colleague@example.com" }, { audience: testAccess.appsAudience }));
  }
  if (init.cookie) headers.set("Cookie", init.cookie);
  return exports.default.fetch(new Request(url, { ...init, headers, redirect: "manual" }));
};

describe("publishing", () => {
  it("copies the Build the Preview runs to the Deployment, which later Builds don't change", async () => {
    const workspace = await create("Deployment Copy");
    await save(workspace.id, "src/index.ts", say("one"));
    await build(workspace.id);
    const before = await deployment(workspace.id);
    expect(before).toMatchObject({ publishedAt: null, hash: null });
    expect(new URL(before.url).hostname).toMatch(new RegExp(`^deployment-copy-[a-z0-9]{8}\\.${testAccess.appsDomain.replaceAll(".", "\\.")}$`));
    expect((await open(before.url)).status).toBe(404);

    const published = await publish(workspace.id);
    expect(published.status).toBe(200);
    const info = await published.json<Deployment>();
    expect(info).toMatchObject({ url: before.url, hash: expect.any(String), publishedAt: expect.any(String) });
    expect(await (await open(info.url)).text()).toBe("one");

    // Two more Builds: the Preview moves on, and the Deployment stays.
    for (const text of ["two", "three"]) {
      await save(workspace.id, "src/index.ts", say(text));
      await build(workspace.id);
    }
    expect(await (await open(info.url)).text()).toBe("one");
    expect(await deployment(workspace.id)).toEqual(info);

    expect((await publish(workspace.id, info.hash)).status).toBe(200);
    expect(await (await open(info.url)).text()).toBe("three");
  });

  it("replaces only the Deployment the page saw, so a page left open can't replace a newer one unasked", async () => {
    const workspace = await create("Deployment Stale");
    await save(workspace.id, "src/index.ts", say("one"));
    await build(workspace.id);
    const first = await (await publish(workspace.id)).json<Deployment>();
    await save(workspace.id, "src/index.ts", say("two"));
    await build(workspace.id);

    // A page that loaded before the first publish, and one that saw some other Build.
    for (const replaces of [null, "0".repeat(64)]) {
      const refused = await publish(workspace.id, replaces);
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({ error: "The Deployment changed since this page loaded. Look at it again before publishing." });
    }
    expect(await (await open(first.url)).text()).toBe("one");
    expect((await publish(workspace.id, first.hash)).status).toBe(200);
    expect(await (await open(first.url)).text()).toBe("two");
  });

  it("keeps a copy of the Build, which a later Build with the same hash can't change", async () => {
    const workspace = await create("Deployment Kept");
    await save(workspace.id, "src/index.ts", say("one"));
    await build(workspace.id);
    const { url, hash } = await (await publish(workspace.id)).json<Deployment>();
    // As after a platform upgrade: the same files, so the same hash, built differently.
    const label = labelOf(new URL(url).hostname);
    const host = env.APP_HOSTS.getByName(label);
    await save(workspace.id, "src/index.ts", say("two"));
    await build(workspace.id);
    const accepted = await host.receiveBuild(workspace.id, label, {
      hash: hash!,
      mainModule: "index.js",
      modules: { "index.js": 'export default { fetch: () => new Response("rebuilt") };' },
      compatibilityDate: "2026-10-01",
      compatibilityFlags: [],
      vars: {},
      assets: {},
      assetManifest: {},
      assetSettings: { notFoundHandling: "none", runWorkerFirst: false },
      durableObjects: {},
    });
    expect(accepted.accepted).toBe(true);
    expect(await (await open(url)).text()).toBe("one");
  });

  it("waits for the Agent's Turn to end", async () => {
    const workspace = await create("Deployment Turn");
    await build(workspace.id);
    expect((await startTurn(workspace.id, "[script:slow] Take your time")).status).toBe(202);
    const refused = await publish(workspace.id);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "The Agent is working. Wait for its Turn to end." });
  });

  it("is refused for a Turn that starts while it's on its way", async () => {
    const workspace = await create("Deployment Race");
    await build(workspace.id);
    // As for a Workspace built before ticket 08, so publishing waits for a Build first.
    await runInDurableObject(env.WORKSPACES.getByName(workspace.id), (_instance, state) => {
      state.storage.kv.delete("app:label");
      state.storage.kv.delete("app:sent");
    });
    const stub = env.WORKSPACES.getByName(workspace.id);
    const publishing = stub.publish(null);
    const turn = await stub.startTurn("[script:slow] Take your time");
    expect(turn.ok).toBe(true);
    expect(await publishing).toEqual({ ok: false, busy: true, error: "The Agent is working. Wait for its Turn to end." });
  });

  it("needs a successful Build first", async () => {
    const workspace = await create("Deployment Unbuilt");
    const response = await publish(workspace.id);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "There's no successful Build to publish yet." });
  });

  it("is for the Workspace's own Developer only", async () => {
    const workspace = await create("Deployment Private");
    await build(workspace.id);
    expect((await publish(workspace.id, null, testAccess.secondDeveloper)).status).toBe(404);
    expect((await call(`/api/workspaces/${workspace.id}/deployment`, { email: testAccess.secondDeveloper })).status).toBe(404);
  });
});

describe("a Deployment", () => {
  it("needs a token from the apps' own Access application", async () => {
    const workspace = await create("Deployment Gate");
    await build(workspace.id);
    const { url } = await deployment(workspace.id);
    expect((await publish(workspace.id)).status).toBe(200);
    const anonymous = await exports.default.fetch(new Request(url, { redirect: "manual" }));
    expect(anonymous.status).toBe(401);
    const platformToken = await accessToken({ email: testAccess.developer });
    expect((await open(url, { headers: { "Cf-Access-Jwt-Assertion": platformToken } })).status).toBe(401);
    expect((await open(url)).status).toBe(200);
  });

  it("gives app code only its own __Host- cookies and none of Access's headers, and sets only __Host- cookies", async () => {
    const workspace = await create("Deployment Cookies");
    await save(
      workspace.id,
      "src/index.ts",
      `export default {
  fetch: (request: Request) => {
    const headers = new Headers();
    headers.append("Set-Cookie", "__Host-app=1; Path=/; Secure; HttpOnly; SameSite=Lax");
    headers.append("Set-Cookie", "tracker=1; Path=/");
    return Response.json({ cookie: request.headers.get("cookie"), headers: [...request.headers.keys()] }, { headers });
  },
};
`,
    );
    await build(workspace.id);
    const { url } = await (await publish(workspace.id)).json<Deployment>();
    const response = await open(url, {
      cookie: `CF_Authorization=token; __Host-app=1; ${sessionCookie}=x; theme=dark`,
      headers: { "Cf-Access-Authenticated-User-Email": "colleague@example.com" },
    });
    const seen = await response.json<{ cookie: string | null; headers: string[] }>();
    expect(seen.cookie).toBe("__Host-app=1");
    expect(seen.headers.filter((name) => name.startsWith("cf-access-"))).toEqual([]);
    expect(response.headers.getSetCookie()).toEqual(["__Host-app=1; Path=/; Secure; HttpOnly; SameSite=Lax"]);
  });

  it("refuses changes, frames and WebSockets from other apps on the apps domain", async () => {
    const workspace = await create("Deployment Siblings");
    await build(workspace.id);
    const { url } = await (await publish(workspace.id)).json<Deployment>();
    const sibling = `https://sibling-k3x9p2qa-preview.${testAccess.appsDomain}`;
    expect((await open(url, { method: "POST", headers: { "Sec-Fetch-Site": "same-site" } })).status).toBe(403);
    // A browser that sends no Sec-Fetch-Site still sends Origin.
    expect((await open(url, { method: "POST", headers: { Origin: sibling } })).status).toBe(403);
    // From its own pages it reaches the app, whose Template has no POST route.
    expect((await open(url, { method: "POST", headers: { Origin: new URL(url).origin } })).status).toBe(404);
    expect((await open(url)).headers.get("Content-Security-Policy")).toBe("frame-ancestors 'self'");
    expect((await open(url, { headers: { Upgrade: "websocket", Origin: sibling } })).status).toBe(403);
  });

  it("carries none of the Preview's own additions, and lets the app say who may frame it", async () => {
    const workspace = await create("Deployment Plain");
    await save(
      workspace.id,
      "src/index.ts",
      `export default {
  fetch: () =>
    new Response("<!doctype html><html><head></head><body>Hi</body></html>", {
      headers: { "Content-Type": "text/html", "Content-Security-Policy": "frame-ancestors https://intranet.example" },
    }),
};
`,
    );
    await build(workspace.id);
    const { url } = await (await publish(workspace.id)).json<Deployment>();
    const page = await open(url);
    expect(page.headers.get("Content-Security-Policy")).toBe("frame-ancestors https://intranet.example");
    expect(await page.text()).not.toContain(browserErrorsPath);
    expect((await open(new URL(browserErrorsPath, url).href, { method: "POST", body: "{}" })).status).toBe(404);
  });

  it("keeps its server logs apart from the Preview's", async () => {
    const workspace = await create("Deployment Logs");
    await save(workspace.id, "src/index.ts", 'export default { fetch: () => { console.log("deployed"); return new Response("hi"); } };\n');
    await build(workspace.id);
    const { url } = await (await publish(workspace.id)).json<Deployment>();
    // The same Build runs in both, each in a Worker of its own. Read to the
    // end, so each app's invocation ends and its logs arrive.
    expect(await (await open(url)).text()).toBe("hi");
    expect(await (await open(url)).text()).toBe("hi");
    expect((await env.WORKSPACES.getByName(workspace.id).requestPreview({ method: "GET", path: "/" })).body).toBe("hi");
    const host = env.APP_HOSTS.getByName(labelOf(new URL(url).hostname));
    let deployed: unknown[] = [];
    for (let attempt = 0; attempt < 50 && deployed.length < 2; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      deployed = await host.logs("deployment");
    }
    expect(deployed).toHaveLength(2);
    expect(await host.logs("preview")).toEqual([expect.objectContaining({ slot: "preview", message: "deployed" })]);
  });

  it("goes when its Workspace is deleted", async () => {
    const workspace = await create("Deployment Deleted");
    await build(workspace.id);
    const { url } = await (await publish(workspace.id)).json<Deployment>();
    expect((await open(url)).status).toBe(200);
    const deleted = await call(`/api/workspaces/${workspace.id}`, { method: "DELETE", body: { confirmName: workspace.name } });
    expect(deleted.status).toBe(204);
    expect((await open(url)).status).toBe(404);
  });

  it("isn't looked up for hostnames the platform never gives out", async () => {
    expect((await open(`https://not-a-label.${testAccess.appsDomain}/`)).status).toBe(404);
  });
});
