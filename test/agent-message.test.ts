import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  agentMessageBlocks,
  appStartedIn,
  describeRetry,
  describeTool,
  describeToolCall,
  openQuestion,
  runningMessage,
  stepsDone,
  suggestionsToShow,
  turnProgress,
} from "../client/src/agentMessage";

// What an Agent message shows: its text, its steps in plain words, and the
// tool calls behind them; and how far a running Turn has got, for the app area.

type Part = UIMessage["parts"][number];

const text = (value: string): Part => ({ type: "text", text: value, state: "done" });
let calls = 0;
const tool = (name: string, input: unknown, state = "output-available"): Part =>
  ({ type: `tool-${name}`, toolCallId: `call-${++calls}`, state, input, output: state === "output-available" ? "ok" : undefined }) as Part;
const steps = (list: [label: string, done: boolean][], state = "output-available") =>
  tool("steps", { steps: list.map(([label, done]) => ({ label, done })) }, state);

describe("an Agent message", () => {
  it("shows its text, then its latest steps where its first tool call was, then the rest of its text", () => {
    const write = tool("write", { path: "/src/App.tsx" });
    const blocks = agentMessageBlocks([
      text("Lovely idea."),
      steps([["Designing the page", false], ["Keeping track of who's coming", false]]),
      write,
      steps([["Designing the page", true], ["Keeping track of who's coming", true]]),
      text("Your app's ready."),
    ]);
    expect(blocks).toEqual([
      { kind: "text", text: "Lovely idea.", streaming: false },
      {
        kind: "steps",
        steps: [
          { label: "Designing the page", done: true },
          { label: "Keeping track of who's coming", done: true },
        ],
        // The tool calls behind the steps, for "Technical details", without the steps themselves.
        tools: [write],
        fromAgent: true,
      },
      { kind: "text", text: "Your app's ready.", streaming: false },
    ]);
  });

  it("keeps the last finished list while the model is still writing the next", () => {
    const [, block] = agentMessageBlocks([text("On it."), steps([["Adding a list", false]]), steps([["Add"]] as never, "input-streaming")]);
    expect(block).toEqual({ kind: "steps", steps: [{ label: "Adding a list", done: false }], tools: [], fromAgent: true });
  });

  it("passes over a list the platform refused, or an empty one", () => {
    const blocks = agentMessageBlocks([
      steps([["Adding a list", false]]),
      steps([["Too many", false]], "output-error"),
      tool("steps", { steps: [] }),
    ]);
    expect(blocks).toEqual([{ kind: "steps", steps: [{ label: "Adding a list", done: false }], tools: [], fromAgent: true }]);
    // With no list of its own, the tool calls are described instead.
    expect(agentMessageBlocks([tool("steps", { steps: [] }), tool("build", {})])).toMatchObject([
      { kind: "steps", steps: [{ label: "Building your app", done: true }], fromAgent: false },
    ]);
  });

  it("describes its tool calls in plain words when it gave no steps, as one step for calls in a row that read the same", () => {
    const [block] = agentMessageBlocks([
      tool("read", { path: "/src/index.ts" }),
      tool("list", { path: "/" }),
      tool("edit", { path: "/src/index.ts" }, "output-error"),
      tool("write", { path: "/src/count.ts" }, "input-available"),
      tool("build", {}),
    ]);
    expect(block).toMatchObject({
      kind: "steps",
      steps: [
        { label: "Looking at your app", done: true },
        // A failed call still finished; "Technical details" says it failed.
        { label: "Changing your app", done: false },
        { label: "Building your app", done: true },
      ],
    });
  });

  it("shows nothing for steps when it has no tool calls", () => {
    expect(agentMessageBlocks([text("Hello.")])).toEqual([{ kind: "text", text: "Hello.", streaming: false }]);
  });
});

