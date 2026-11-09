import type { ToolCallResultContext } from "@cloudflare/think";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { PackageStatus } from "../src/packages";
import { restartedDuringTurn, type ConversationState, type LastTurn } from "../src/shared/conversation";
import type { CheckReport, Workspace } from "../src/workspace";
import type { TestReport } from "../src/shared/test-report";
import { askedSecretValue, brokenCount, buildableIndex, failingTest, fixedCount, twoLines } from "./fixtures/agent-scripts";
import { summaryReply } from "./fixtures/fake-anthropic";
import { call, create } from "./helpers/api";
import { testAccess } from "./helpers/access";
import { connect, history, runTurn, startTurn, textOf, turnEnd, turnLines, turnStart, upgrade, type Conversation } from "./helpers/conversation";

// Turns, through the platform's WebSocket and HTTP interface. The model is the
// scripted one in test/fixtures/agent-scripts.ts, behind a fake Anthropic API.

const latestCheck = async (id: string) => (await call(`/api/workspaces/${id}/check`)).json<CheckReport>();
const fileList = async (id: string) => (await (await call(`/api/workspaces/${id}/files`)).json<{ files: string[] }>()).files;
const fileText = async (id: string, path: string) => (await call(`/api/workspaces/${id}/files/${path}`)).text();

