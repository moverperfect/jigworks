// PROTOTYPE, throwaway: a scripted Agent for the chat-first variants. Nothing here talks to the platform.
// Every request builds the same app, "Sunday Runs", so the variants can be compared on the same data.
import { useEffect, useRef, useState } from "react";

export type StepStatus = "running" | "done" | "fixing" | "failed";

/** One thing the Agent does in a Turn. */
export interface Step {
  /** Plain words, for anyone. */
  label: string;
  /** What actually happened, in a developer's words. */
  detail: string;
  status: StepStatus;
  /** What the step decided, such as the starting point it chose. */
  result?: string;
}

export interface YourMessage {
  id: string;
  from: "you";
  text: string;
  /** The part of the app the person pointed at, if they did. */
  pointedAt?: string;
}

export interface AgentMessage {
  id: string;
  from: "agent";
  text: string;
  steps: Step[];
  /** The app version this Turn finished on, when it changed the app. */
  builtVersion?: number;
  /** Answers the Agent offers when it asks a question. */
  choices?: string[];
  failed?: boolean;
  /** Whether this message is the plan, in the plan-first flow. */
  isPlan?: boolean;
}

export type Message = YourMessage | AgentMessage;

/** The app being built. The variants all render it with FakeApp. */
export interface AppFeatures {
  waitingList: boolean;
  sporty: boolean;
  emailOrganiser: boolean;
  /** Parts of the app made bigger after someone pointed at them. */
  emphasised: string[];
}

/** Which Template the Agent picked, and why, in plain words. */
export interface StartingPoint {
  plain: string;
  template: string;
  why: string;
}

export interface Plan {
  name: string;
  summary: string;
  who: string;
  can: { text: string; on: boolean; added?: boolean }[];
  remembers: string;
  startingPoint: StartingPoint;
}

/** One line per finished Turn, in plain words. */
export interface Change {
  id: string;
  text: string;
  at: number;
  version: number;
  failed?: boolean;
}

export type Phase = "start" | "planning" | "planned" | "working" | "ready";

export interface SimState {
  phase: Phase;
  appName: string | null;
  plan: Plan | null;
  messages: Message[];
  /** Null until the first Build. */
  app: AppFeatures | null;
  /** 0 until the first Build; one more for each Turn that changes the app. */
  version: number;
  published: { version: number; at: number } | null;
  suggestions: string[];
  turnStartedAt: number | null;
  /** Plain words for what the running Turn is doing now. */
  activity: string | null;
  /** Steps done and total in the running Turn. */
  progress: { done: number; total: number } | null;
  /** The change the Agent asked a question about, waiting for the answer. */
  pendingQuestion: "emailOrganiser" | null;
  changes: Change[];
}

export const appUrl = "sunday-runs.jigworks.app";

/** The files the Agent made, for the variants' "see the code" escape hatch. */
export const codeFiles = [
  "index.html",
  "package.json",
  "src/client/App.tsx",
  "src/client/main.tsx",
  "src/index.ts",
  "src/sign-ups.ts",
  "wrangler.jsonc",
];

export const ideas = [
  "A sign-up sheet for my running club's Sunday runs",
  "A page where neighbours can borrow my lawnmower",
  "A rota for who's cleaning the office kitchen",
];

const initialState: SimState = {
  phase: "start",
  appName: null,
  plan: null,
  messages: [],
  app: null,
  version: 0,
  published: null,
  suggestions: [],
  turnStartedAt: null,
  activity: null,
  progress: null,
  pendingQuestion: null,
  changes: [],
};

const startingPoint: StartingPoint = {
  plain: "A web page that remembers things",
  template: "Worker + React",
  why: "People need to put their names down, so the app needs somewhere to keep them.",
};

const firstPlan: Plan = {
  name: "Sunday Runs",
  summary: "A page for your running club's Sunday runs.",
  who: "Anyone you send the link to. Nobody needs an account.",
  can: [
    { text: "See when and where the next run is", on: true },
    { text: "Put their name down", on: true },
    { text: "See who else is coming", on: true },
  ],
  remembers: "The names of the people coming to each run.",
  startingPoint,
};

const firstSuggestions = ["Add a waiting list when it's full", "Make it look sportier", "Email me when someone signs up"];

type Apply = (state: SimState) => SimState;
interface Frame {
  wait: number;
  apply: Apply;
}

