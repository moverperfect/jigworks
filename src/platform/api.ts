import { zipSync } from "fflate";
import { Hono, type Context } from "hono";
import { isHidden, maxFileBytes, normalisePath } from "../files";
import { newAppName, validateWorkspaceName } from "../shared/workspace-name";
import { getTemplate, listAddons, listTemplates } from "../templates";

export type Platform = { Bindings: Env; Variables: { email: string } };

/** The JSON API behind the platform's pages, at /api. The request gate has already let the request in. */
export const api = new Hono<Platform>();

const developer = (c: Context<Platform>) => c.env.DEVELOPERS.getByName(c.get("email"));
const workspace = (c: Context<Platform>, id: string) => c.env.WORKSPACES.getByName(id);
/** The signed-in Developer's Workspace named in the path, or null if they have none by that ID. */
const ownWorkspace = (c: Context<Platform>) => developer(c).get(c.req.param("id") ?? "");
const noSuchWorkspace = (c: Context<Platform>) => c.json({ error: "There's no such Workspace." }, 404);

api.get("/me", (c) => c.json({ email: c.get("email") }));

api.get("/templates", (c) => c.json({ templates: listTemplates() }));

api.get("/addons", (c) => c.json({ addons: listAddons() }));

api.get("/workspaces", async (c) => c.json({ workspaces: await developer(c).list() }));

/**
 * Creates a Workspace from the Developer's `{ message }`: an empty one named
 * "New app", whose first Turn starts with the message and starts the app
 * (ADR 0018). Or, for tests and scripts, from `{ name, template }`.
 */
api.post("/workspaces", async (c) => {
  const body = await c.req.json<{ message?: unknown; name?: unknown; template?: unknown }>().catch(() => null);
  let name = newAppName;
  let template: string | null = null;
  let message: string | null = null;
  if (body?.message !== undefined) {
    message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) return c.json({ error: "Say what you'd like to make." }, 400);
  } else {
    name = typeof body?.name === "string" ? body.name : "";
    const invalid = validateWorkspaceName(name);
    if (invalid) return c.json({ error: invalid }, 400);
    template = typeof body?.template === "string" ? (getTemplate(body.template)?.id ?? null) : null;
    if (!template) return c.json({ error: "There's no Template with that name." }, 400);
  }
  // Listed before it's filled, so a Workspace left half-made by a failure can
  // still be seen and deleted.
  const record = await developer(c).add({ id: crypto.randomUUID(), name: name.trim(), template, createdAt: new Date().toISOString() });
  try {
    const created = workspace(c, record.id);
    await created.initialise(c.get("email"), record.template ? { template: record.template, name: record.name } : undefined);
    if (message !== null) {
      const turn = await created.startTurn(message);
      if (!turn.ok) throw new Error(turn.error);
    }
  } catch (error) {
    await developer(c).remove(record.id);
    throw error;
  }
  return c.json({ workspace: record }, 201);
});

api.get("/workspaces/:id", async (c) => {
  const record = await ownWorkspace(c);
  return record ? c.json({ workspace: record }) : noSuchWorkspace(c);
});

/**
 * Renames the app. The name is only the list's: the app's label, and so its
 * address, stays as it was. Refused until the Agent has started the app,
 * whose name would replace the Developer's.
 */
api.patch("/workspaces/:id", async (c) => {
  const record = await ownWorkspace(c);
  if (!record) return noSuchWorkspace(c);
  if (record.template === null) return c.json({ error: "Your app hasn't started yet. Wait for the Agent to start it." }, 409);
  const body = await c.req.json<{ name?: unknown }>().catch(() => null);
  const name = typeof body?.name === "string" ? body.name : "";
  const invalid = validateWorkspaceName(name);
  if (invalid) return c.json({ error: invalid }, 400);
  // Read back, as a Turn or a save may have changed the record since.
  const renamed = await developer(c).rename(record.id, name.trim());
  return renamed ? c.json({ workspace: renamed }) : noSuchWorkspace(c);
});

api.delete("/workspaces/:id", async (c) => {
  const record = await ownWorkspace(c);
  if (!record) return noSuchWorkspace(c);
  const body = await c.req.json<{ confirmName?: unknown }>().catch(() => null);
  if (body?.confirmName !== record.name) {
    return c.json({ error: "Type the Workspace's name exactly to delete it." }, 400);
  }
  // The data goes before the record, so if removing the record fails, deleting
  // again completes the deletion.
  try {
    await workspace(c, record.id).removeApp();
    // The Agents SDK's destroy() drops every table, then resets the object,
    // which can cut off its reply.
    await workspace(c, record.id).destroy();
  } catch (error) {
    if (!String(error).includes("destroyed")) throw error;
  }
  await developer(c).remove(record.id);
  return c.body(null, 204);
});

api.get("/workspaces/:id/export", async (c) => {
  const record = await ownWorkspace(c);
  if (!record) return noSuchWorkspace(c);
  const zip = zipSync(await workspace(c, record.id).exportFiles());
  return new Response(zip, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": contentDisposition(`${record.name}.zip`),
    },
  });
});