describe("a Turn", () => {
  it("streams to the Conversation socket, ends with a clean Check, and is kept", async () => {
    const workspace = await create("Hello");
    const conversation = await connect(workspace.id);
    const from = conversation.frames.length;
    const ended = await runTurn(workspace.id, conversation, "[script:say-hello] Hi");
    expect(ended).toMatchObject({ status: "completed", error: null, checkErrors: 0, retries: 0, outOfSteps: false });
    const { startedAt } = (await turnStart(conversation, from)).state!.turn!;
    expect(conversation.frames.some((frame) => frame.type === "cf_agent_use_chat_response")).toBe(true);
    conversation.close();

    const messages = await history(workspace.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    // Which Turn it started, so the page can tell this Turn's messages from the last one's.
    expect(messages[0]!.metadata).toEqual({ from: "developer", changedFiles: [], turnStartedAt: startedAt });
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
    // Written for Developers who don't write code.
    expect(sent.system).toContain("Never put code, file names, commands or error messages in your replies");
    expect(sent.system).toContain("Call it at the start of every Turn with the steps you plan");
    // Alongside other tools, so ticking a step off doesn't use up a model step of its own.
    expect(sent.system).toContain("alongside your other tool calls");
    expect(sent.system).toContain("ask rather than guess: call ask with the question and 2 to 4 answers");
    expect(sent.system).toContain("suggest 2 or 3 next changes with suggest");
    expect(sent.system).toContain("ask for it with ask_for_secret");
    expect(sent.system).toContain("<agents-md>\n# This Workspace");
    // Each Template, with its description and when it fits.
    expect(sent.system).toContain(
      "  - worker (Worker): A Cloudflare Worker using Hono. Choose it only for something with no page, such as a webhook",
    );
    expect(sent.system).toContain(
      "  - worker-react (Worker + React): A Cloudflare Worker using Hono, with a React front end styled with Tailwind, and a store that remembers records. Choose it for most apps",
    );
    // Each add-on, with when it fits, and that the Agent should prefer one to writing its ability itself.
    expect(sent.system).toContain("  - storage (Storage): A Durable Object with a small typed store of records, in named collections. Add it when");
    expect(sent.system).toContain("prefer it to writing the same ability yourself");
    expect(sent.system).toContain("Give each add-on its own step");
    // Its files are written before the Agent could ask, so its Secrets come once the app works.
    expect(sent.system).toContain("An add-on's secrets are the one exception to asking before you change files");
    expect(sent.latest).toContain("the Developer changed /src/notes.md");
    expect(sent.tools).toEqual(
      expect.arrayContaining([
        "add_addon",
        "add_package",
        "ask",
        "ask_for_secret",
        "bash",
        "check",
        "edit",
        "list",
        "preview_logs",
        "read",
        "request_preview",
        "start_app",
        "steps",
        "suggest",
        "test",
        "write",
      ]),
    );

    // The note is for the Turn after the change only.
    await runTurn(workspace.id, conversation, "And now?");
    const messages = await history(workspace.id);
    expect(JSON.parse(textOf(messages.at(-1)!)).latest).not.toContain("the Developer changed");
    expect(messages[0]!.metadata).toMatchObject({ from: "developer", changedFiles: ["src/notes.md"] });
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

  it("counts as undone once its files are put back, even if checking them then fails", async () => {
    const workspace = await create("Undo interrupted");
    await runInDurableObject(env.WORKSPACES.getByName(workspace.id), (instance: Workspace) => {
      const check = instance.check.bind(instance);
      let broken = false;
      // The first clean Check after a broken one is of the files put back.
      instance.check = async (by) => {
        const report = await check(by);
        if (broken && report.counts.error === 0) throw new Error("Restarted.");
        broken ||= report.counts.error > 0;
        return report;
      };
    });
    const ended = await runTurn(workspace.id, await connect(workspace.id), "[script:break-and-give-up] Add a count");
    expect(ended).toMatchObject({ restored: true, error: "Restarted." });
    expect(await fileList(workspace.id)).not.toContain("src/count.ts");
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

  it("ends with the tests, whose failures don't ask for a retry or undo the Turn, but stay in the problems list", async () => {
    const workspace = await create("Failing test");
    const conversation = await connect(workspace.id);
    const ended = await runTurn(workspace.id, conversation, "[script:write-failing-test] Add a test");
    expect(ended).toMatchObject({ status: "completed", checkErrors: 0, buildErrors: 0, testFailures: 1, retries: 0, restored: false });
    expect(await fileText(workspace.id, "src/sum.test.ts")).toBe(failingTest);
    expect((await history(workspace.id)).filter((message) => message.metadata?.from === "check")).toEqual([]);

    const report = await (await call(`/api/workspaces/${workspace.id}/tests`)).json<TestReport>();
    expect(report.counts).toEqual({ passed: 1, failed: 1, skipped: 0, todo: 0 });
    expect(report.files.map(({ file }) => file)).toEqual(["src/index.test.ts", "src/sum.test.ts"]);
    expect(report.files[1]!.tests).toEqual([
      {
        name: ["adds"],
        state: "failed",
        line: 3,
        failure: expect.objectContaining({ message: "AssertionError: expected 2 to be 3 // Object.is equality", file: "src/sum.test.ts", line: 4 }),
      },
    ]);
  });

  it("ends without an error, having checked and built once, when its tests can't run", async () => {
    const workspace = await create("Tests can't run");
    await runInDurableObject(env.WORKSPACES.getByName(workspace.id), (instance) => {
      instance.runTests = async () => {
        throw new Error("The tests broke");
      };
    });
    const ended = await runTurn(workspace.id, await connect(workspace.id), "[script:say-hello] Hi");
    expect(ended).toMatchObject({ status: "completed", error: null, checkErrors: 0, buildErrors: 0, testFailures: null });
  });

  it("runs the tests with the test tool, all of them or the files it names", async () => {
    const [all, one] = [await create("Test tool"), await create("Test tool, one file")];
    await call(`/api/workspaces/${one.id}/files/src/sum.test.ts`, { method: "PUT", text: failingTest });
    await runTurn(all.id, await connect(all.id), "[script:use-test] Run the tests");
    expect(textOf((await history(all.id))[1]!)).toBe(
      "The tool said: /src/index.test.ts: 1 passed, 0 failed.\n1 test file: 1 passed, 0 failed.",
    );

    await runTurn(one.id, await connect(one.id), "[script:use-test-file] Run that test");
    expect(textOf((await history(one.id))[1]!)).toBe(
      [
        "The tool said: /src/sum.test.ts: 0 passed, 1 failed.",
        "  FAILED adds (at /src/sum.test.ts:4:17): AssertionError: expected 2 to be 3 // Object.is equality",
        "    - Expected",
        "    + Received",
        "    ",
        "    - 3",
        "    + 2",
        "1 test file: 0 passed, 1 failed.",
      ].join("\n"),
    );
  });

  it("stops after three more tries, and puts the files back as they were before it", async () => {
    const workspace = await create("Unfixed");
    const before = { files: await fileList(workspace.id), packageJson: await fileText(workspace.id, "package.json") };
    const conversation = await connect(workspace.id);
    const ended = await runTurn(workspace.id, conversation, "[script:break-and-give-up] Add a count");
    expect(ended).toMatchObject({ status: "completed", checkErrors: 1, retries: 3, restored: true });

    // The file it wrote is gone, the one it deleted is back, and so is package.json, with its Packages.
    expect(await fileList(workspace.id)).toEqual(before.files);
    expect(await fileText(workspace.id, "package.json")).toBe(before.packageJson);
    const packages = await (await call(`/api/workspaces/${workspace.id}/packages`)).json<PackageStatus>();
    expect(packages.packages.map(({ name }) => name)).not.toContain("@fake/a");
    // The reports are of the files as they are now.
    expect(await latestCheck(workspace.id)).toMatchObject({ counts: { error: 0 } });
    expect(await (await call(`/api/workspaces/${workspace.id}/build`)).json()).toMatchObject({ ok: true });
    const tests = await (await call(`/api/workspaces/${workspace.id}/tests`)).json<TestReport>();
    expect(tests.files.map(({ file }) => file)).toEqual(["src/index.test.ts"]);

    // The Conversation keeps every message.
    const messages = await history(workspace.id);
    expect(messages.flatMap((message) => (message.metadata?.from === "check" ? [message.metadata.retry] : []))).toEqual([1, 2, 3]);
    expect(messages).toHaveLength(8);

    // The next Turn tells the Agent, and the one after doesn't.
    const note = "(From the platform: your last Turn's changes were put back, because the app didn't work after them.)";
    expect(await runTurn(workspace.id, conversation, "What now?")).toMatchObject({ restored: false });
    expect(textOf((await history(workspace.id)).at(-1)!)).toBe(`I was told: What now?\n${note}`);
    await runTurn(workspace.id, conversation, "And now?");
    expect(textOf((await history(workspace.id)).at(-1)!)).toBe("I was told: And now?");
  });

  it("says what stage it's at: the Agent working, then making sure it works, for each try", async () => {
    const workspace = await create("Stages");
    const conversation = await connect(workspace.id);
    const from = conversation.frames.length;
    const ended = await runTurn(workspace.id, conversation, "[script:break-then-fix] Add a count");
    expect(ended).toMatchObject({ checkErrors: 0, retries: 1 });
    const stages = conversation.frames
      .slice(from)
      .flatMap((frame) => (frame.type === "cf_agent_state" && frame.state?.turn ? [frame.state.turn.stage] : []))
      .filter((stage, index, all) => stage !== all[index - 1]);
    expect(stages).toEqual(["working", "checking", "working", "checking"]);
  });

  it("stops the model after 40 steps", async () => {
    const workspace = await create("Steps");
    const conversation = await connect(workspace.id);
    const ended = await runTurn(workspace.id, conversation, "[script:keep-going] List the files");
    expect(ended).toMatchObject({ checkErrors: 0, retries: 0, outOfSteps: true });
    const [, reply] = await history(workspace.id);
    expect(reply!.parts.filter((part) => part.type === "tool-list")).toHaveLength(40);
  });

  it("gives no more tries once the Turn has used its 40 steps, and is undone if that leaves the app broken", async () => {
    const workspace = await create("Spent");
    const conversation = await connect(workspace.id);
    const ended = await runTurn(workspace.id, conversation, "[script:break-and-keep-going] Add a count");
    expect(ended).toMatchObject({ checkErrors: 1, retries: 0, outOfSteps: true, restored: true });
    expect(await history(workspace.id)).toHaveLength(2);
    expect(await fileList(workspace.id)).not.toContain("src/count.ts");
  });
});

describe("the Agent's own tools", () => {
  it("shows its steps with steps, which doesn't end the Turn", async () => {
    const workspace = await create("Steps shown");
    const conversation = await connect(workspace.id);
    const ended = await runTurn(workspace.id, conversation, "[script:steps] Add a count");
    expect(ended).toMatchObject({ status: "completed", checkErrors: 0, retries: 0 });
    expect(await fileText(workspace.id, "src/count.ts")).toBe(fixedCount);

    const [, reply] = await history(workspace.id);
    const calls = reply!.parts.filter((part) => part.type === "tool-steps") as {
      state: string;
      input: { steps: { done: boolean; detail?: string }[] };
    }[];
    expect(calls.map(({ state }) => state)).toEqual(["output-available", "output-available", "output-available"]);
    const lists = calls.map(({ input }) => input.steps.map(({ done }) => done));
    expect(lists).toEqual([
      [false, false],
      [true, false],
      [true, true],
    ]);
    expect(calls.map(({ input }) => input.steps[0]!.detail)).toEqual([undefined, "Counting from one", "Counting from one"]);
    expect(textOf(reply!)).toBe("Your count is ready.");
  });

  it("asks a question with ask, which ends the Turn after its Check and Build, with no retries", async () => {
    const workspace = await create("Asked");
    const conversation = await connect(workspace.id);
    const ended = await runTurn(workspace.id, conversation, "[script:ask] Email me when someone signs up");
    // The question came with a broken file, which would otherwise get a retry. Without one, the Turn is undone.
    expect(ended).toMatchObject({ status: "completed", asked: "question", checkErrors: 1, buildErrors: 0, retries: 0, restored: true });
    expect(await fileList(workspace.id)).not.toContain("src/count.ts");
    const [, reply] = await history(workspace.id);
    expect(reply!.parts.find((part) => part.type === "tool-ask")).toMatchObject({
      state: "output-available",
      input: { question: "Which address should the emails go to?", choices: ["My sign-in address", "A different address"] },
    });
    expect(textOf(reply!)).toBe("");

    // The answer is an ordinary message, starting the next Turn.
    const answered = await runTurn(workspace.id, conversation, "A different address");
    expect(answered).toMatchObject({ status: "completed", asked: null, checkErrors: 0, retries: 0 });
    const messages = await history(workspace.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    // The answer carries the platform's note that the files were put back.
    expect(textOf(messages[3]!)).toBe(
      "Going with: A different address\n(From the platform: your last Turn's changes were put back, because the app didn't work after them.)",
    );
    expect(await fileText(workspace.id, "src/count.ts")).toBe(fixedCount);
  });

  it("asks for a Secret with ask_for_secret, which ends the Turn like ask, and carries on once it's added, never seeing its value", async () => {
    const logged = vi.spyOn(console, "log");
    const workspace = await create("Asked for a Secret");
    const conversation = await connect(workspace.id);
    const ended = await runTurn(workspace.id, conversation, "[script:ask-for-secret] Email me when someone signs up");
    // The request came with a broken file, which would otherwise get a retry. Without one, the Turn is undone.
    expect(ended).toMatchObject({ status: "completed", asked: "secret", checkErrors: 1, buildErrors: 0, retries: 0, restored: true });
    expect(await fileList(workspace.id)).not.toContain("src/count.ts");
    const [, reply] = await history(workspace.id);
    expect(reply!.parts.find((part) => part.type === "tool-ask_for_secret")).toMatchObject({
      state: "output-available",
      input: { name: "EMAIL_KEY", why: "Your app needs your email service's key to send the emails." },
    });

    // The page saves the value through the Secrets route, then starts the next Turn by the Secret's name.
    const saved = await call(`/api/workspaces/${workspace.id}/secrets/EMAIL_KEY`, { method: "PUT", body: { value: askedSecretValue } });
    expect(saved.status).toBe(204);
    const from = conversation.frames.length;
    const started = await call(`/api/workspaces/${workspace.id}/turns`, { method: "POST", body: { secret: "EMAIL_KEY" } });
    expect(started.status).toBe(202);
    const carried = await turnEnd(conversation, from);
    expect(carried).toMatchObject({ status: "completed", asked: null, checkErrors: 0, retries: 0 });
    const { startedAt } = (await turnStart(conversation, from)).state!.turn!;

    const messages = await history(workspace.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(messages[2]!.metadata).toEqual({ from: "developer", changedFiles: [], turnStartedAt: startedAt, addedSecret: "EMAIL_KEY" });
    // With the note that the last Turn's changes were put back.
    const undone = "(From the platform: your last Turn's changes were put back, because the app didn't work after them.)";
    expect(textOf(messages[2]!)).toBe(`(From the platform: the Developer added the Secret EMAIL_KEY.)${undone}`);
    // The Agent carried on from the notes, and the value never reached the model.
    expect(textOf(messages[3]!)).toBe(`Told: (From the platform: the Developer added the Secret EMAIL_KEY.)\n${undone} Saw the value: false`);
    expect(await fileText(workspace.id, "src/count.ts")).toBe(fixedCount);
    // Nor the Conversation, nor the logs.
    expect(JSON.stringify(messages)).not.toContain(askedSecretValue);
    expect(JSON.stringify(logged.mock.calls)).not.toContain(askedSecretValue);
    expect(logged.mock.calls.some(([line]) => typeof line === "string" && line.includes('"event":"turn"') && line.includes('"asked":"secret"'))).toBe(true);
    logged.mockRestore();
    conversation.close();
  });

  it("starts a Turn for a Secret only once it's been added", async () => {
    const workspace = await create("No such Secret");
    for (const secret of ["EMAIL_KEY", "", 3]) {
      const started = await call(`/api/workspaces/${workspace.id}/turns`, { method: "POST", body: { secret } });
      expect(started.status).toBe(400);
      expect(await started.json()).toEqual({ error: "There's no secret with that name. Save it first." });
    }
    expect(await history(workspace.id)).toEqual([]);
  });

  it("carries on when ask_for_secret refuses a name the app couldn't read", async () => {
    const workspace = await create("Asked for a Secret badly");
    const ended = await runTurn(workspace.id, await connect(workspace.id), "[script:ask-for-secret-badly] Send emails");
    expect(ended).toMatchObject({ status: "completed", asked: null });
    const [, reply] = await history(workspace.id);
    expect(reply!.parts.find((part) => part.type === "tool-ask_for_secret")).toMatchObject({ state: "output-error" });
    expect(textOf(reply!)).toBe("I'll do without it.");
  });

  it("carries on when ask refuses a question without two different answers", async () => {
    const workspace = await create("Asked badly");
    const ended = await runTurn(workspace.id, await connect(workspace.id), "[script:ask-badly] Go on");
    expect(ended).toMatchObject({ status: "completed", asked: null });
    const [, reply] = await history(workspace.id);
    expect(reply!.parts.find((part) => part.type === "tool-ask")).toMatchObject({ state: "output-error" });
    expect(textOf(reply!)).toBe("I'll choose for you.");
  });

  it("suggests next changes with suggest, which doesn't end the Turn", async () => {
    const workspace = await create("Suggested");
    const ended = await runTurn(workspace.id, await connect(workspace.id), "[script:suggest] Make a sign-up sheet");
    expect(ended).toMatchObject({ status: "completed", asked: null });
    const [, reply] = await history(workspace.id);
    expect(reply!.parts.find((part) => part.type === "tool-suggest")).toMatchObject({
      state: "output-available",
      input: { suggestions: ["Add a waiting list when it's full", "Make it look sportier"] },
    });
    expect(textOf(reply!)).toBe("Your app's ready.");
  });

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
    // The Template's Build is new to the Agent, so the platform tried it.
    expect(textOf(reply!)).toBe(
      "The tool said: The Build succeeded.\nThe platform tried the Preview with GET /, which answered 200. It has logged no errors or warnings since this Build.",
    );

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

  it("keeps both of two edits to one file in the same step", async () => {
    const workspace = await create("Two edits");
    expect((await call(`/api/workspaces/${workspace.id}/files/src/pair.ts`, { method: "PUT", text: twoLines })).status).toBe(204);
    await runTurn(workspace.id, await connect(workspace.id), "[script:two-edits] Change both");
    const file = await (await call(`/api/workspaces/${workspace.id}/files/src/pair.ts`)).text();
    expect(file).toBe("export const first = 10;\nexport const second = 20;\n");
  });

  it("runs an edit after bash in the same step, as the model gave them, so the edit finds what bash wrote", async () => {
    const workspace = await create("Bash then edit");
    await runTurn(workspace.id, await connect(workspace.id), "[script:bash-and-edit] Write it");
    const file = await (await call(`/api/workspaces/${workspace.id}/files/src/pair.ts`)).text();
    expect(file).toBe("export const first = 10;\n");
  });

  /** Starts and finishes a tool call through the Workspace's hooks, as Think does, with the tool's name as its ID. */
  function toolHooks(instance: Workspace) {
    return {
      start: (toolName: string) =>
        instance.beforeToolCall({ type: "tool-call", toolName, toolCallId: toolName, input: {}, stepNumber: 0, messages: [], abortSignal: undefined }),
      finish: (toolName: string) => instance.afterToolCall({ toolName, toolCallId: toolName } as unknown as ToolCallResultContext),
    };
  }

  it("runs a step's tools that change the files one at a time, and doesn't make reading tools wait", async () => {
    const workspace = await create("One at a time");
    await runInDurableObject(env.WORKSPACES.getByName(workspace.id), async (instance: Workspace) => {
      const { start, finish } = toolHooks(instance);
      const settled = (started: unknown) => Promise.race([Promise.resolve(started).then(() => true), scheduler.wait(100).then(() => false)]);

      expect(await settled(start("edit"))).toBe(true);
      const bash = start("bash");
      expect(await settled(bash)).toBe(false);
      for (const reading of ["read", "list", "find", "grep"]) expect(start(reading)).toBeUndefined();
      finish("edit");
      expect(await settled(bash)).toBe(true);
      for (const tool of ["bash", "read", "list", "find", "grep"]) finish(tool);
      expect((instance as unknown as { toolsRunning: number }).toolsRunning).toBe(0);
    });
  });

  it("makes check, build and test wait for a step's tools that change the files, however long they take together", async () => {
    const workspace = await create("Slow changes");
    await runInDurableObject(env.WORKSPACES.getByName(workspace.id), async (instance: Workspace) => {
      const { start, finish } = toolHooks(instance);
      const waiting = instance as unknown as { otherToolsFinished(waitMs: number): Promise<void> };

      void start("add_addon");
      void start("bash");
      let checked = false;
      // Each of them takes most of the wait, so together they take longer than it.
      const check = waiting.otherToolsFinished(1_000).then(() => (checked = true));
      await scheduler.wait(700);
      finish("add_addon");
      await scheduler.wait(700);
      expect(checked).toBe(false);
      finish("bash");
      await check;
    });
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

describe("a restart during a Turn", () => {
  /**
   * Restarts the Workspace during the Turn that started at the end of the
   * Conversation so far, as a new isolate finds it, and says how the Turn
   * ended. `turn` is the Turn as the isolate that stopped left it.
   */
  async function restart(id: string, conversation: Conversation, turn: Partial<ConversationState["turn"]> = {}): Promise<LastTurn> {
    const startedAt = await lastStartedAt(id);
    const from = conversation.frames.length;
    await runInDurableObject(env.WORKSPACES.getByName(id), async (instance: Workspace) => {
      instance.setState({ ...instance.state, turn: { startedAt, stage: "working", ...turn } });
      await instance.onStart();
      // As if the alarm that ran the Turn ran again in the new isolate.
      await instance.driveTurn({ request: "Hi", startedAt });
    });
    return turnEnd(conversation, from);
  }

  /** When the Turn at the end of the Conversation so far started. */
  async function lastStartedAt(id: string): Promise<string> {
    const metadata = (await history(id)).findLast((message) => message.metadata?.from === "developer")?.metadata;
    return metadata?.from === "developer" ? metadata.turnStartedAt! : "";
  }

  it("checks and builds the files, and undoes the Turn when they leave the app broken", async () => {
    const workspace = await create("Restarted, broken");
    const conversation = await connect(workspace.id);
    await runTurn(workspace.id, conversation, "[script:say-hello] Hi");
    // What the Agent had done when the Workspace restarted.
    await call(`/api/workspaces/${workspace.id}/files/src/count.ts`, { method: "PUT", text: brokenCount });

    const ended = await restart(workspace.id, conversation);
    expect(ended).toMatchObject({ status: "aborted", error: restartedDuringTurn, checkErrors: 1, restored: true });
    expect(await fileList(workspace.id)).not.toContain("src/count.ts");
    expect(await latestCheck(workspace.id)).toMatchObject({ counts: { error: 0 } });
    // The Developer's message isn't sent again.
    expect(await history(workspace.id)).toHaveLength(2);
  });

  it("still says the Turn was undone when the Workspace restarts again after putting its files back", async () => {
    const workspace = await create("Restarted after undoing");
    const conversation = await connect(workspace.id);
    // The files are put back as the Turn ends, as they would be just before a second restart.
    await runTurn(workspace.id, conversation, "[script:break-and-give-up] Add a count");

    const ended = await restart(workspace.id, conversation, { stage: "checking", restarted: true });
    expect(ended).toMatchObject({ status: "aborted", error: restartedDuringTurn, restored: true });
  });

  it("keeps the files when they work", async () => {
    const workspace = await create("Restarted, working");
    const conversation = await connect(workspace.id);
    await runTurn(workspace.id, conversation, "[script:say-hello] Hi");
    await call(`/api/workspaces/${workspace.id}/files/src/count.ts`, { method: "PUT", text: fixedCount });

    const ended = await restart(workspace.id, conversation);
    expect(ended).toMatchObject({ status: "aborted", error: restartedDuringTurn, checkErrors: 0, buildErrors: 0, restored: false });
    expect(await fileText(workspace.id, "src/count.ts")).toBe(fixedCount);
  });

  it("logs the Turn it ended, with why and when it started, whether or not the Workspace restarts again while ending it", async () => {
    const workspace = await create("Restarted, logged");
    const conversation = await connect(workspace.id);
    await runTurn(workspace.id, conversation, "[script:say-hello] Hi");
    const restartedAt = await lastStartedAt(workspace.id);

    const ended = await turnLines(() => restart(workspace.id, conversation));
    expect(ended).toEqual([expect.objectContaining({ status: "aborted", error: restartedDuringTurn, startedAt: restartedAt })]);
    const again = await turnLines(() => restart(workspace.id, conversation, { stage: "checking", restarted: true }));
    expect(again).toEqual([expect.objectContaining({ status: "aborted", error: restartedDuringTurn, startedAt: restartedAt })]);
  });

  it("logs the add-ons the Turn added before the restart, kept in storage rather than lost with the isolate", async () => {
    const workspace = await create("Restarted, with storage");
    const conversation = await connect(workspace.id);
    await runTurn(workspace.id, conversation, "[script:add-storage] Remember the messages");
    const ended = await turnLines(() => restart(workspace.id, conversation));
    expect(ended).toEqual([expect.objectContaining({ status: "aborted", addons: ["storage"] })]);
    const again = await turnLines(() => restart(workspace.id, conversation, { stage: "checking", restarted: true }));
    expect(again).toEqual([expect.objectContaining({ status: "aborted", addons: ["storage"] })]);
  });

  it("ends the Turn without a Check when the Workspace restarts again while ending it", async () => {
    const workspace = await create("Restarted twice");
    const conversation = await connect(workspace.id);
    await runTurn(workspace.id, conversation, "[script:say-hello] Hi");
    await call(`/api/workspaces/${workspace.id}/files/src/count.ts`, { method: "PUT", text: brokenCount });

    const ended = await restart(workspace.id, conversation, { stage: "checking", restarted: true });
    expect(ended).toMatchObject({ status: "aborted", error: restartedDuringTurn, checkErrors: null, buildErrors: null, restored: false });
    expect(await fileText(workspace.id, "src/count.ts")).toBe(brokenCount);
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
    conversation.send({ type: "cf_agent_state", state: { turn: { startedAt: "2026-01-01T00:00:00.000Z", stage: "working" }, startingFresh: false, lastTurn: null } });

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