let lastId = 0;
const newId = () => `p${++lastId}`;

function updateAgent(state: SimState, id: string, change: (message: AgentMessage) => AgentMessage): SimState {
  return {
    ...state,
    messages: state.messages.map((message) => (message.id === id && message.from === "agent" ? change(message) : message)),
  };
}

/** Frames that type `text` into a message a few words at a time. */
function typeText(id: string, text: string, after = ""): Frame[] {
  const words = text.split(" ");
  const frames: Frame[] = [];
  for (let end = 3; end < words.length + 3; end += 3) {
    const shown = words.slice(0, end).join(" ");
    frames.push({ wait: 70, apply: (s) => updateAgent(s, id, (m) => ({ ...m, text: after + shown })) });
  }
  return frames;
}

interface StepScript {
  label: string;
  detail: string;
  result?: string;
  ms?: number;
  /** Applied when the step finishes. */
  effect?: Apply;
}

type CheckOutcome = "passes" | "fixes" | "fails";

/** A Turn: the Agent says what it'll do, works through its steps, checks its work, and says how it went. */
function turnFrames(options: {
  intro: string;
  steps: StepScript[];
  check: CheckOutcome;
  outro: string;
  failedOutro: string;
  /** What finishing the Turn does to the app. */
  onDone: Apply;
  change: string;
  suggestions: string[];
  failedSuggestions: string[];
}): Frame[] {
  const id = newId();
  const total = options.steps.length + 1;
  const frames: Frame[] = [
    {
      wait: 400,
      apply: (s) => ({
        ...s,
        phase: "working",
        turnStartedAt: Date.now(),
        suggestions: [],
        activity: "Thinking…",
        progress: { done: 0, total },
        messages: [...s.messages, { id, from: "agent", text: "", steps: [] }],
      }),
    },
    ...typeText(id, options.intro),
  ];

  options.steps.forEach((step, index) => {
    frames.push({
      wait: 500,
      apply: (s) => ({
        ...updateAgent(s, id, (m) => ({ ...m, steps: [...m.steps, { label: step.label, detail: step.detail, status: "running" }] })),
        activity: `${step.label}…`,
      }),
    });
    frames.push({
      wait: step.ms ?? 1400,
      apply: (s) => {
        const next = updateAgent(s, id, (m) => ({
          ...m,
          steps: m.steps.map((x, i) => (i === index ? { ...x, status: "done", result: step.result } : x)),
        }));
        return { ...(step.effect ? step.effect(next) : next), progress: { done: index + 1, total } };
      },
    });
  });

  const checkIndex = options.steps.length;
  const setCheck = (status: StepStatus, detail: string, result?: string): Apply => (s) =>
    updateAgent(s, id, (m) => ({
      ...m,
      steps: m.steps.map((x, i) => (i === checkIndex ? { ...x, status, detail, result } : x)),
    }));

  frames.push({
    wait: 500,
    apply: (s) => ({
      ...updateAgent(s, id, (m) => ({
        ...m,
        steps: [...m.steps, { label: "Making sure it works", detail: "Running the Check and a Build", status: "running" }],
      })),
      activity: "Making sure it works…",
    }),
  });

  if (options.check !== "passes") {
    const tries = options.check === "fixes" ? 1 : 3;
    for (let attempt = 1; attempt <= tries; attempt++) {
      frames.push({
        wait: 1200,
        apply: (s) => ({
          ...setCheck(
            "fixing",
            `The Check found 2 errors in src/sign-ups.ts. Retry ${attempt} of 3.`,
            `Found a problem, fixing it (try ${attempt} of 3)`,
          )(s),
          activity: `Found a problem, fixing it (try ${attempt} of 3)…`,
        }),
      });
    }
  }

  const failed = options.check === "fails";
  frames.push({
    wait: 1300,
    apply: (s) => {
      const checked = failed
        ? setCheck("failed", "The Check still found 2 errors after 3 retries. The Preview keeps the last good Build.", "Couldn't fix it")(s)
        : setCheck("done", "The Check found no errors. The Build is done.", "All good")(s);
      return { ...checked, activity: null };
    },
  });
  // The outro follows the intro in the same message.
  frames.push(...typeText(id, failed ? options.failedOutro : options.outro, `${options.intro}\n\n`));
  frames.push({
    wait: 200,
    apply: (s) => {
      const ended: SimState = {
        ...s,
        phase: "ready",
        turnStartedAt: null,
        activity: null,
        progress: null,
        suggestions: failed ? options.failedSuggestions : options.suggestions,
      };
      if (failed) {
        return {
          ...updateAgent(ended, id, (m) => ({ ...m, failed: true })),
          changes: [...s.changes, { id, text: `Couldn't: ${options.change}`, at: Date.now(), version: s.version, failed: true }],
        };
      }
      const done = options.onDone(ended);
      const version = s.version + 1;
      return {
        ...updateAgent({ ...done, version }, id, (m) => ({ ...m, builtVersion: version })),
        changes: [...s.changes, { id, text: options.change, at: Date.now(), version }],
      };
    },
  });
  return frames;
}

