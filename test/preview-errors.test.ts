import type { UIMessage } from "ai";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { describePreviewTry } from "../src/agent";
import type { MessageMetadata } from "../src/shared/conversation";
import { buildableIndex } from "./fixtures/agent-scripts";
import { call, create } from "./helpers/api";
import { connect, history, runTurn, textOf, turnLines } from "./helpers/conversation";

// The Agent sees the Preview's errors and warnings after each Build that
// changes it (#45): the platform tries it with GET /, waits for its logs, and
// tells the Agent, in the build tool's result or after its Turn.

const fileText = async (id: string, path: string) => (await call(`/api/workspaces/${id}/files/${path}`)).text();

/** Runs a Turn and returns its log line with the Agent's last reply. */
const turn = async (id: string, message: string) => {
  const conversation = await connect(id);
  const [line] = await turnLines(() => runTurn(id, conversation, message));
  conversation.close();
  const messages = await history(id);
  return { line: line!, messages, reply: textOf(messages.findLast((message) => message.role === "assistant")!) };
};

const fromPlatform = (messages: UIMessage<MessageMetadata>[]) => messages.filter((message) => message.metadata?.from === "check");

describe("the build tool", () => {
  it("adds what the new Preview answered GET / with, and the error it logged", async () => {
    const workspace = await create("Throws");
    const { line, reply, messages } = await turn(workspace.id, "[script:build-throwing] Show the list");
    expect(reply).toContain("The Build succeeded.\nThe platform tried the Preview with GET /, which answered 500. Since this Build, it has logged 1 error:\n");
    expect(reply).toMatch(/\S+ server error: .*The list is missing/);
    // The Agent saw them, so the Turn's own Build, the same one, doesn't tell it again.
    expect(fromPlatform(messages)).toEqual([]);
    expect(line).toMatchObject({ retries: 0, previewTries: 1, previewErrors: 1, previewWarnings: 0, previewRetries: 0 });
  });

  it("adds a warning the new Preview logged", async () => {
    const workspace = await create("Warns");
    const { line, reply } = await turn(workspace.id, "[script:build-warning] Say hi");
    expect(reply).toContain("which answered 200. Since this Build, it has logged 1 warning:\n");
    expect(reply).toMatch(/\S+ server warn: No greeting set, so saying hi/);
    expect(line).toMatchObject({ retries: 0, previewWarnings: 1, previewErrors: 0 });
  });

  it("says plainly when the new Preview logged nothing", async () => {
    const workspace = await create("Clean");
    const { line, reply } = await turn(workspace.id, "[script:build-clean] Say hi");
    expect(reply).toContain("The Build succeeded.\nThe platform tried the Preview with GET /, which answered 200. It has logged no errors or warnings since this Build.");
    expect(line).toMatchObject({ retries: 0, previewTries: 1, previewErrors: 0, previewWarnings: 0 });
  });
});

describe("the end of a Turn", () => {
  it("tells the Agent what the new Preview logged, as a retry, and it fixes it", async () => {
    const workspace = await create("Fixes it");
    const { line, reply, messages } = await turn(workspace.id, "[script:throw-then-fix] Show the list");
    expect(reply).toBe("Fixed it.");
    expect(await fileText(workspace.id, "src/index.ts")).toBe(buildableIndex);
    const told = fromPlatform(messages);
    expect(told.map((message) => message.metadata)).toEqual([{ from: "check", errors: 0, buildErrors: 0, retry: 1 }]);
    expect(textOf(told[0]!)).toMatch(
      /^After your Turn, the Preview logged 1 error when the platform tried it\. Fix any that need it\. If none do, change nothing and end your Turn\. This is retry 1 of 3\.\n\nThe platform tried the Preview with GET \/, which answered 500\./,
    );
    // The fix's Build is tried too, and is clean.
    expect(line).toMatchObject({ retries: 1, previewTries: 2, previewErrors: 1, previewRetries: 1 });
  });

  it("tells the Agent alongside the Check's errors, which the retry is counted for", async () => {
    const workspace = await create("Both");
    const { line, reply, messages } = await turn(workspace.id, "[script:break-and-throw-then-fix] Count the list");
    expect(reply).toBe("Fixed both.");
    expect(textOf(fromPlatform(messages)[0]!)).toMatch(
      /^After your Turn, the Check found 1 error and the Preview logged 1 error when the platform tried it\. Fix the errors, and any of the Preview's that need it\. This is retry 1 of 3\./,
    );
    expect(line).toMatchObject({ retries: 1, previewErrors: 1, previewRetries: 0 });
  });

  it("doesn't send the Agent round again for a warning it leaves", async () => {
    const workspace = await create("Leaves it");
    const { line, reply, messages } = await turn(workspace.id, "[script:warn-and-leave] Say hi");
    expect(reply).toBe("The warning is harmless.");
    expect(fromPlatform(messages)).toHaveLength(1);
    expect(line).toMatchObject({ status: "completed", retries: 1, previewTries: 1, previewWarnings: 1, previewRetries: 1 });
  });

  it("tells the Agent nothing when the new Preview logged nothing", async () => {
    const workspace = await create("Says hello");
    const { line, messages } = await turn(workspace.id, "[script:say-hello] Hi");
    expect(fromPlatform(messages)).toEqual([]);
    expect(line).toMatchObject({ retries: 0, previewTries: 1, previewErrors: 0, previewWarnings: 0, previewRetries: 0 });
  });
});

