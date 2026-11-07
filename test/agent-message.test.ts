import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { agentMessageBlocks, describeRetry, describeTool, stepsDone, turnProgress } from "../client/src/agentMessage";

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