api.get("/workspaces/:id/packages", async (c) => {
  const record = await ownWorkspace(c);
  return record ? c.json(await workspace(c, record.id).packageStatus()) : noSuchWorkspace(c);
});

api.post("/workspaces/:id/packages", async (c) => {
  const record = await ownWorkspace(c);
  if (!record) return noSuchWorkspace(c);
  const body = await c.req.json<{ name?: unknown; range?: unknown; dev?: unknown }>().catch(() => null);
  if (typeof body?.name !== "string") return c.json({ error: "Say which Package to add." }, 400);
  const result = await workspace(c, record.id).addPackage(body.name, {
    range: typeof body.range === "string" ? body.range : undefined,
    dev: typeof body.dev === "boolean" ? body.dev : undefined,
  });
  if (!result.ok) return c.json({ error: result.error }, result.busy ? 409 : 400);
  return c.json({ package: { name: body.name, version: result.version }, ...result.status });
});

api.get("/workspaces/:id/files", async (c) => {
  const record = await ownWorkspace(c);
  return record ? c.json({ files: await workspace(c, record.id).listFiles() }) : noSuchWorkspace(c);
});

api.get("/workspaces/:id/files/:path{.+}", async (c) => {
  const record = await ownWorkspace(c);
  if (!record) return noSuchWorkspace(c);
  let path: string;
  try {
    path = normalisePath(c.req.param("path"));
  } catch {
    path = "";
  }
  // A path that can't be in the Workspace, or is kept for the Conversation, is a file it doesn't have.
  const file = path && !isHidden(path) ? await workspace(c, record.id).readFile(path) : null;
  if (!file) return c.json({ error: "There's no such file in the Workspace." }, 404);
  if ("binary" in file) return c.json({ error: "This file isn't text, so the editor can't open it." }, 415);
  return c.text(file.text, 200, { "content-type": "text/plain; charset=utf-8" });
});

api.post("/workspaces/:id/check", async (c) => {
  const record = await ownWorkspace(c);
  if (!record) return noSuchWorkspace(c);
  // The Workspace logs each Check, but can't time one: its clock doesn't move
  // during a Check. This times the call from here, where the call is I/O
  // (stage 2 in docs/findings.md).
  const started = Date.now();
  const log = { workspace: record.id, template: record.template };
  try {
    const report = await workspace(c, record.id).check();
    console.log(JSON.stringify({ event: "check-request", ...log, durationMs: Date.now() - started }));
    return c.json(report);
  } catch (error) {
    console.log(JSON.stringify({ event: "check-failed", ...log, durationMs: Date.now() - started, error: String(error) }));
    throw error;
  }
});

api.post("/workspaces/:id/build", async (c) => {
  const record = await ownWorkspace(c);
  if (!record) return noSuchWorkspace(c);
  // As for a Check: the Workspace logs each Build, and its clock can't time
  // one, so this times the call from here.
  const started = Date.now();
  const report = await workspace(c, record.id).build();
  const durationMs = Date.now() - started;
  const log = { event: "build-request", workspace: record.id, by: "developer", durationMs, ok: report.ok, cached: report.cached };
  console.log(JSON.stringify(log));
  return c.json(report);
});

api.get("/workspaces/:id/build", async (c) => {
  const record = await ownWorkspace(c);
  return record ? c.json(await workspace(c, record.id).latestBuild()) : noSuchWorkspace(c);
});

// Runs every test file (ADR 0017). As for a Check, the Workspace logs each
// run, and this times it.
api.post("/workspaces/:id/tests", async (c) => {
  const record = await ownWorkspace(c);
  if (!record) return noSuchWorkspace(c);
  const started = Date.now();
  const report = await workspace(c, record.id).runTests();
  const log = { event: "test-request", workspace: record.id, files: report.files.length, durationMs: Date.now() - started };
  console.log(JSON.stringify(log));
  return c.json(report);
});

api.get("/workspaces/:id/tests", async (c) => {
  const record = await ownWorkspace(c);
  return record ? c.json(await workspace(c, record.id).latestTests()) : noSuchWorkspace(c);
});

api.get("/workspaces/:id/preview", async (c) => {
  const record = await ownWorkspace(c);
  return record ? c.json(await workspace(c, record.id).preview()) : noSuchWorkspace(c);
});

api.get("/workspaces/:id/deployment", async (c) => {
  const record = await ownWorkspace(c);
  return record ? c.json(await workspace(c, record.id).deployment()) : noSuchWorkspace(c);
});

// Publishes in place of the Deployment whose Build is `replaces`, or none: the one the page shows.
api.post("/workspaces/:id/deployment", async (c) => {
  const record = await ownWorkspace(c);
  if (!record) return noSuchWorkspace(c);
  const body = await c.req.json<{ replaces?: unknown }>().catch(() => null);
  const replaces = typeof body?.replaces === "string" ? body.replaces : null;
  const result = await workspace(c, record.id).publish(replaces);
  return result.ok ? c.json(result.deployment) : c.json({ error: result.error }, 409);
});