describe("a Turn that ends with a question", () => {
  it("leaves the new Preview untried, so the Turn after the answer tries it", async () => {
    const workspace = await create("Asks");
    const asked = await turn(workspace.id, "[script:warn-and-ask] Greet people");
    expect(asked.line).toMatchObject({ asked: "question", retries: 0, previewTries: 0 });

    const answered = await turn(workspace.id, "Hi");
    expect(answered.reply).toBe("The warning is harmless.");
    expect(answered.line).toMatchObject({ retries: 1, previewTries: 1, previewWarnings: 1, previewRetries: 1 });
  });
});

describe("a try of the Preview, as the Agent reads it", () => {
  it("says when GET / got no answer, rather than giving the platform's own status", () => {
    expect(describePreviewTry({ status: null, waitSeconds: 5, problems: [] })).toBe(
      "The platform tried the Preview with GET /, which didn't answer within 5 seconds. It has logged no errors or warnings since this Build.",
    );
  });
});

describe("the Preview's problems since a Build", () => {
  it("are its errors and warnings logged after it took the Build, not before, nor the Deployment's", async () => {
    const workspace = await create("Since");
    const host = env.APP_HOSTS.getByName(await env.WORKSPACES.getByName(workspace.id).appLabel());
    const before = await (await call(`/api/workspaces/${workspace.id}/build`, { method: "POST" })).json<{ hash: string }>();
    await host.log("preview", "server", [{ level: "error", message: "from the Template's Build" }]);

    expect((await call(`/api/workspaces/${workspace.id}/files/src/index.ts`, { method: "PUT", text: buildableIndex })).status).toBe(204);
    const { hash } = await (await call(`/api/workspaces/${workspace.id}/build`, { method: "POST" })).json<{ hash: string }>();
    await host.log("preview", "server", [
      { level: "log", message: "just saying" },
      { level: "info", message: "still just saying" },
      { level: "warn", message: "careful" },
      { level: "exception", message: "Error: broke" },
    ]);
    await host.log("deployment", "server", [{ level: "error", message: "the Deployment's" }]);
    await host.log("preview", "browser", [{ level: "unhandledrejection", message: "the page broke" }]);

    const problems = await env.WORKSPACES.getByName(workspace.id).previewProblems(hash);
    expect(problems?.map(({ source, level, message }) => [source, level, message])).toEqual([
      ["server", "warn", "careful"],
      ["server", "exception", "Error: broke"],
      ["browser", "unhandledrejection", "the page broke"],
    ]);
    // The Preview runs the newer Build now.
    expect(await env.WORKSPACES.getByName(workspace.id).previewProblems(before.hash)).toBeNull();
  });
});

describe("the Preview's problems, for the page", () => {
  it("are those since the Build it runs, with that Build's hash, and none before it has one (#104)", async () => {
    const workspace = await create("For the page");
    const read = async () => (await call(`/api/workspaces/${workspace.id}/preview/problems`)).json<{ hash: string | null; problems: { level: string; message: string }[] }>();
    expect(await read()).toEqual({ hash: null, problems: [] });

    const host = env.APP_HOSTS.getByName(await env.WORKSPACES.getByName(workspace.id).appLabel());
    const { hash } = await (await call(`/api/workspaces/${workspace.id}/build`, { method: "POST" })).json<{ hash: string }>();
    await host.log("preview", "server", [
      { level: "log", message: "just saying" },
      { level: "error", message: "Resend refused the email: API key is invalid" },
    ]);
    expect(await read()).toEqual({ hash, problems: [expect.objectContaining({ source: "server", level: "error", message: "Resend refused the email: API key is invalid" })] });
  });

  it("start afresh when a Secret changes, as the app then runs with it, though its Build is the same", async () => {
    const workspace = await create("Key changed");
    const read = async () => (await call(`/api/workspaces/${workspace.id}/preview/problems`)).json<{ hash: string | null; problems: { message: string }[] }>();
    const host = env.APP_HOSTS.getByName(await env.WORKSPACES.getByName(workspace.id).appLabel());
    const { hash } = await (await call(`/api/workspaces/${workspace.id}/build`, { method: "POST" })).json<{ hash: string }>();
    await host.log("preview", "server", [{ level: "error", message: "The email wasn't sent: the Secret RESEND_API_KEY hasn't been set yet." }]);

    expect((await call(`/api/workspaces/${workspace.id}/secrets/RESEND_API_KEY`, { method: "PUT", body: { value: "re_made_up" } })).status).toBe(204);
    expect(await read()).toEqual({ hash, problems: [] });
    await host.log("preview", "server", [{ level: "error", message: "Resend refused the email: API key is invalid" }]);
    expect((await read()).problems.map(({ message }) => message)).toEqual(["Resend refused the email: API key is invalid"]);

    expect((await call(`/api/workspaces/${workspace.id}/secrets/RESEND_API_KEY`, { method: "DELETE" })).status).toBe(204);
    expect(await read()).toEqual({ hash, problems: [] });
  });
});
