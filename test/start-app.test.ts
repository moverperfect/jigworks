import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { WorkspaceRecord } from "../src/developer";
import { maxRetries } from "../src/shared/conversation";
import { call, create, createFromMessage } from "./helpers/api";
import { connect, firstTurnEnd, history, runTurn, turnEnd } from "./helpers/conversation";
import type { UIMessage } from "ai";

// A new app starts from the Developer's message, and the Agent starts it
// with start_app (ADR 0018). The model is the scripted one in
// test/fixtures/agent-scripts.ts.

const startAppFirst = "The app hasn't started yet, so this tool can't run. Start it first with start_app.";

const listed = async (id: string) => {
  const { workspaces } = await (await call("/api/workspaces")).json<{ workspaces: WorkspaceRecord[] }>();
  return workspaces.find((workspace) => workspace.id === id);
};
const files = async (id: string) => (await call(`/api/workspaces/${id}/files`)).json<{ files: string[] }>();
const latest = async (id: string, report: "check" | "build") => (await call(`/api/workspaces/${id}/${report}`)).json();

/** What each tool call in the Agent's messages returned, or the error it failed with, in order. */
async function toolResults(id: string): Promise<{ tool: string; result: unknown }[]> {
  return (await history(id))
    .flatMap((message: UIMessage) => message.parts)
    .filter((part) => part.type.startsWith("tool-"))
    .map((part) => {
      const tool = part as { type: string; output?: unknown; errorText?: string };
      return { tool: tool.type.slice("tool-".length), result: tool.errorText ?? tool.output };
    });
}

describe("creating a Workspace from a message", () => {
  it("lists an empty Workspace named New app, and starts its first Turn with the message", async () => {
    const workspace = await createFromMessage("[script:slow] A sign-up sheet for my running club");
    expect(workspace).toMatchObject({ name: "New app", template: null });
    expect(await listed(workspace.id)).toEqual(workspace);
    expect(await files(workspace.id)).toEqual({ files: [] });

    const conversation = await connect(workspace.id);
    const first = await conversation.next((frame) => frame.type === "cf_agent_state");
    expect(first.state?.turn).not.toBeNull();
    const ended = await turnEnd(conversation, 0);
    const [message] = await history(workspace.id);
    expect(message).toMatchObject({ role: "user", parts: [{ type: "text", text: "[script:slow] A sign-up sheet for my running club" }] });

    // A Turn that didn't start the app has nothing to check, build or test.
    expect(ended).toMatchObject({ status: "completed", startedApp: false, noApp: true, checkErrors: null, buildErrors: null, testFailures: null });
    expect(await latest(workspace.id, "check")).toBeNull();
    expect(await latest(workspace.id, "build")).toBeNull();
  });

  it("refuses a message with nothing in it", async () => {
    const response = await call("/api/workspaces", { method: "POST", body: { message: "  " } });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Say what you'd like to make." });
  });

  it("refuses the Developer's files, Packages and Secrets until the app has started", async () => {
    // say-hello never starts the app.
    const workspace = await createFromMessage("[script:say-hello] Hi");
    // While its Turn runs, they're refused for that instead.
    const conversation = await connect(workspace.id);
    await conversation.next((frame) => frame.type === "cf_agent_state" && frame.state?.turn === null);
    const notStarted = { error: "Your app hasn't started yet. Wait for the Agent to start it." };
    const changes = [
      call(`/api/workspaces/${workspace.id}/files/src/index.ts`, { method: "PUT", text: "export {};\n" }),
      call(`/api/workspaces/${workspace.id}/packages`, { method: "POST", body: { name: "@fake/a" } }),
      call(`/api/workspaces/${workspace.id}/secrets/API_KEY`, { method: "PUT", body: { value: "x" } }),
    ];
    for (const response of await Promise.all(changes)) {
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(await response.json()).toEqual(notStarted);
    }
    expect(await files(workspace.id)).toEqual({ files: [] });
  });
});