function yourMessage(text: string, pointedAt?: string): Frame {
  const id = newId();
  return { wait: 0, apply: (s) => ({ ...s, messages: [...s.messages, { id, from: "you", text, pointedAt }] }) };
}

function firstBuild(check: CheckOutcome): Frame[] {
  return turnFrames({
    intro: "Lovely idea. I'll make a page where runners can see the next run and put their names down, and you can see who's coming.",
    steps: [
      {
        label: "Choosing a starting point",
        detail: "Chose the Worker + React Template",
        result: startingPoint.plain,
        ms: 1100,
        effect: (s) => ({ ...s, plan: s.plan ?? firstPlan }),
      },
      { label: "Naming your app", detail: "Named the Workspace “Sunday Runs”", result: "Sunday Runs", ms: 700, effect: (s) => ({ ...s, appName: "Sunday Runs" }) },
      { label: "Designing the sign-up page", detail: "Wrote src/client/App.tsx and index.html" },
      { label: "Keeping track of who's coming", detail: "Wrote src/index.ts and src/sign-ups.ts: a Durable Object keeps the sign-ups" },
    ],
    check,
    outro: "Your app's ready. Have a go: put your name down and it'll appear in the list. When you're happy, publish it and send the link to your club.",
    failedOutro:
      "I couldn't get the app working, even after three tries. Nothing's broken on your side. Shall I try again, maybe a simpler version first?",
    onDone: (s) => ({ ...s, app: { waitingList: false, sporty: false, emailOrganiser: false, emphasised: [] } }),
    change: "Made the sign-up page",
    suggestions: firstSuggestions,
    failedSuggestions: ["Try again", "Make a simpler version first"],
  });
}

interface ChangeScript {
  key: "waitingList" | "sporty" | "emailOrganiser";
  match: RegExp;
  label: string;
  detail: string;
  intro: string;
  outro: string;
  change: string;
  planItem?: string;
}

const changeScripts: ChangeScript[] = [
  {
    key: "waitingList",
    match: /wait|full|limit|space|place|cap/i,
    label: "Adding a waiting list",
    detail: "Edited src/sign-ups.ts and src/client/App.tsx",
    intro: "Good thinking. I'll cap each run at 8 people and put anyone after that on a waiting list.",
    outro: "Done. Once 8 people have signed up, new names go on the waiting list, and the first person waiting moves up if someone drops out.",
    change: "Added a waiting list",
    planItem: "Join a waiting list when the run's full",
  },
  {
    key: "sporty",
    match: /look|colou?r|sport|green|bright|bold|style|design|pretty|nicer/i,
    label: "Changing the look",
    detail: "Edited src/client/App.tsx",
    intro: "Let's give it some energy.",
    outro: "I've gone for a bold green with a chunkier heading. If you'd like your club's colours instead, tell me what they are.",
    change: "Gave it a sportier look",
  },
  {
    key: "emailOrganiser",
    match: /email|e-mail|tell me|notif|remind|let me know/i,
    label: "Setting up the emails",
    detail: "Added an Email Sending binding in wrangler.jsonc; edited src/sign-ups.ts",
    intro: "Right, emails it is.",
    outro: "Done. You'll get an email each time someone puts their name down. Try it: add a name and I'll show you the email it would send.",
    change: "Emails you when someone signs up",
    planItem: "Email you when someone signs up",
  },
];