describe("a question", () => {
  const ask = (question: string, choices: unknown, state = "output-available") => tool("ask", { question, choices }, state);
  const question = { question: "Which address should the emails go to?", choices: ["My sign-in address", "A different address"] };
  const shown = { asked: "question", ...question, id: expect.stringMatching(/^call-/) };
  const asking = (parts: Part[] = []): UIMessage => ({
    id: "2",
    role: "assistant",
    parts: [text("Happy to."), ...parts, ask(question.question, question.choices)],
  });
  const developer: UIMessage = { id: "1", role: "user", parts: [text("Email me when someone signs up")] };

  it("shows where the Agent asked it, after its steps, and not as a step or under Technical details", () => {
    const write = tool("write", { path: "/src/App.tsx" });
    expect(agentMessageBlocks(asking([write]).parts)).toEqual([
      { kind: "text", text: "Happy to.", streaming: false },
      { kind: "steps", steps: [{ label: "Changing your app", done: true }], tools: [write], fromAgent: false },
      { kind: "question", question: shown },
    ]);
    expect(agentMessageBlocks([ask(question.question, question.choices)])).toEqual([{ kind: "question", question: shown }]);
  });

  it("passes over a question the platform refused, or one still being written", () => {
    for (const part of [ask("Shall I?", ["Yes"], "output-error"), ask("Shall I?", ["Yes", "No"], "input-streaming"), ask("Shall I?", ["Yes", "Yes"])]) {
      expect(agentMessageBlocks([part])).toEqual([]);
    }
  });

  it("has its choices shown as buttons only on the last message, and only when no Turn is running", () => {
    expect(openQuestion([developer, asking()], true)).toEqual(shown);
    expect(openQuestion([developer, asking()], false)).toBeNull();
    // Answered: the answer is the Developer's next message.
    expect(openQuestion([developer, asking(), { ...developer, id: "3" }], true)).toBeNull();
    expect(openQuestion([developer, { id: "2", role: "assistant", parts: [text("Done.")] }], true)).toBeNull();
  });

  it("is the last one, when the Agent asked two at once, so only its choices show", () => {
    const first = ask("Which colour?", ["Red", "Blue"]);
    const second = ask("Which day?", ["Saturday", "Sunday"]);
    const message: UIMessage = { id: "2", role: "assistant", parts: [first, second] };
    expect(agentMessageBlocks(message.parts).map((block) => block.kind === "question" && block.question.id)).toEqual([
      (first as { toolCallId: string }).toolCallId,
      (second as { toolCallId: string }).toolCallId,
    ]);
    expect(openQuestion([developer, message], true)).toMatchObject({ id: (second as { toolCallId: string }).toolCallId, question: "Which day?" });
  });
});

describe("a request for a Secret", () => {
  const askForSecret = (input: unknown, state = "output-available") => tool("ask_for_secret", input, state);
  const request = { name: "EMAIL_KEY", why: "Your app needs your email service's key to send the emails." };
  const shown = { asked: "secret", ...request, id: expect.stringMatching(/^call-/) };
  const developer: UIMessage<{ from?: string }> = { id: "1", role: "user", parts: [text("Email me when someone signs up")] };
  const asking: UIMessage<{ from?: string }> = { id: "2", role: "assistant", parts: [text("Happy to."), askForSecret(request)] };

  it("shows where the Agent asked for it, and not as a step or under Technical details", () => {
    const write = tool("write", { path: "/src/App.tsx" });
    expect(agentMessageBlocks([write, askForSecret(request)])).toEqual([
      { kind: "steps", steps: [{ label: "Changing your app", done: true }], tools: [write], fromAgent: false },
      { kind: "question", question: shown },
    ]);
  });

  it("passes over a request the platform refused, one still being written, or one with no name or reason", () => {
    for (const part of [
      askForSecret(request, "output-error"),
      askForSecret(request, "input-streaming"),
      askForSecret({ ...request, name: " " }),
      askForSecret({ name: "EMAIL_KEY" }),
    ]) {
      expect(agentMessageBlocks([part])).toEqual([]);
    }
  });

  it("has its field only on the last message, when no Turn is running, and hides the suggestions meanwhile", () => {
    expect(openQuestion([developer, asking], true)).toEqual(shown);
    expect(openQuestion([developer, asking], false)).toBeNull();
    // Added: the platform's note is the Developer's next message.
    expect(openQuestion([developer, asking, { ...developer, id: "3" }], true)).toBeNull();
    const suggested: UIMessage<{ from?: string }> = { ...asking, parts: [tool("suggest", { suggestions: ["Make it look sportier"] }), ...asking.parts] };
    expect(suggestionsToShow([developer, suggested], true)).toEqual([]);
  });

  it("is the open one when it came after a question in the same message", () => {
    const message: UIMessage = { id: "2", role: "assistant", parts: [tool("ask", { question: "Shall I?", choices: ["Yes", "No"] }), askForSecret(request)] };
    expect(openQuestion([developer, message], true)).toEqual(shown);
  });
});