// Secrets (ADR 0016): names in, names out. A value is never sent back.
api.get("/workspaces/:id/secrets", async (c) => {
  const record = await ownWorkspace(c);
  return record ? c.json({ secrets: await workspace(c, record.id).secretNames() }) : noSuchWorkspace(c);
});

api.put("/workspaces/:id/secrets/:name", async (c) => {
  const record = await ownWorkspace(c);
  if (!record) return noSuchWorkspace(c);
  const body = await c.req.json<{ value?: unknown }>().catch(() => null);
  const result = await workspace(c, record.id).setSecret(c.req.param("name"), body?.value);
  return result.ok ? c.body(null, 204) : c.json({ error: result.error }, 400);
});

api.delete("/workspaces/:id/secrets/:name", async (c) => {
  const record = await ownWorkspace(c);
  if (!record) return noSuchWorkspace(c);
  await workspace(c, record.id).removeSecret(c.req.param("name"));
  return c.body(null, 204);
});

// A sign-in link for the Preview pane's frame. A tab signs in through `/preview-sign-in`.
api.post("/workspaces/:id/preview/sign-in", async (c) => {
  const record = await ownWorkspace(c);
  if (!record) return noSuchWorkspace(c);
  const body = await c.req.json<{ to?: unknown }>().catch(() => null);
  const to = typeof body?.to === "string" ? body.to : "/";
  return c.json({ url: await workspace(c, record.id).previewSignIn("iframe", to) });
});

api.get("/workspaces/:id/preview/logs", async (c) => {
  const record = await ownWorkspace(c);
  return record ? c.json({ logs: await workspace(c, record.id).previewLogs() }) : noSuchWorkspace(c);
});

// What the page says beside the app about its Preview's problems (#104).
api.get("/workspaces/:id/preview/problems", async (c) => {
  const record = await ownWorkspace(c);
  return record ? c.json(await workspace(c, record.id).latestPreviewProblems()) : noSuchWorkspace(c);
});

api.get("/workspaces/:id/check", async (c) => {
  const record = await ownWorkspace(c);
  return record ? c.json(await workspace(c, record.id).latestCheck()) : noSuchWorkspace(c);
});

api.put("/workspaces/:id/files/:path{.+}", async (c) => {
  const record = await ownWorkspace(c);
  if (!record) return noSuchWorkspace(c);
  let path: string;
  try {
    path = normalisePath(c.req.param("path"));
  } catch {
    return c.json({ error: "That isn't a path inside the Workspace." }, 400);
  }
  if (isHidden(path)) return c.json({ error: "That path is kept for the Conversation." }, 400);
  const text = await c.req.text();
  if (new TextEncoder().encode(text).byteLength > maxFileBytes) {
    return c.json({ error: `A Workspace file can't be larger than ${maxFileBytes / 1_000_000} MB.` }, 413);
  }
  const result = await workspace(c, record.id).writeFile(path, text);
  return result.ok ? c.body(null, 204) : c.json({ error: result.error }, 409);
});

// The Conversation: the Agents SDK's own WebSocket protocol, straight to the
// Workspace's Durable Object. Its sockets follow every Turn as it runs.
api.get("/workspaces/:id/conversation", async (c) => {
  const record = await ownWorkspace(c);
  if (!record) return noSuchWorkspace(c);
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") return c.json({ error: "Connect with a WebSocket." }, 426);
  return workspace(c, record.id).fetch(c.req.raw);
});

// Starts a Turn with the Developer's `{ message }`, or, once they've added a
// Secret the Agent asked for, with the platform's note of its name: `{ secret }`.
api.post("/workspaces/:id/turns", async (c) => {
  const record = await ownWorkspace(c);
  if (!record) return noSuchWorkspace(c);
  const body = await c.req.json<{ message?: unknown; secret?: unknown }>().catch(() => null);
  const stub = workspace(c, record.id);
  let result;
  if (body?.secret !== undefined) {
    const secret = typeof body.secret === "string" ? body.secret : "";
    if (!(await stub.secretNames()).some(({ name }) => name === secret)) return c.json({ error: "There's no secret with that name. Save it first." }, 400);
    result = await stub.startTurn({ addedSecret: secret });
  } else {
    const message = typeof body?.message === "string" ? body.message.trim() : "";
    if (!message) return c.json({ error: "Write a message for the Agent." }, 400);
    result = await stub.startTurn(message);
  }
  return result.ok ? c.body(null, 202) : c.json({ error: result.error }, 409);
});

api.post("/workspaces/:id/conversation/start-fresh", async (c) => {
  const record = await ownWorkspace(c);
  if (!record) return noSuchWorkspace(c);
  const result = await workspace(c, record.id).startFresh();
  return result.ok ? c.body(null, 204) : c.json({ error: result.error }, 409);
});

api.all("*", (c) => c.json({ error: "Not found." }, 404));

/** A Content-Disposition header for a download, whatever characters the Workspace's name has. */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^A-Za-z0-9 ._-]/g, "-");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