function changeTurn(script: ChangeScript, check: CheckOutcome): Frame[] {
  return turnFrames({
    intro: script.intro,
    steps: [{ label: script.label, detail: script.detail }],
    check,
    outro: script.outro,
    failedOutro: `I couldn't get that working after three tries, so I've left your app as it was: what you can see still works. Shall I try a different way?`,
    onDone: (s) => ({
      ...s,
      app: s.app && { ...s.app, [script.key]: true },
      plan: s.plan && script.planItem ? { ...s.plan, can: [...s.plan.can, { text: script.planItem, on: true, added: true }] } : s.plan,
    }),
    change: script.change,
    suggestions: remainingSuggestions(script.key),
    failedSuggestions: ["Try a different way", "Leave it for now"],
  });
}

function remainingSuggestions(done: string): string[] {
  return firstSuggestions.filter((_, i) => changeScripts[i]?.key !== done).slice(0, 2).concat("Change the meeting point");
}

function pointedTurn(text: string, pointed: { id: string; label: string }, check: CheckOutcome): Frame[] {
  return turnFrames({
    intro: `On it: ${pointed.label}.`,
    steps: [{ label: `Changing ${pointed.label}`, detail: "Edited src/client/App.tsx" }],
    check,
    outro: `Done. I've made ${pointed.label} stand out more. Tell me if it's too much.`,
    failedOutro: "I couldn't get that working after three tries, so I've left your app as it was.",
    onDone: (s) => ({ ...s, app: s.app && { ...s.app, emphasised: [...s.app.emphasised, pointed.id] } }),
    change: `Changed ${pointed.label}: “${text}”`,
    suggestions: firstSuggestions,
    failedSuggestions: ["Try a different way"],
  });
}

function genericTurn(text: string, check: CheckOutcome): Frame[] {
  return turnFrames({
    intro: "Sure.",
    steps: [{ label: "Making your change", detail: "Edited src/client/App.tsx" }],
    check,
    outro: "Done. (This prototype's Agent only really knows the suggested changes, so nothing you can see has moved.)",
    failedOutro: "I couldn't get that working after three tries, so I've left your app as it was.",
    onDone: (s) => s,
    change: `“${text}”`,
    suggestions: firstSuggestions,
    failedSuggestions: ["Try a different way"],
  });
}

function questionFrames(): Frame[] {
  const id = newId();
  return [
    {
      wait: 400,
      apply: (s) => ({ ...s, phase: "working", turnStartedAt: Date.now(), suggestions: [], activity: "Thinking…", messages: [...s.messages, { id, from: "agent", text: "", steps: [] }] }),
    },
    ...typeText(id, "Happy to. Which address should the emails go to?"),
    {
      wait: 200,
      apply: (s) => ({
        ...updateAgent(s, id, (m) => ({ ...m, choices: ["My sign-in address", "A different address"] })),
        phase: "ready",
        turnStartedAt: null,
        activity: null,
        pendingQuestion: "emailOrganiser",
      }),
    },
  ];
}

function planFrames(): Frame[] {
  const id = newId();
  return [
    { wait: 300, apply: (s) => ({ ...s, phase: "planning", activity: "Working out what you need…", messages: [...s.messages, { id, from: "agent", text: "", steps: [], isPlan: true }] }) },
    ...typeText(id, "Here's what I'm planning. Untick anything you don't want, or tell me what's missing, then I'll build it."),
    { wait: 900, apply: (s) => ({ ...s, phase: "planned", activity: null, plan: firstPlan, appName: firstPlan.name }) },
  ];
}

/** Moments the floating bar can jump straight to, so every variant can be compared at the same point. */
export const moments = ["start", "working", "ready", "question", "problem", "published"] as const;
export type Moment = (typeof moments)[number];

const firstRequest = ideas[0]!;

export interface Sim {
  state: SimState;
  paused: boolean;
  nextTurnFails: boolean;
  start(request: string, options?: { planFirst?: boolean }): void;
  approvePlan(): void;
  togglePlanItem(index: number): void;
  send(text: string, pointed?: { id: string; label: string }): void;
  publish(): void;
  jump(to: Moment): void;
  reset(): void;
  setPaused(paused: boolean): void;
  setNextTurnFails(fails: boolean): void;
}