describe("the suggestions", () => {
  const suggest = (suggestions: unknown, state = "output-available") => tool("suggest", { suggestions }, state);
  const developer = (id: string): UIMessage<{ from?: string }> => ({ id, role: "user", parts: [text("Make a sign-up sheet")], metadata: { from: "developer" } });
  const agent = (id: string, parts: Part[]): UIMessage<{ from?: string }> => ({ id, role: "assistant", parts });
  const retry = (id: string): UIMessage<{ from?: string }> => ({ id, role: "user", parts: [text("Fix it")], metadata: { from: "check" } });
  const ideas = ["Add a waiting list when it's full", "Make it look sportier"];

  it("are the Agent's latest since the Developer's last message, once no Turn is running", () => {
    const messages = [developer("1"), agent("2", [suggest(["Old idea"]), suggest(ideas), text("Your app's ready.")])];
    expect(suggestionsToShow(messages, true)).toEqual(ideas);
    expect(suggestionsToShow(messages, false)).toEqual([]);
    // Across the platform's retries.
    expect(suggestionsToShow([...messages, retry("3"), agent("4", [text("Fixed it.")])], true)).toEqual(ideas);
  });

  it("are to try a different way after a Turn that was undone, in place of the Agent's own", () => {
    const messages = [developer("1"), agent("2", [suggest(ideas), text("I couldn't fix it.")])];
    expect(suggestionsToShow(messages, true, true)).toEqual(["Try a different way"]);
    expect(suggestionsToShow(messages, false, true)).toEqual([]);
    // The Developer answers an open question instead.
    const asked = tool("ask", { question: "Which colour?", choices: ["Red", "Blue"] });
    expect(suggestionsToShow([developer("1"), agent("2", [asked])], true, true)).toEqual([]);
  });

  it("go once the Developer sends another message", () => {
    const messages = [developer("1"), agent("2", [suggest(ideas)]), developer("3"), agent("4", [text("Done.")])];
    expect(suggestionsToShow(messages, true)).toEqual([]);
  });

  it("don't show while a question is open, or when the platform refused them", () => {
    const asked = tool("ask", { question: "Which colour?", choices: ["Red", "Blue"] });
    expect(suggestionsToShow([developer("1"), agent("2", [suggest(ideas), asked])], true)).toEqual([]);
    expect(suggestionsToShow([developer("1"), agent("2", [suggest(["One", "Two", "Three", "Four"], "output-error")])], true)).toEqual([]);
  });

  it("don't show in the Agent's message, as steps or under Technical details", () => {
    expect(agentMessageBlocks([suggest(ideas), text("Your app's ready.")])).toEqual([{ kind: "text", text: "Your app's ready.", streaming: false }]);
    expect(agentMessageBlocks([steps([["Making a sign-up sheet", true]]), suggest(ideas)])).toEqual([
      { kind: "steps", steps: [{ label: "Making a sign-up sheet", done: true }], tools: [], fromAgent: true },
    ]);
  });
});

