import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { browserErrorsPath } from "../src/apphost";
import type { BuildReport } from "../src/shared/build-report";
import { testAccess } from "./helpers/access";
import { call, create } from "./helpers/api";

// The Preview: each good Build goes to the Workspace's app host, which runs it
// on a Dynamic Worker (ADR 0009). These reach the app host directly; the
// apps' gate in the platform Worker is tested on its own.

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

/** Sends the Preview a request as the platform Worker would, once its gate let it through. */
const visit = async (id: string, path = "/", init: RequestInit = {}) => {
  const { url } = await preview(id);
  const label = new URL(url).hostname.split(".")[0]!.replace(/-preview$/, "");
  return env.APP_HOSTS.getByName(label).fetch(new Request(new URL(path, url), init));
};

const logs = async (id: string) => env.WORKSPACES.getByName(id).previewLogs();

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

  it("gives app code only __Host- cookies, and none of Access's headers", async () => {
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
    const response = await visit(workspace.id, "/", {
      headers: {
        Cookie: "__Host-session=1; CF_Authorization=token; theme=dark",
        "Cf-Access-Jwt-Assertion": "token",
        "Cf-Access-Authenticated-User-Email": testAccess.developer,
      },
    });
    const seen = await response.json<{ cookie: string | null; headers: string[] }>();
    expect(seen.cookie).toBe("__Host-session=1");
    expect(seen.headers.filter((name) => name.startsWith("cf-access-"))).toEqual([]);
  });

  it("passes only __Host- cookies to the browser, and logs a warning for any other", async () => {
    const workspace = await create("Preview Cookies");
    await save(
      workspace.id,
      "src/index.ts",
      `export default {
  fetch: () => {
    const headers = new Headers();
    headers.append("Set-Cookie", "__Host-session=1; Path=/; Secure; HttpOnly");
    headers.append("Set-Cookie", "tracker=1; Domain=${testAccess.appsDomain}; Path=/");
    return new Response("ok", { headers });
  },
};
`,
    );
    await build(workspace.id);
    const response = await visit(workspace.id);
    expect(response.headers.getSetCookie()).toEqual(["__Host-session=1; Path=/; Secure; HttpOnly"]);
    expect(await logs(workspace.id)).toContainEqual(
      expect.objectContaining({ source: "server", level: "warn", message: expect.stringContaining('"tracker"') }),
    );
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
