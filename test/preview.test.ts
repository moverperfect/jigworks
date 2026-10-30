import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { browserErrorsPath, sessionCookie, signInPath, type AppLogEntry } from "../src/apphost";
import type { BuildReport } from "../src/shared/build-report";
import { accessToken, testAccess } from "./helpers/access";
import { call, create } from "./helpers/api";

// The Preview, through the platform Worker as a browser sees it. Each good
// Build goes to the Workspace's app host, which runs it on a Dynamic Worker
// (ADR 0009) and signs its Developer in itself (ADR 0013).

const build = async (id: string) => {
  const response = await call(`/api/workspaces/${id}/build`, { method: "POST" });
  expect(response.status).toBe(200);
  return response.json<BuildReport>();
};

const save = async (id: string, path: string, text: string) => {
  const response = await call(`/api/workspaces/${id}/files/${path}`, { method: "PUT", text });
  expect(response.status).toBe(204);
};

const preview = async (id: string) => {
  const response = await call(`/api/workspaces/${id}/preview`);
  expect(response.status).toBe(200);
  return response.json<{ url: string; ready: boolean }>();
};

const logs = async (id: string) => {
  const response = await call(`/api/workspaces/${id}/preview/logs`);
  expect(response.status).toBe(200);
  return (await response.json<{ logs: AppLogEntry[] }>()).logs;
};

/** A sign-in link for the Preview, as the Workspace page asks for one. */
const signInLink = async (id: string, destination: "iframe" | "document", to = "/", email?: string) => {
  const response = await call(`/api/workspaces/${id}/preview/sign-in`, { method: "POST", body: { destination, to }, email });
  return response;
};

/** A request to an app's hostname, as a browser sends it. */
const browse = (url: string, { dest = "iframe", cookie, ...init }: RequestInit & { dest?: string; cookie?: string } = {}) => {
  const headers = new Headers(init.headers);
  headers.set("Sec-Fetch-Dest", dest);
  if (cookie) headers.set("Cookie", cookie);
  return exports.default.fetch(new Request(url, { ...init, headers, redirect: "manual" }));
};

/** Signs in to a Workspace's Preview through the pane's link, and returns the session cookie. */
const signIn = async (id: string, destination: "iframe" | "document" = "iframe") => {
  const { url } = await (await signInLink(id, destination)).json<{ url: string }>();
  const response = await browse(url, { dest: destination });
  expect(response.status).toBe(303);
  return response.headers.getSetCookie()[0]!.split(";", 1)[0]!;
};

/** A request to the Preview with a pane session. */
const visit = async (id: string, path = "/", init: RequestInit & { dest?: string } = {}) => {
  const { url } = await preview(id);
  return browse(new URL(path, url).href, { dest: "empty", ...init, cookie: await signIn(id) });
};

