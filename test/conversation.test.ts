import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { CheckReport } from "../src/workspace";
import { brokenCount, buildableIndex, fixedCount } from "./fixtures/agent-scripts";
import { summaryReply } from "./fixtures/fake-anthropic";
import { call, create } from "./helpers/api";
import { testAccess } from "./helpers/access";
import { connect, history, runTurn, startTurn, textOf, turnEnd, turnStart, upgrade } from "./helpers/conversation";

// Turns, through the platform's WebSocket and HTTP interface. The model is the
// scripted one in test/fixtures/agent-scripts.ts, behind a fake Anthropic API.

const latestCheck = async (id: string) => (await call(`/api/workspaces/${id}/check`)).json<CheckReport>();
const fileText = async (id: string, path: string) => (await call(`/api/workspaces/${id}/files/${path}`)).text();

describe("a Turn", () => {
  it("streams to the Conversation socket, ends with a clean Check, and is kept", async () => {
    const workspace = await create("Hello");
    const conversation = await connect(workspace.id);
    const ended = await runTurn(workspace.id, conversation, "[script:say-hello] Hi");
    expect(ended).toMatchObject({ status: "completed", error: null, checkErrors: 0, retries: 0, outOfSteps: false });
    expect(conversation.frames.some((frame) => frame.type === "cf_agent_use_chat_response")).toBe(true);
    conversation.close();

    const messages = await history(workspace.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[0]!.metadata).toEqual({ from: "developer", changedFiles: [] });
    expect(textOf(messages[1]!)).toBe("Hello from the scripted model.");
    expect(await latestCheck(workspace.id)).toMatchObject({ counts: { error: 0 } });
  });

  it("sends the model AGENTS.md, the files the Developer changed, the platform's tools and its settings", async () => {
    const workspace = await create("Instructions");
    const save = await call(`/api/workspaces/${workspace.id}/files/src/notes.md`, { method: "PUT", text: "# Notes\n" });
    expect(save.status).toBe(204);
    const conversation = await connect(workspace.id);

    await runTurn(workspace.id, conversation, "[script:report-request] What were you told?");
    const [, first] = await history(workspace.id);
    const sent = JSON.parse(textOf(first!)) as Record<string, unknown> & { system: string; latest: string };
    expect(sent).toMatchObject({
      model: "claude-opus-5-5",
      cacheControl: true,
      effort: "high",
      fallbacks: "default",
      thinking: { block_binding: { prefix_mismatch_behavior: "drop_block" } },
    });
    expect(sent.system).toContain("You are the Agent on a development platform");
    expect(sent.system).toContain("<agents-md>\n# This Workspace");
    expect(sent.latest).toContain("the Developer changed /src/notes.md");
    expect(sent.tools).toEqual(
      expect.arrayContaining(["add_package", "bash", "check", "edit", "list", "preview_logs", "read", "request_preview", "write"]),
    );

    // The note is for the Turn after the change only.
    await runTurn(workspace.id, conversation, "And now?");
    const messages = await history(workspace.id);
    expect(JSON.parse(textOf(messages.at(-1)!)).latest).not.toContain("the Developer changed");
    expect(messages[0]!.metadata).toEqual({ from: "developer", changedFiles: ["src/notes.md"] });
  });

  it("gives the Agent more tries when the Check finds errors, until it's clean", async () => {
    const workspace = await create("Fixed");
    const conversation = await connect(workspace.id);
    const ended = await runTurn(workspace.id, conversation, "[script:break-then-fix] Add a count");
    expect(ended).toMatchObject({ status: "completed", checkErrors: 0, retries: 1 });
    expect(await fileText(workspace.id, "src/count.ts")).toBe(fixedCount);
    expect(await latestCheck(workspace.id)).toMatchObject({ counts: { error: 0 } });

    const fromCheck = (await history(workspace.id)).filter((message) => message.metadata?.from === "check");
    expect(fromCheck.map((message) => message.metadata)).toEqual([{ from: "check", errors: 1, buildErrors: 0, retry: 1 }]);
    expect(textOf(fromCheck[0]!)).toContain("/src/count.ts:1:14 error TS2322");
  });

  it("gives the Agent more tries when the Build fails, even when the Check is clean", async () => {
    const workspace = await create("Build fixed");
    const conversation = await connect(workspace.id);
    const ended = await runTurn(workspace.id, conversation, "[script:break-build-then-fix] Change the entry point");
    expect(ended).toMatchObject({ status: "completed", checkErrors: 0, buildErrors: 0, retries: 1 });
    expect(await fileText(workspace.id, "src/index.ts")).toBe(buildableIndex);

    const fromCheck = (await history(workspace.id)).filter((message) => message.metadata?.from === "check");
    expect(fromCheck.map((message) => message.metadata)).toEqual([{ from: "check", errors: 0, buildErrors: 1, retry: 1 }]);
    expect(textOf(fromCheck[0]!)).toContain('imports "left-pad"');
    const report = await (await call(`/api/workspaces/${workspace.id}/build`)).json<{ ok: boolean }>();
    expect(report.ok).toBe(true);
  });

  it("stops after three more tries, leaving the errors in the problems list", async () => {
    const workspace = await create("Unfixed");
    const conversation = await connect(workspace.id);
    const ended = await runTurn(workspace.id, conversation, "[script:never-fixes] Add a count");
    expect(ended).toMatchObject({ status: "completed", checkErrors: 1, retries: 3 });
    expect(await fileText(workspace.id, "src/count.ts")).toBe(brokenCount);
    expect(await latestCheck(workspace.id)).toMatchObject({ counts: { error: 1 } });
    const retries = (await history(workspace.id)).flatMap((message) =>
      message.metadata?.from === "check" ? [message.metadata.retry] : [],
    );
    expect(retries).toEqual([1, 2, 3]);
  });

  it("stops the model after 40 steps", async () => {
    const workspace = await create("Steps");
    const conversation = await connect(workspace.id);
    const ended = await runTurn(workspace.id, conversation, "[script:keep-going] List the files");
    expect(ended).toMatchObject({ checkErrors: 0, retries: 0, outOfSteps: true });
    const [, reply] = await history(workspace.id);
    expect(reply!.parts.filter((part) => part.type === "tool-list")).toHaveLength(40);
  });

  it("gives no more tries once the Turn has used its 40 steps", async () => {
    const workspace = await create("Spent");
    const conversation = await connect(workspace.id);
    const ended = await runTurn(workspace.id, conversation, "[script:break-and-keep-going] Add a count");
    expect(ended).toMatchObject({ checkErrors: 1, retries: 0, outOfSteps: true });
    expect(await history(workspace.id)).toHaveLength(2);
  });
});

