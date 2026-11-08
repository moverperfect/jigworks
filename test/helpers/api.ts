import { exports } from "cloudflare:workers";
import { expect } from "vitest";
import type { WorkspaceRecord } from "../../src/developer";
import { accessToken, testAccess } from "./access";

// The platform as a browser sees it: requests to /api with an Access token
// and the platform's own Origin, as the pages send them.

export interface CallOptions {
  method?: string;
  /** JSON, unless `text` is given. */
  body?: unknown;
  /** A plain-text body, such as a file's contents. */
  text?: string;
  email?: string;
  token?: string | null;
  origin?: string | null;
  /** The browser's `Sec-Fetch-Site`, which the pages send as "same-origin". */
  site?: string | null;
}

export async function call(
  path: string,
  { method = "GET", body, text, email, token, origin = testAccess.origin, site = "same-origin" }: CallOptions = {},
): Promise<Response> {
  const headers = new Headers();
  const jwt = token === undefined ? await accessToken({ email: email ?? testAccess.developer }) : token;
  if (jwt) headers.set("Cf-Access-Jwt-Assertion", jwt);
  if (origin) headers.set("Origin", origin);
  if (site) headers.set("Sec-Fetch-Site", site);
  if (body !== undefined) headers.set("content-type", "application/json");
  if (text !== undefined) headers.set("content-type", "text/plain; charset=utf-8");
  return exports.default.fetch(
    new Request(`${testAccess.origin}${path}`, {
      method,
      headers,
      body: text ?? (body === undefined ? undefined : JSON.stringify(body)),
    }),
  );
}

/** Creates a Workspace, from the Worker Template unless `template` names another. */
export async function create(name: string, email?: string, template = "worker"): Promise<WorkspaceRecord> {
  const response = await call("/api/workspaces", { method: "POST", body: { name, template }, email });
  expect(response.status).toBe(201);
  return (await response.json<{ workspace: WorkspaceRecord }>()).workspace;
}

/** Creates a Workspace from the Developer's message, as the start page does. Its first Turn starts at once. */
export async function createFromMessage(message: string): Promise<WorkspaceRecord> {
  const response = await call("/api/workspaces", { method: "POST", body: { message } });
  expect(response.status).toBe(201);
  return (await response.json<{ workspace: WorkspaceRecord }>()).workspace;
}

/** Reads until `done` says the value is ready, for up to about five seconds, then returns the last read. */
export async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return read();
}
