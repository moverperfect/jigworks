import type { BuildReport } from "../../src/shared/build-report.ts";
import type { AppLogEntry, PreviewProblems } from "../../src/shared/app-logs.ts";
import type { CheckReport } from "../../src/shared/check-report.ts";
import type { Deployment } from "../../src/shared/deployment.ts";
import type { Secret } from "../../src/shared/secret.ts";
import type { TestReport } from "../../src/shared/test-report.ts";

export interface Workspace {
  id: string;
  name: string;
  /** The Template's id, or null until the Agent starts the app. */
  template: string | null;
  /** ISO 8601. */
  createdAt: string;
  /** When a Turn, or the Developer's own save, last changed the app. ISO 8601. */
  changedAt: string;
  /** When the app was last published, or null if it never has been. ISO 8601. */
  publishedAt: string | null;
}

/** A failed API call. `status` is 0 when the platform couldn't be reached at all. */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }

  /** Whether the Developer's sign-in has expired, rather than the platform refusing them or failing. */
  get signedOut(): boolean {
    return this.status === 401;
  }
}

let signedOut = false;
const signedOutListeners = new Set<() => void>();

/**
 * Whether a request has found the Developer's sign-in expired. Only reloading
 * the page, which signs them in again, clears it.
 */
export function isSignedOut(): boolean {
  return signedOut;
}

/** Calls `listener` when a request first finds the sign-in expired. Returns a function that stops it. */
export function onSignedOutChange(listener: () => void): () => void {
  signedOutListeners.add(listener);
  return () => signedOutListeners.delete(listener);
}

/**
 * Asks the platform whether the Developer is still signed in. The
 * Conversation's socket does when it closes: a browser tells it nothing about
 * why, so Access's redirect looks like any dropped connection.
 */
export async function checkSignIn(): Promise<void> {
  if (!signedOut) await getMe().catch(() => {});
}

/** A failed request's error, once the page knows if it found the sign-in expired. */
function reportFailure(error: ApiError): ApiError {
  if (error.signedOut && !signedOut) {
    signedOut = true;
    for (const listener of signedOutListeners) listener();
  }
  return error;
}

export function toApiError(error: unknown): ApiError {
  return error instanceof ApiError ? error : new ApiError("Something went wrong. Try again.", 0);
}

/** Sends a request and returns its successful response, or throws an ApiError. */
async function send(method: string, path: string, body?: { type: string; text: string }): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: body && { "content-type": body.type },
      body: body?.text,
      // Access answers an expired sign-in with a redirect to its login page, which fetch can't follow.
      redirect: "manual",
    });
  } catch {
    throw new ApiError("Couldn't reach Jigworks. Check your connection and try again.", 0);
  }
  // `as string`: the tests check this file with Workers' types, which leave the browser's response types out.
  if ((response.type as string) === "opaqueredirect") throw reportFailure(new ApiError("Your sign-in has expired.", 401));
  if (!response.ok) throw reportFailure(new ApiError(await errorMessage(response), response.status));
  return response;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const json = body === undefined ? undefined : { type: "application/json", text: JSON.stringify(body) };
  const response = await send(method, path, json);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object" && "error" in body && typeof body.error === "string" && body.error) {
      return body.error;
    }
  } catch {
    // Not JSON, such as an error page from Access.
  }
  return `Something went wrong (HTTP ${response.status}). Try again.`;
}

const workspaceApiPath = (id: string) => `/api/workspaces/${encodeURIComponent(id)}`;

export async function getMe(): Promise<{ email: string }> {
  return request("GET", "/api/me");
}

export async function listWorkspaces(): Promise<Workspace[]> {
  const { workspaces } = await request<{ workspaces: Workspace[] }>("GET", "/api/workspaces");
  return workspaces;
}

export async function getWorkspace(id: string): Promise<Workspace> {
  const { workspace } = await request<{ workspace: Workspace }>("GET", workspaceApiPath(id));
  return workspace;
}

/** Creates an app from the Developer's description. Its first Turn is already running when this returns. */
export async function createWorkspace(message: string): Promise<Workspace> {
  const { workspace } = await request<{ workspace: Workspace }>("POST", "/api/workspaces", { message });
  return workspace;
}

/** Renames the app. Its address stays as it was. Fails with status 400, saying why, for a name it can't have. */
export async function renameWorkspace(id: string, name: string): Promise<Workspace> {
  const { workspace } = await request<{ workspace: Workspace }>("PATCH", workspaceApiPath(id), { name });
  return workspace;
}

export async function deleteWorkspace(id: string, confirmName: string): Promise<void> {
  await request<void>("DELETE", workspaceApiPath(id), { confirmName });
}

export function exportUrl(id: string): string {
  return `${workspaceApiPath(id)}/export`;
}

const fileApiPath = (id: string, path: string) =>
  `${workspaceApiPath(id)}/files/${path.split("/").map(encodeURIComponent).join("/")}`;

/** Every file's path from the Workspace's root, such as `src/index.ts`, sorted. Packages and attachments are left out. */
export async function listFiles(id: string): Promise<string[]> {
  const { files } = await request<{ files: string[] }>("GET", `${workspaceApiPath(id)}/files`);
  return files;
}