export function useSimulation(): Sim {
  const [state, setState] = useState<SimState>(initialState);
  const [paused, setPausedState] = useState(false);
  const [nextTurnFails, setNextTurnFails] = useState(false);
  const queue = useRef<Frame[]>([]);
  const timer = useRef<number | null>(null);
  const pausedRef = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;

  function pump() {
    if (timer.current !== null || pausedRef.current) return;
    const next = queue.current[0];
    if (!next) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      const frame = queue.current.shift();
      if (frame) setState(frame.apply);
      pump();
    }, next.wait);
  }

  function clear() {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    queue.current = [];
  }

  useEffect(() => clear, []);

  function run(frames: Frame[]) {
    queue.current.push(...frames);
    pump();
  }

  function check(): CheckOutcome {
    if (!nextTurnFails) return "passes";
    setNextTurnFails(false);
    return "fails";
  }

  function setPaused(value: boolean) {
    pausedRef.current = value;
    setPausedState(value);
    if (value && timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    if (!value) pump();
  }

  const fold = (frames: Frame[], from: SimState = initialState) => frames.reduce((s, f) => f.apply(s), from);

  function start(request: string, options?: { planFirst?: boolean }) {
    if (stateRef.current.phase !== "start") return;
    run([yourMessage(request), ...(options?.planFirst ? planFrames() : firstBuild(check()))]);
  }

  return {
    state,
    paused,
    nextTurnFails,
    start,
    approvePlan() {
      if (stateRef.current.phase !== "planned") return;
      run([yourMessage("Looks good, build it"), ...firstBuild(check())]);
    },
    togglePlanItem(index) {
      setState((s) =>
        s.plan ? { ...s, plan: { ...s.plan, can: s.plan.can.map((item, i) => (i === index ? { ...item, on: !item.on } : item)) } } : s,
      );
    },
    send(text, pointed) {
      const s = stateRef.current;
      if (s.phase === "working" || s.phase === "planning") return;
      if (s.phase === "start") return start(text);
      if (s.phase === "planned") {
        run([yourMessage(text), ...planFrames()]);
        return;
      }
      const outcome = check();
      if (s.pendingQuestion === "emailOrganiser") {
        const answered: Frame = { wait: 0, apply: (x) => ({ ...x, pendingQuestion: null }) };
        run([yourMessage(text), answered, ...changeTurn(changeScripts[2]!, outcome)]);
        return;
      }
      if (!s.app) {
        run([yourMessage(text), ...firstBuild(outcome)]);
        return;
      }
      if (pointed) {
        run([yourMessage(text, pointed.label), ...pointedTurn(text, pointed, outcome)]);
        return;
      }
      const script = changeScripts.find((c) => c.match.test(text));
      if (script?.key === "emailOrganiser" && !s.app.emailOrganiser) {
        run([yourMessage(text), ...questionFrames()]);
        return;
      }
      run([yourMessage(text), ...(script ? changeTurn(script, outcome) : genericTurn(text, outcome))]);
    },
    publish() {
      setState((s) => ({ ...s, published: { version: s.version, at: Date.now() } }));
    },
    jump(to) {
      clear();
      setPaused(false);
      const built = fold([yourMessage(firstRequest), ...firstBuild("passes")]);
      if (to === "start") setState(initialState);
      else if (to === "working") {
        const frames = [yourMessage(firstRequest), ...firstBuild("passes")];
        const upTo = frames.findIndex((_, i) => {
          const s = fold(frames.slice(0, i + 1));
          return s.progress?.done === 2;
        });
        setState(fold(frames.slice(0, upTo + 2)));
        queue.current = frames.slice(upTo + 2);
        setPaused(true);
      } else if (to === "ready") setState(built);
      else if (to === "question") setState(fold([yourMessage("Email me when someone signs up"), ...questionFrames()], built));
      else if (to === "problem") setState(fold([yourMessage("Add a waiting list when it's full"), ...changeTurn(changeScripts[0]!, "fails")], built));
      else if (to === "published") {
        const changed = fold([yourMessage("Add a waiting list when it's full"), ...changeTurn(changeScripts[0]!, "passes")], built);
        setState({ ...changed, published: { version: 1, at: Date.now() - 3_600_000 } });
      }
    },
    reset() {
      clear();
      setPaused(false);
      setState(initialState);
    },
    setPaused,
    setNextTurnFails,
  };
}

/** Whether the app has changes the published version doesn't. */
export const hasUnpublishedChanges = (s: SimState) => s.published !== null && s.version > s.published.version;

/** The latest Agent message, for variants that only show the last reply. */
export function latestAgentMessage(s: SimState): AgentMessage | undefined {
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const message = s.messages[i]!;
    if (message.from === "agent") return message;
  }
  return undefined;
}

export function formatAgo(at: number, now = Date.now()): string {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"} ago`;
}