const waitFor = async <T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> => {
  for (let attempt = 0; attempt < 50; attempt++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return read();
};

describe("the Preview", () => {
  it("answers on the Workspace's own hostname once a Build succeeds", async () => {
    const workspace = await create("Preview Notes");
    const before = await preview(workspace.id);
    expect(before.ready).toBe(false);
    expect(new URL(before.url).hostname).toMatch(new RegExp(`^preview-notes-[a-z0-9]{8}-preview\\.${testAccess.appsDomain.replaceAll(".", "\\.")}$`));
    expect((await visit(workspace.id)).status).toBe(503);

    expect(await build(workspace.id)).toMatchObject({ ok: true });
    expect((await preview(workspace.id)).ready).toBe(true);
    const response = await visit(workspace.id);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("Hello from your Worker");
  });

  it("keeps the last good Build when a Build fails, and takes the next good one", async () => {
    const workspace = await create("Preview Builds");
    await build(workspace.id);
    await save(workspace.id, "src/index.ts", "export default {");
    expect(await build(workspace.id)).toMatchObject({ ok: false });
    expect(await (await visit(workspace.id)).text()).toBe("Hello from your Worker");

    await save(workspace.id, "src/index.ts", 'export default { fetch: () => new Response("changed") };\n');
    expect(await build(workspace.id)).toMatchObject({ ok: true });
    expect(await (await visit(workspace.id)).text()).toBe("changed");
  });

  it("gives app code only its own __Host- cookies, and none of Access's headers", async () => {
    const workspace = await create("Preview Requests");
    await save(
      workspace.id,
      "src/index.ts",
      `export default {
  fetch: (request: Request) =>
    Response.json({ cookie: request.headers.get("cookie"), headers: [...request.headers.keys()] }),
};
`,
    );
    await build(workspace.id);
    const { url } = await preview(workspace.id);
    const session = await signIn(workspace.id);
    const response = await browse(url, {
      dest: "empty",
      cookie: `${session}; __Host-app=1; CF_Authorization=token; theme=dark`,
      headers: { "Cf-Access-Jwt-Assertion": "token", "Cf-Access-Authenticated-User-Email": testAccess.developer },
    });
    const seen = await response.json<{ cookie: string | null; headers: string[] }>();
    expect(seen.cookie).toBe("__Host-app=1");
    expect(seen.headers.filter((name) => name.startsWith("cf-access-"))).toEqual([]);
  });

  it("passes only __Host- cookies to the browser, partitioned in the pane, and logs a warning for any other", async () => {
    const workspace = await create("Preview Cookies");
    await save(
      workspace.id,
      "src/index.ts",
      `export default {
  fetch: () => {
    const headers = new Headers();
    headers.append("Set-Cookie", "__Host-app=1; Path=/; Secure; HttpOnly; SameSite=Lax");
    headers.append("Set-Cookie", "tracker=1; Domain=${testAccess.appsDomain}; Path=/");
    headers.append("Set-Cookie", "${sessionCookie}=stolen; Path=/; Secure");
    return new Response("ok", { headers });
  },
};
`,
    );
    await build(workspace.id);
    const inPane = await visit(workspace.id);
    expect(inPane.headers.getSetCookie()).toEqual(["__Host-app=1; Path=/; Secure; HttpOnly; SameSite=None; Partitioned"]);
    const { url } = await preview(workspace.id);
    const inTab = await browse(url, { dest: "empty", cookie: await signIn(workspace.id, "document") });
    expect(inTab.headers.getSetCookie()).toEqual(["__Host-app=1; Path=/; Secure; HttpOnly; SameSite=Lax"]);
    const entries = await logs(workspace.id);
    expect(entries).toContainEqual(expect.objectContaining({ level: "warn", message: expect.stringContaining('"tracker"') }));
    expect(entries).toContainEqual(expect.objectContaining({ level: "warn", message: expect.stringContaining(`"${sessionCookie}"`) }));
  });

  it("keeps the app's server logs and the front-end errors its pages report", async () => {
    const workspace = await create("Preview Logs");
    await save(
      workspace.id,
      "src/index.ts",
      `export default {
  fetch: () => {
    console.log("rendering the page");
    return new Response("<!doctype html><html><head><title>Hi</title></head><body>Hi</body></html>", {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
};
`,
    );
    await build(workspace.id);
    const page = await (await visit(workspace.id)).text();
    expect(page).toContain(browserErrorsPath);
    expect(page.indexOf(browserErrorsPath)).toBeLessThan(page.indexOf("<title>"));

    const report = await visit(workspace.id, browserErrorsPath, {
      method: "POST",
      body: JSON.stringify({ kind: "error", message: "boom is not defined (/app.js:3:7)" }),
    });
    expect(report.status).toBe(204);
    const entries = await waitFor(
      () => logs(workspace.id),
      (lines) => lines.some((line) => line.source === "server"),
    );
    expect(entries).toContainEqual(expect.objectContaining({ source: "server", level: "log", message: "rendering the page" }));
    expect(entries).toContainEqual(
      expect.objectContaining({ source: "browser", level: "error", message: "boom is not defined (/app.js:3:7)" }),
    );
  });

  it("shows a Workspace's Preview, logs and sign-in links only to its own Developer", async () => {
    const workspace = await create("Preview Private");
    const theirs = { email: testAccess.secondDeveloper };
    expect((await call(`/api/workspaces/${workspace.id}/preview`, theirs)).status).toBe(404);
    expect((await call(`/api/workspaces/${workspace.id}/preview/logs`, theirs)).status).toBe(404);
    expect((await signInLink(workspace.id, "iframe", "/", testAccess.secondDeveloper)).status).toBe(404);
  });

  it("lets the Agent send the Preview requests", async () => {
    const workspace = await create("Preview Tools");
    const before = await env.WORKSPACES.getByName(workspace.id).requestPreview({ method: "GET", path: "/" });
    expect(before.status).toBe(503);
    await build(workspace.id);
    const response = await env.WORKSPACES.getByName(workspace.id).requestPreview({ method: "GET", path: "api/hello/Agent" });
    expect(response).toMatchObject({ status: 200, body: JSON.stringify({ message: "Hello, Agent" }), truncated: false });
  });

  it("moves to a new label if another Workspace already holds the one it was given", async () => {
    const workspace = await create("Preview Labels");
    const given = await env.WORKSPACES.getByName(workspace.id).appLabel();
    const someoneElse = await env.APP_HOSTS.getByName(given).receiveBuild("another-workspace", given, {
      hash: "x",
      mainModule: "index.js",
      modules: { "index.js": 'export default { fetch: () => new Response("not yours") };' },
      compatibilityDate: "2026-10-01",
      compatibilityFlags: [],
      vars: {},
    });
    expect(someoneElse.accepted).toBe(true);

    await build(workspace.id);
    const label = await env.WORKSPACES.getByName(workspace.id).appLabel();
    expect(label).not.toBe(given);
    expect(label).toMatch(/^preview-labels-[a-z0-9]{8}$/);
    expect(await (await visit(workspace.id)).text()).toBe("Hello from your Worker");
  });
});

describe("signing in to the Preview", () => {
  it("lets the pane in with a link that works once, then only with the session it gives", async () => {
    const workspace = await create("Sign In Pane");
    await build(workspace.id);
    const { url } = await (await signInLink(workspace.id, "iframe", "/api/hello/Pane")).json<{ url: string }>();
    expect(new URL(url).pathname).toBe(signInPath);

    const exchanged = await browse(url, { dest: "iframe" });
    expect(exchanged.status).toBe(303);
    expect(exchanged.headers.get("Location")).toBe("/api/hello/Pane");
    const [cookie] = exchanged.headers.getSetCookie();
    expect(cookie).toMatch(new RegExp(`^${sessionCookie}=[A-Za-z0-9_-]+; Path=/; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=\\d+$`));

    expect((await browse(url, { dest: "iframe" })).status).toBe(403);
    const page = await browse(new URL("/api/hello/Pane", url).href, { dest: "iframe", cookie: cookie!.split(";", 1)[0] });
    expect(await page.json()).toEqual({ message: "Hello, Pane" });
    expect(page.headers.get("Content-Security-Policy")).toBe(`frame-ancestors ${testAccess.origin}`);
  });

  it("refuses a link opened the wrong way, or on another app's hostname", async () => {
    const workspace = await create("Sign In Wrong");
    const other = await create("Sign In Other");
    const { url } = await (await signInLink(workspace.id, "iframe")).json<{ url: string }>();
    expect((await browse(url, { dest: "document" })).status).toBe(403);

    const { url: second } = await (await signInLink(workspace.id, "iframe")).json<{ url: string }>();
    const { url: otherPreview } = await preview(other.id);
    await signInLink(other.id, "iframe");
    const elsewhere = new URL(second);
    elsewhere.hostname = new URL(otherPreview).hostname;
    expect((await browse(elsewhere.href, { dest: "iframe" })).status).toBe(403);
  });

  it("never treats an Access token as a session on a Preview hostname", async () => {
    const workspace = await create("Sign In Access");
    await build(workspace.id);
    const { url } = await preview(workspace.id);
    const token = await accessToken({ email: testAccess.developer });
    const response = await browse(url, { dest: "empty", headers: { "Cf-Access-Jwt-Assertion": token }, cookie: `CF_Authorization=${token}` });
    expect(response.status).toBe(401);
  });

  it("asks the pane for a new link when its frame has no session", async () => {
    const workspace = await create("Sign In Expired");
    await build(workspace.id);
    const { url } = await preview(workspace.id);
    const response = await browse(url, { dest: "iframe", cookie: `${sessionCookie}=made-up` });
    expect(response.status).toBe(401);
    expect(await response.text()).toContain(`parent.postMessage({ type: "jigworks:preview-signed-out" }, ${JSON.stringify(testAccess.origin)})`);
  });

  it("sends a tab without a session through the platform, which signs its Developer back in", async () => {
    const workspace = await create("Sign In Tab");
    await build(workspace.id);
    const { url } = await preview(workspace.id);
    const away = await browse(new URL("/api/hello/Tab?x=1", url).href, { dest: "document" });
    expect(away.status).toBe(303);
    const back = new URL(away.headers.get("Location")!);
    expect(back.origin + back.pathname).toBe(`${testAccess.origin}/preview-sign-in`);

    // The platform is behind Access; a cross-site navigation is fine here.
    const token = await accessToken({ email: testAccess.developer });
    const fromPlatform = await exports.default.fetch(
      new Request(back, { headers: { "Cf-Access-Jwt-Assertion": token, "Sec-Fetch-Site": "cross-site" }, redirect: "manual" }),
    );
    expect(fromPlatform.status).toBe(303);
    const link = fromPlatform.headers.get("Location")!;
    const exchanged = await browse(link, { dest: "document" });
    expect(exchanged.headers.get("Location")).toBe("/api/hello/Tab?x=1");
    expect(exchanged.headers.getSetCookie()[0]).toContain("SameSite=Lax");
    expect(exchanged.headers.getSetCookie()[0]).not.toContain("Partitioned");
  });

  it("won't sign anyone into someone else's Preview, or send them to another site", async () => {
    const workspace = await create("Sign In Theirs");
    await build(workspace.id);
    const host = new URL((await preview(workspace.id)).url).hostname;
    const signInAs = async (email: string, to: string) =>
      exports.default.fetch(
        new Request(`${testAccess.origin}/preview-sign-in?host=${host}&to=${encodeURIComponent(to)}`, {
          headers: { "Cf-Access-Jwt-Assertion": await accessToken({ email }) },
          redirect: "manual",
        }),
      );
    expect((await signInAs(testAccess.secondDeveloper, "/")).status).toBe(404);

    const link = (await signInAs(testAccess.developer, "//elsewhere.example/steal")).headers.get("Location")!;
    const exchanged = await browse(link, { dest: "document" });
    expect(exchanged.headers.get("Location")).toBe("/");
  });

  it("refuses changes sent from other apps on the apps domain", async () => {
    const workspace = await create("Sign In Siblings");
    await build(workspace.id);
    const response = await visit(workspace.id, "/", { method: "POST", headers: { "Sec-Fetch-Site": "same-site" } });
    expect(response.status).toBe(403);
  });
});

describe("Deployments", () => {
  it("need a token from the apps' own Access application", async () => {
    const workspace = await create("Deployment Gate");
    await build(workspace.id);
    const label = await env.WORKSPACES.getByName(workspace.id).appLabel();
    const deployment = `https://${label}.${testAccess.appsDomain}/`;
    expect((await browse(deployment, { dest: "document" })).status).toBe(401);
    const platformToken = await accessToken({ email: testAccess.developer });
    expect((await browse(deployment, { dest: "document", headers: { "Cf-Access-Jwt-Assertion": platformToken } })).status).toBe(401);
    const appsToken = await accessToken({ email: testAccess.developer }, { audience: testAccess.appsAudience });
    // Through the gate; nothing is published until ticket 10.
    expect((await browse(deployment, { dest: "document", headers: { "Cf-Access-Jwt-Assertion": appsToken } })).status).toBe(404);
  });

  it("aren't looked up for hostnames the platform never gives out", async () => {
    expect((await browse(`https://not-a-label.${testAccess.appsDomain}/`, { dest: "document" })).status).toBe(404);
  });
});

describe("Builds after a save", () => {
  it("follow the Developer's saves on the server, so the Preview does too", async () => {
    const workspace = await create("Preview Saves");
    await save(workspace.id, "src/index.ts", 'export default { fetch: () => new Response("one") };\n');
    await save(workspace.id, "src/index.ts", 'export default { fetch: () => new Response("two") };\n');
    // Nothing asks for a Build: the save alone leads to one.
    const report = await waitFor(
      async () => (await call(`/api/workspaces/${workspace.id}/build`)).json<BuildReport | null>(),
      (latest) => latest !== null,
    );
    expect(report).toMatchObject({ ok: true });
    expect(await (await visit(workspace.id)).text()).toBe("two");
  });
});