describe("tool calls in plain words", () => {
  it("come from a fixed list, with a plain fallback", () => {
    expect(describeTool("build")).toBe("Building your app");
    expect(describeTool("check")).toBe("Checking for mistakes");
    expect(describeTool("test")).toBe("Testing your app");
    expect(describeTool("start_app")).toBe("Starting your app");
    for (const name of ["read", "list", "find", "grep"]) expect(describeTool(name)).toBe("Looking at your app");
    for (const name of ["write", "edit", "delete", "bash"]) expect(describeTool(name)).toBe("Changing your app");
    expect(describeTool("add_package")).toBe("Adding a ready-made part");
    expect(describeTool("request_preview")).toBe("Trying your app");
    expect(describeTool("preview_logs")).toBe("Seeing how your app ran");
    expect(describeTool("list_secrets")).toBe("Looking at your app's Secrets");
    expect(describeTool("something_new")).toBe("Working on your app");
  });
});

describe("a tool call under Technical details", () => {
  const call = (name: string, input: unknown, state: string, turnRunning = false) =>
    describeToolCall(tool(name, input, state) as Parameters<typeof describeToolCall>[0], turnRunning);

  it("says what it did, what it's doing, or that it couldn't do it", () => {
    expect(call("read", { path: "/src/App.tsx" }, "output-available")).toEqual({ outcome: "done", verb: "Read", subject: "/src/App.tsx" });
    expect(call("build", {}, "input-available", true)).toEqual({ outcome: "running", verb: "Building", subject: "" });
    expect(call("build", {}, "output-error")).toEqual({ outcome: "failed", verb: "Couldn't build", subject: "" });
    expect(call("write", { path: "/src/App.tsx" }, "output-denied")).toEqual({
      outcome: "failed",
      verb: "Couldn't write",
      subject: "/src/App.tsx",
    });
    expect(call("something_new", {}, "output-available")).toEqual({ outcome: "done", verb: "Used something_new", subject: "" });
  });

  it("reads as unfinished, not failed, when it has no output once no Turn is running", () => {
    expect(call("build", {}, "input-available")).toEqual({ outcome: "unfinished", verb: "Didn't finish building", subject: "" });
    expect(call("find", { pattern: "*.ts" }, "input-streaming")).toEqual({
      outcome: "unfinished",
      verb: "Didn't finish finding files matching",
      subject: "*.ts",
    });
    expect(call("something_new", {}, "input-available")).toEqual({ outcome: "unfinished", verb: "Didn't finish using something_new", subject: "" });
  });

  it("can still be running only in the last message, while a Turn runs, so one cut short by a restart stays unfinished in the next Turn", () => {
    const message = (id: string, role: UIMessage["role"]): UIMessage => ({ id, role, parts: [] });
    const messages = [message("a", "user"), message("b", "assistant"), message("c", "user"), message("d", "assistant")];
    expect(runningMessage(messages, true)).toBe("d");
    expect(runningMessage(messages.slice(0, 3), true)).toBe("c");
    expect(runningMessage(messages, false)).toBeNull();
    expect(runningMessage([], true)).toBeNull();
  });
});

describe("how many steps are done", () => {
  it("counts the ticked steps", () => {
    expect(stepsDone([{ label: "Adding a list", done: true }])).toBe("1 of 1 step done");
    expect(
      stepsDone([
        { label: "Adding a list", done: true },
        { label: "Testing it", done: false },
      ]),
    ).toBe("1 of 2 steps done");
  });
});

describe("a retry", () => {
  it("reads as normal work", () => {
    expect(describeRetry(1)).toBe("Found a problem, fixing it (try 1 of 3)");
  });
});