describe("start_app", () => {
  it("starts the app from the Template the Agent chose, names it, and makes its address from the name", async () => {
    const workspace = await createFromMessage("[script:start-app] A sign-up sheet for my running club");
    const ended = await firstTurnEnd(workspace.id);
    expect(ended).toMatchObject({ status: "completed", startedApp: true, noApp: false, checkErrors: 0, buildErrors: 0, retries: 0 });

    expect(await listed(workspace.id)).toEqual({ ...workspace, name: "Sunday Runs", template: "worker" });
    expect((await files(workspace.id)).files).toEqual(expect.arrayContaining(["AGENTS.md", "package.json", "src/index.ts"]));
    const preview = await (await call(`/api/workspaces/${workspace.id}/preview`)).json();
    expect(preview).toMatchObject({ url: expect.stringMatching(/^https:\/\/sunday-runs-[a-z0-9]{8}-preview\./), ready: true });

    // The Turn's instructions predate the app's AGENTS.md, so start_app gives it.
    const [started] = await toolResults(workspace.id);
    expect(started).toEqual({ tool: "start_app", result: expect.stringContaining("Started Sunday Runs from the worker Template.") });
    expect(started!.result).toContain("<agents-md>\n# This Workspace");
  });

  it("refuses the other file tools until the app has started", async () => {
    const workspace = await createFromMessage("[script:write-before-start] A sign-up sheet");
    const ended = await firstTurnEnd(workspace.id);
    expect(ended).toMatchObject({ startedApp: true, checkErrors: 0 });
    expect(await toolResults(workspace.id)).toEqual([
      { tool: "write", result: startAppFirst },
      { tool: "start_app", result: expect.stringContaining("Started Sunday Runs") },
    ]);
    expect((await files(workspace.id)).files).not.toContain("src/count.ts");
  });

  it("refuses every tool that changes, checks, builds or tests files before then", async () => {
    const workspace = await createFromMessage("[script:use-tools-before-start] Anything");
    await firstTurnEnd(workspace.id);
    const results = await toolResults(workspace.id);
    expect(results.map(({ tool }) => tool)).toEqual(["write", "edit", "delete", "bash", "add_package", "check", "build", "test"]);
    expect(results.map(({ result }) => result)).toEqual(Array(8).fill(startAppFirst));
    expect(await files(workspace.id)).toEqual({ files: [] });
    // Refused tools are counted as finished, so a later check or build doesn't wait for them.
    await runInDurableObject(env.WORKSPACES.getByName(workspace.id), (instance) => {
      expect((instance as unknown as { toolsRunning: number }).toolsRunning).toBe(0);
    });
  });

  it("is refused in a Workspace that has files", async () => {
    const workspace = await create("Already started");
    const ended = await runTurn(workspace.id, await connect(workspace.id), "[script:start-app] Start again");
    expect(ended).toMatchObject({ startedApp: false, noApp: false });
    expect(await toolResults(workspace.id)).toEqual([
      { tool: "start_app", result: "Couldn't start the app. The app has already started." },
    ]);
    expect(await listed(workspace.id)).toEqual(workspace);
  });

  it("is refused once the app has started, even after the Agent deletes every file", async () => {
    const workspace = await create("Emptied");
    const ended = await runTurn(workspace.id, await connect(workspace.id), "[script:empty-then-start] Start over");
    expect(await toolResults(workspace.id)).toEqual([
      { tool: "bash", result: expect.anything() },
      { tool: "start_app", result: "Couldn't start the app. The app has already started." },
    ]);
    expect(await files(workspace.id)).toEqual({ files: [] });
    // The app is still started, so the Turn ended with its Check and Build, and their retries.
    expect(ended).toMatchObject({ startedApp: false, noApp: false, retries: maxRetries });
    expect(ended.buildErrors).toBeGreaterThan(0);
    expect(await listed(workspace.id)).toEqual(workspace);
  });
});