describe("the Agent's own tools", () => {
  it("adds a Package with add_package", async () => {
    const workspace = await create("Add");
    const conversation = await connect(workspace.id);
    await runTurn(workspace.id, conversation, "[script:add-package] Add @fake/a");
    const [, reply] = await history(workspace.id);
    expect(textOf(reply!)).toMatch(/^The tool said: Added @fake\/a \d+\.\d+\.\d+\./);
    const status = await (await call(`/api/workspaces/${workspace.id}/packages`)).json<{ packages: { name: string }[] }>();
    expect(status.packages.map((p) => p.name)).toContain("@fake/a");
  });

  it("builds the Workspace with build, which returns the Build's errors", async () => {
    const workspace = await create("Build tool");
    const conversation = await connect(workspace.id);
    await runTurn(workspace.id, conversation, "[script:use-build] Build");
    const [, reply] = await history(workspace.id);
    expect(textOf(reply!)).toBe("The tool said: The Build succeeded.");

    const save = await call(`/api/workspaces/${workspace.id}/files/src/index.ts`, { method: "PUT", text: "export default { fetch: ( };\n" });
    expect(save.status).toBe(204);
    await runTurn(workspace.id, conversation, "Build again");
    const replies = (await history(workspace.id)).filter((message) => message.role === "assistant");
    expect(textOf(replies[1]!)).toMatch(/^The tool said: The Build failed:\n\/src\/index\.ts:1:\d+: /);
  });

  it("tries the Preview with request_preview, and reads its logs with preview_logs", async () => {
    const loggingIndex = `export default {
  fetch: (request: Request) => {
    console.log("serving", new URL(request.url).pathname);
    return Response.json({ message: "Hello, Agent" });
  },
};
`;
    // The fake model takes its script from a Conversation's first message, so each tool gets a Workspace.
    const [trying, reading] = [await create("Preview request"), await create("Preview logs")];
    for (const workspace of [trying, reading]) {
      expect((await call(`/api/workspaces/${workspace.id}/files/src/index.ts`, { method: "PUT", text: loggingIndex })).status).toBe(204);
      expect((await call(`/api/workspaces/${workspace.id}/build`, { method: "POST" })).status).toBe(200);
    }

    await runTurn(trying.id, await connect(trying.id), "[script:request-preview] Try it");
    const [, tried] = await history(trying.id);
    expect(textOf(tried!)).toMatch(/^The tool said: 200\n[^]*content-type: application\/json[^]*\n\n\{"message":"Hello, Agent"\}$/);

    await env.WORKSPACES.getByName(reading.id).requestPreview({ method: "GET", path: "/api/hello/Agent" });
    // Server logs arrive from the Dynamic Worker's tail a moment later.
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((await env.WORKSPACES.getByName(reading.id).previewLogs()).length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await runTurn(reading.id, await connect(reading.id), "[script:read-preview-logs] What did it log?");
    const [, read] = await history(reading.id);
    expect(textOf(read!)).toMatch(/^The tool said: \S+ server log: serving \/api\/hello\/Agent$/);
  });

  it("runs a check called in the same step as an edit after the edit", async () => {
    const workspace = await create("Same step");
    const conversation = await connect(workspace.id);
    await runTurn(workspace.id, conversation, "[script:write-and-check] Add a count");
    const [, reply] = await history(workspace.id);
    expect(textOf(reply!)).toContain("/src/count.ts:1:14 error TS2322");
  });

  it("runs a build called in the same step as bash after bash has written its changes", async () => {
    const workspace = await create("Bash then build");
    const conversation = await connect(workspace.id);
    await runTurn(workspace.id, conversation, "[script:bash-and-build] Break it");
    const [, reply] = await history(workspace.id);
    expect(textOf(reply!)).toMatch(/The Build failed:\n\/src\/index\.ts:1:\d+: /);
  });

  it("reports a Package it couldn't add as a failed call", async () => {
    const workspace = await create("Add missing");
    const conversation = await connect(workspace.id);
    await runTurn(workspace.id, conversation, "[script:add-missing-package] Add @fake/missing");
    const [, reply] = await history(workspace.id);
    expect(reply!.parts.find((part) => part.type === "tool-add_package")).toMatchObject({
      state: "output-error",
      errorText: expect.stringContaining("Couldn't add @fake/missing"),
    });
  });

  it("runs a Check with check", async () => {
    const workspace = await create("Check tool");
    const conversation = await connect(workspace.id);
    await runTurn(workspace.id, conversation, "[script:use-check] Check");
    const [, reply] = await history(workspace.id);
    expect(textOf(reply!)).toBe("The tool said: The Check found no problems.");
  });
});

describe("the Turn lock", () => {
  it("refuses the Developer's changes, other Turns and Start fresh while a Turn runs", async () => {
    const workspace = await create("Locked");
    const conversation = await connect(workspace.id);
    const from = conversation.frames.length;
    expect((await startTurn(workspace.id, "[script:slow] Take your time")).status).toBe(202);
    await turnStart(conversation, from);

    const refused = [
      await call(`/api/workspaces/${workspace.id}/files/src/index.ts`, { method: "PUT", text: "export {};\n" }),
      await call(`/api/workspaces/${workspace.id}/packages`, { method: "POST", body: { name: "@fake/a" } }),
      await startTurn(workspace.id, "Another"),
      await call(`/api/workspaces/${workspace.id}/conversation/start-fresh`, { method: "POST" }),
    ];
    expect(refused.map((response) => response.status)).toEqual([409, 409, 409, 409]);
    expect(await refused[0]!.json()).toEqual({ error: "The Agent is working. Wait for its Turn to end." });
    await Promise.all(refused.slice(1).map((response) => response.text()));

    // A page opened mid-Turn is sent the Conversation so far when it connects,
    // not only when the Turn ends.
    const late = await connect(workspace.id);
    const sofar = await late.next((frame) => frame.type === "cf_agent_chat_messages" && frame.connect === true);
    expect(sofar.messages!.map((message) => textOf(message))).toContain("[script:slow] Take your time");
    late.close();

    await turnEnd(conversation, from);
    const saved = await call(`/api/workspaces/${workspace.id}/files/src/index.ts`, { method: "PUT", text: "export {};\n" });
    expect(saved.status).toBe(204);
  });

  it("refuses an empty message", async () => {
    const workspace = await create("Empty");
    const response = await startTurn(workspace.id, "  ");
    expect(response.status).toBe(400);
    await response.text();
  });
});

describe("Start fresh", () => {
  it("folds the Conversation after the first message into a summary the next Turn carries on from", async () => {
    const workspace = await create("Fresh");
    const conversation = await connect(workspace.id);
    await runTurn(workspace.id, conversation, "[script:say-hello] Hi");
    await runTurn(workspace.id, conversation, "Hi again");

    const response = await call(`/api/workspaces/${workspace.id}/conversation/start-fresh`, { method: "POST" });
    expect(response.status).toBe(204);
    const folded = await history(workspace.id);
    expect(folded.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(textOf(folded[0]!)).toBe("[script:say-hello] Hi");
    expect(textOf(folded[1]!)).toBe(summaryReply);

    await runTurn(workspace.id, conversation, "After");
    expect((await history(workspace.id)).map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });
});

describe("the Conversation socket", () => {
  it("goes through the request gate, and opens only the Developer's own Workspace", async () => {
    const workspace = await create("Private");
    const other = await create("Theirs", testAccess.secondDeveloper);
    const refused = [
      await upgrade(workspace.id, { Origin: testAccess.appOrigin }),
      await upgrade(workspace.id, { "Sec-Fetch-Site": "cross-site" }),
      await upgrade(workspace.id, { "Cf-Access-Jwt-Assertion": "" }),
      await upgrade(other.id),
    ];
    expect(refused.map((response) => response.status)).toEqual([403, 403, 401, 404]);
    await Promise.all(refused.map((response) => response.text()));
  });

  it("only watches: what it sends can't start a Turn, clear the Conversation or change the Workspace's state", async () => {
    const workspace = await create("Watching");
    const conversation = await connect(workspace.id);
    await runTurn(workspace.id, conversation, "[script:say-hello] Hi");

    const sneaky = { id: "sneaky", role: "user", parts: [{ type: "text", text: "Sneaky" }] };
    conversation.send({ type: "cf_agent_use_chat_request", id: "r1", init: { method: "POST", body: JSON.stringify({ messages: [sneaky] }) } });
    conversation.send({ type: "cf_agent_chat_clear" });
    conversation.send({ type: "cf_agent_state", state: { turn: { startedAt: "2026-01-01T00:00:00.000Z" }, startingFresh: false, lastTurn: null } });

    // A Turn still starts, so the state isn't locked, and it follows the first one.
    await runTurn(workspace.id, conversation, "Hi again");
    expect((await history(workspace.id)).map((message) => textOf(message))).toEqual([
      "[script:say-hello] Hi",
      "Hello from the scripted model.",
      "Hi again",
      "Hello from the scripted model.",
    ]);
  });
});