describe("a running Turn's progress", () => {
  const working = { startedAt: "2026-11-07T10:00:00.000Z", stage: "working" } as const;
  // The Developer's message for the running Turn, or for an earlier one.
  const developer = (id: string, turnStartedAt: string = working.startedAt): UIMessage<{ from?: string; turnStartedAt?: string }> => ({
    id,
    role: "user",
    parts: [text("Make me a sign-up sheet")],
    metadata: { from: "developer", turnStartedAt },
  });
  const agent = (id: string, parts: Part[]): UIMessage<{ from?: string }> => ({ id, role: "assistant", parts });

  const retry = (id: string): UIMessage<{ from?: string }> => ({ id, role: "user", parts: [text("Fix it")], metadata: { from: "check" } });

  it("is the first unfinished step of the Turn's latest list", () => {
    const messages = [developer("1"), agent("2", [steps([["Naming your app", true], ["Designing the page", false], ["Testing it", false]])])];
    expect(turnProgress(messages, working)).toEqual({
      current: "Designing the page",
      steps: [
        { label: "Naming your app", done: true },
        { label: "Designing the page", done: false },
        { label: "Testing it", done: false },
      ],
    });
  });

  it("is getting ready before the Agent has said anything, ignoring the last Turn's steps", () => {
    const earlier = "2026-11-07T09:00:00.000Z";
    const messages = [developer("1", earlier), agent("2", [steps([["Old step", false]])]), developer("3")];
    expect(turnProgress(messages, working)).toEqual({ current: "Getting ready", steps: [] });
    // The Turn starts a moment before its Developer's message arrives.
    expect(turnProgress(messages.slice(0, 2), working)).toEqual({ current: "Getting ready", steps: [] });
  });

  it("is fixing a problem after a retry, keeping the Agent's own list over tool calls described in plain words", () => {
    const plan = steps([["Adding a list", true], ["Testing it", true]]);
    const messages = [developer("1"), agent("2", [plan]), retry("3"), agent("4", [text("Fixing it."), tool("edit", { path: "/src/a.ts" })])];
    expect(turnProgress(messages, working)).toEqual({
      current: "Fixing a problem",
      steps: [
        { label: "Adding a list", done: true },
        { label: "Testing it", done: true },
      ],
    });
    // Until the Agent gives a new list after the retry.
    const replanned = [...messages, agent("5", [steps([["Fixing the list", false]])])];
    expect(turnProgress(replanned, working).current).toBe("Fixing the list");
  });

  it("is finishing off once every step is ticked", () => {
    const messages = [developer("1"), agent("2", [steps([["Adding a list", true]])])];
    expect(turnProgress(messages, working).current).toBe("Finishing off");
  });

  it("describes the tool calls when the Agent gave no list", () => {
    const messages = [developer("1"), agent("2", [tool("read", { path: "/a" }), tool("write", { path: "/a" }, "input-available")])];
    expect(turnProgress(messages, working).current).toBe("Changing your app");
  });

  it("is making sure it works while the platform checks the Agent's work", () => {
    const messages = [developer("1"), agent("2", [steps([["Adding a list", true]])])];
    expect(turnProgress(messages, { ...working, stage: "checking" })).toEqual({
      current: "Making sure it works",
      steps: [{ label: "Adding a list", done: true }],
    });
  });
});

describe("starting the app", () => {
  const developer: UIMessage = { id: "1", role: "user", parts: [text("A sign-up sheet for my running club")] };
  const agent = (...parts: Part[]): UIMessage => ({ id: "2", role: "assistant", parts });

  it("is seen once start_app has finished, so the page can show the app's name while the Turn goes on", () => {
    expect(appStartedIn([developer])).toBe(false);
    expect(appStartedIn([developer, agent(tool("start_app", { template: "worker-react", name: "Sunday Runs" }, "input-available"))])).toBe(false);
    expect(appStartedIn([developer, agent(tool("start_app", { template: "worker-react", name: "Sunday Runs" }), tool("write", {}))])).toBe(true);
  });
});