/** A file's text. A file that isn't UTF-8 text, such as an image, fails with status 415. */
export async function readFile(id: string, path: string): Promise<string> {
  return (await send("GET", fileApiPath(id, path))).text();
}

/** Saves a file's text. */
export async function writeFile(id: string, path: string, text: string): Promise<void> {
  await send("PUT", fileApiPath(id, path), { type: "text/plain; charset=utf-8", text });
}

/** Runs a Check and returns its report. */
export async function runCheck(id: string): Promise<CheckReport> {
  return request("POST", `${workspaceApiPath(id)}/check`);
}

/** The latest Check's report, or null if no Check has run yet. */
export async function getLatestCheck(id: string): Promise<CheckReport | null> {
  return request("GET", `${workspaceApiPath(id)}/check`);
}

/** Runs a Build and returns its report. A Build goes ahead whatever the Check found. */
export async function runBuild(id: string): Promise<BuildReport> {
  return request("POST", `${workspaceApiPath(id)}/build`);
}

/** The latest Build's report, or null if no Build has run yet. */
export async function getLatestBuild(id: string): Promise<BuildReport | null> {
  return request("GET", `${workspaceApiPath(id)}/build`);
}

/** Runs every test file and returns the report. */
export async function runTests(id: string): Promise<TestReport> {
  return request("POST", `${workspaceApiPath(id)}/tests`);
}

/** The latest run of every test file, or null if the tests haven't run yet. */
export async function getLatestTests(id: string): Promise<TestReport | null> {
  return request("GET", `${workspaceApiPath(id)}/tests`);
}

/** Where the Preview answers, and the hash of the Build it runs, the latest successful one. Before there's one, it answers 503. */
export async function getPreview(id: string): Promise<{ url: string; ready: boolean; hash: string | null }> {
  return request("GET", `${workspaceApiPath(id)}/preview`);
}

/** A single-use link, good for 60 seconds, that signs the Preview pane's frame in and then shows `to`. */
export async function previewFrameLink(id: string, to: string): Promise<string> {
  const { url } = await request<{ url: string }>("POST", `${workspaceApiPath(id)}/preview/sign-in`, { to });
  return url;
}

/** The platform page that signs the Developer in to the Preview in a tab of its own, then shows `to`. */
export function previewTabUrl(host: string, to: string): string {
  return `/preview-sign-in?host=${encodeURIComponent(host)}&to=${encodeURIComponent(to)}`;
}

export type { AppLogEntry, Deployment };

export type { Secret };

export async function listSecrets(id: string): Promise<Secret[]> {
  const { secrets } = await request<{ secrets: Secret[] }>("GET", `${workspaceApiPath(id)}/secrets`);
  return secrets;
}

/** Adds or replaces a secret. Fails with status 400, saying why, for a name or value the app couldn't use. */
export async function setSecret(id: string, name: string, value: string): Promise<void> {
  await request<void>("PUT", `${workspaceApiPath(id)}/secrets/${encodeURIComponent(name)}`, { value });
}

export async function removeSecret(id: string, name: string): Promise<void> {
  await request<void>("DELETE", `${workspaceApiPath(id)}/secrets/${encodeURIComponent(name)}`);
}

/** Where the Deployment answers, and when it was last published. */
export async function getDeployment(id: string): Promise<Deployment> {
  return request("GET", `${workspaceApiPath(id)}/deployment`);
}

/**
 * Publishes the Build the Preview runs as the Deployment, in place of the one
 * whose Build is `replaces`, or none. Fails with status 409 if the Deployment
 * has changed since, during a Turn, or before the first successful Build.
 */
export async function publish(id: string, replaces: string | null): Promise<Deployment> {
  return request("POST", `${workspaceApiPath(id)}/deployment`, { replaces });
}

/** The Preview's newest 100 log lines, oldest first. */
export async function getPreviewLogs(id: string): Promise<AppLogEntry[]> {
  const { logs } = await request<{ logs: AppLogEntry[] }>("GET", `${workspaceApiPath(id)}/preview/logs`);
  return logs;
}

/** The Build the Preview runs, and its errors and warnings since it took it (#104). */
export async function getPreviewProblems(id: string): Promise<PreviewProblems> {
  return request<PreviewProblems>("GET", `${workspaceApiPath(id)}/preview/problems`);
}

/** The Conversation socket's path, for `useAgent`'s `basePath`, which takes it without the leading slash. */
export const conversationBasePath = (id: string) => `${workspaceApiPath(id).slice(1)}/conversation`;

/**
 * Starts a Turn for the Developer's message, or, once they've added the
 * Secret the Agent asked for, `{ secret }` with its name. The Turn itself
 * arrives on the Conversation socket.
 */
export async function startTurn(id: string, message: string | { secret: string }): Promise<void> {
  const body = typeof message === "string" ? { message } : message;
  // The platform answers 202 with no body, which `request` can't read.
  await send("POST", `${workspaceApiPath(id)}/turns`, { type: "application/json", text: JSON.stringify(body) });
}

/** Summarises the Conversation into one message, which the Agent carries on from. */
export async function startFresh(id: string): Promise<void> {
  await request<void>("POST", `${workspaceApiPath(id)}/conversation/start-fresh`);
}
