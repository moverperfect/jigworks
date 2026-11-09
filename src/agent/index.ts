import { createAnthropic } from "@ai-sdk/anthropic";
import type { TurnConfig } from "@cloudflare/think";
import { generateText, getToolName, isToolUIPart, tool, type LanguageModel, type StopCondition, type ToolSet, type UIMessage } from "ai";
import { z } from "zod";
import { isSecretName, secretNameRule } from "../apphost/secrets";
import { normalisePath } from "../files";
import { isWarning, type AppLogEntry } from "../shared/app-logs";
import type { BuildProblem, BuildReport } from "../shared/build-report";
import type { CheckReport, PackageStatus, Problem } from "../shared/check-report";
import { askingTools, maxRetries, type LastTurn, type MessageMetadata } from "../shared/conversation";
import { failuresOf, testFailures, type TestCounts, type TestReport } from "../shared/test-report";
import { addonHeading, listAddons, listTemplates } from "../templates";
import type { AddonsAdded, Workspace } from "../workspace";

/** The Agent's model: `AGENT_MODEL` on the Anthropic API, or on the scripted model at `AGENT_BASE_URL`. */
export function agentModel(env: Env): LanguageModel {
  return createAnthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: env.AGENT_BASE_URL || undefined })(env.AGENT_MODEL);
}

/** The Anthropic settings for each of a Turn's model calls. */
export const turnProviderOptions: TurnConfig["providerOptions"] = {
  anthropic: {
    // Opus 5.5 defaults to medium; coding across many steps does better higher.
    effort: "high",
    // A Turn a safety classifier declines is retried on the model Anthropic recommends.
    fallbacks: "default",
    // Caches the prompt up to its newest message, so each step pays full
    // price only for what's new.
    cacheControl: { type: "ephemeral" },
    // A thinking block that no longer matches the history before it, as
    // after Start fresh, is dropped rather than refused.
    thinking: { blockBinding: { prefixMismatchBehavior: "drop_block" } },
  },
};

/** The Agent's standing instructions, for Developers who don't write code (ADR 0018). Each Turn adds the Workspace's AGENTS.md (see `withAgentsMd`). */
export const instructions = `You are the Agent on a development platform where you build Cloudflare Workers apps for a Developer, entirely in the browser. Most Developers don't write code: they say what they want in their own words, and you build it. You work in one Workspace. Its files are at the root of your file system, such as /package.json and /src/index.ts.

Talking with the Developer:
- Use plain, everyday words. Never put code, file names, commands or error messages in your replies, unless the Developer asks for them. The page keeps your tool calls behind "Technical details" for anyone curious.
- Use the page's words: "your app" for the Workspace and what it runs, "live" for an app that's published, "making sure it works" for the checks that end each Turn, and "a ready-made part" for a Package. Don't say Workspace, Turn, Check, Build, Template, add-on, Package, Preview or Deployment.
- Keep replies short: a sentence or two before you start, and at the end one paragraph of no more than three plain sentences, saying what changed and what the Developer could try in their app. No headings, lists or second paragraph, and don't say how you made sure it works: the steps show that.
- Show what you're doing with the steps tool. Call it at the start of every Turn with the steps you plan, each in a few plain words such as "Adding a waiting list", and again as each step finishes, with that step ticked off. Make each call alongside your other tool calls in the same step, so it doesn't use up a step of its own. Keep to 2 to 6 steps. If your plan changes, call it with the new list. When a step decides something, give it a detail saying what it decided, in a few plain words, which the page shows under the step.
- When something only the Developer can decide would change what you build, ask rather than guess: call ask with the question and 2 to 4 answers they can pick, and stop there. Ask before you change any files: a Turn that ends with a question gets no retries, so if the app doesn't work then, your changes are put back. Put the question in ask only, not in your reply as well. Otherwise choose something sensible and say what you chose.
- At the end of a Turn, suggest 2 or 3 next changes with suggest, each a short request in the Developer's own voice, such as "Add a waiting list when it's full". Not in a Turn that ends with a question.
- When the platform asks you to fix problems after a Turn, fix them without fuss. The Developer sees this as normal work.

Starting the app:
- A new Workspace has no files: it starts from the Developer's description of the app they want. Before anything else, start the app with start_app, alongside your first call to steps and no other tool: choose the Template that suits the description, and a short name for the app from it, such as Sunday Runs. In that call to steps, tick off "Choosing a starting point" and "Naming your app", with what you chose as their details, such as "A web page that remembers things" and "Sunday Runs". The platform writes the Template's files and makes the app's web address from the name. Until the app is started, the tools that change, check, build or test files refuse. Then tell the Developer in plain words what you started from and why, such as "a web page that remembers things, because people need to put their names down". The Templates:
${listTemplates()
  .map(({ id, name, description, fits }) => `  - ${id} (${name}): ${description} ${fits}`)
  .join("\n")}

Add-ons:
- An add-on is a tested set of files and notes that gives the app one ability. Add one with add_addon, in the first Turn or any later one, whenever the Developer's request needs its ability: prefer it to writing the same ability yourself. It brings the add-ons it needs, writes its own files, and adds its notes to AGENTS.md, which then say how to use it. It doesn't change your files: it tells you the edits that join it to the app, which you then make, and the secrets it needs. An app already has an add-on when its AGENTS.md has a heading naming it, such as "${addonHeading("storage", "Storage")}".
- An add-on's secrets are the one exception to asking before you change files: ask for them with ask_for_secret once you've made its edits and the app works, so your changes are kept.
- Give each add-on its own step, saying in plain words what it adds, such as "Adding somewhere to keep things", with what it gave as its detail, such as "A store for the messages". The add-ons:
${listAddons()
  .map(({ id, name, description, fits }) => `  - ${id} (${name}): ${description} ${fits}`)
  .join("\n")}

How you work:
- Change files with the file tools or bash. Bash works on the Workspace's files only: there's no network, no npm and no Node.js.
- Add an npm Package with add_package, which picks a version that's at least a day old. Don't add one by editing package.json.
- The check tool type-checks the Workspace and returns its errors. The build tool builds it the way the platform runs it and returns any Build errors. Every Turn ends with a Check and then a Build. If either has errors you'll be asked to fix them, up to ${maxRetries} times in all, and if the Preview then logs errors or warnings you'll be shown them, which uses one of those times too. If the Check or the Build still has errors after that, the platform puts the files back as they were when the Turn started, so the Developer's app keeps working, and tells you at the start of your next Turn.
- A Build that says your app has grown too big to build here ran out of memory, which no change to the code fixes. Don't remove Packages yourself: tell the Developer in plain words, suggest one the app could do without, such as one you just added, and change nothing more.
- Write tests in files named like src/index.test.ts, with vitest's API: describe, it, expect, vi.fn, vi.spyOn and fake timers. vi.mock and snapshots aren't supported, and there's no DOM. Run them with the test tool. Every Turn ends with the tests as well, after the Build; failing tests don't use up your retries, but the Developer sees them.
- Each successful Build becomes the Preview, which the Developer sees beside the Conversation as their app. After a Build that changes it, the platform tries it with GET /, waits a few seconds, and gives you what it answered and the errors and warnings it logged since that Build, front-end errors from an open Preview pane included: in the build tool's result, or after your Turn. Judge which need fixing: some warnings are harmless.
- After building, try what you changed against the Preview with request_preview, beyond GET /: the routes, forms and actions you added or changed, as a browser would send them. Then read its server logs and front-end errors with preview_logs.
- The Developer gives the Workspace secrets, which reach the app's env by name. list_secrets gives their names; nobody shows you their values, and a value in what the Preview answers or logs shows as [secret NAME].
- When the app needs a secret the Developer hasn't given, such as an email service's key, ask for it with ask_for_secret, saying why and where they'll find it, and stop there. As with a question, ask before you change any files, or your changes are put back if the app doesn't work then. Don't ask them to type or paste it to you, or to add it themselves from a menu. ask_for_secret is only for values that must stay secret, such as keys and passwords. Anything else the app needs, such as the address emails go to, ask for with ask, or choose something sensible.
- A secret can be wrong, such as a key the service refuses, and you can't tell until the app uses it. Once the Developer adds one, try the part of the app that uses it once, with request_preview, and read preview_logs. If the service refused it, say so plainly and ask them to check it. Never say it works, or that an email should arrive, before you've seen it work.
- The Developer can't change files while your Turn runs. If they changed files since your last Turn, their message says which. Read those files before you change them.`;

/** Ends a Think turn after the step in which the Agent asked the Developer something, once `ask` or `ask_for_secret` took it. */
export const stopAfterQuestion: StopCondition<ToolSet> = ({ steps }) =>
  steps.at(-1)?.toolResults.some((result) => askingTools.has(result.toolName)) ?? false;

/** What an Agent message last asked the Developer for with a call its tool took, which ended its Think turn, or null. */
export function askedIn(message: UIMessage | undefined): LastTurn["asked"] {
  if (message?.role !== "assistant") return null;
  for (const part of message.parts.toReversed()) {
    const asked = isToolUIPart(part) && part.state === "output-available" ? askingTools.get(getToolName(part)) : undefined;
    if (asked) return asked;
  }
  return null;
}

/** What starts a Turn: the Developer's message, or the Secret they added when the Agent asked for it. */
export type TurnRequest = string | { addedSecret: string };

/** The Turn's instructions: Think's, then the Workspace's AGENTS.md as it is now. */
export function withAgentsMd(system: string, agentsMd: string | null): string {
  return agentsMd === null
    ? `${system}\n\nThe Workspace has no AGENTS.md.`
    : `${system}\n\nThe Workspace's AGENTS.md says:\n\n<agents-md>\n${agentsMd}\n</agents-md>`;
}

/**
 * The Developer's message starting the Turn that started at `turnStartedAt`,
 * with the platform's notes: whether the last Turn was undone, and the files
 * the Developer changed since it. The page shows only the first part. When
 * they started it by adding a Secret, that part is the platform's note of
 * its name.
 */
export function developerMessage(request: TurnRequest, changedFiles: string[], turnStartedAt: string, undone: boolean): UIMessage<MessageMetadata> {
  const text = typeof request === "string" ? request : addedSecretNote(request.addedSecret);
  const addedSecret = typeof request === "string" ? undefined : request.addedSecret;
  const parts: UIMessage["parts"] = [{ type: "text", text }];
  if (undone) {
    parts.push({ type: "text", text: "(From the platform: your last Turn's changes were put back, because the app didn't work after them.)" });
  }
  if (changedFiles.length > 0) {
    const list = changedFiles.map((path) => `/${path}`).join(", ");
    parts.push({
      type: "text",
      text: `(From the platform: since your last Turn, the Developer changed ${list}. Read them before you change them.)`,
    });
  }
  return { id: crypto.randomUUID(), role: "user", parts, metadata: { from: "developer", changedFiles, turnStartedAt, addedSecret } };
}

/**
 * The platform's note starting the Turn after the Developer added the Secret
 * `name`: a key can be wrong, and only trying the app shows it (#104).
 */
export const addedSecretNote = (name: string) =>
  `(From the platform: the Developer added the Secret ${name}. Try the part of the app that uses it once with request_preview, then read preview_logs, minding only the lines logged for your request. If it was refused, say so plainly and ask the Developer to check it, rather than saying it works.)`;

/**
 * What came of the platform trying a new Preview: the status `GET /` answered
 * with, or null if it didn't answer within `waitSeconds`, and the errors and
 * warnings logged since its Build.
 */
export interface PreviewTry {
  status: number | null;
  waitSeconds: number;
  problems: AppLogEntry[];
}

/**
 * The platform's message after a Turn's Check and Build, asking the Agent to
 * fix the errors they found, and to judge the errors and warnings the
 * Preview logged when the platform tried it (`previewTry`), if any.
 */
export function fixMessage(check: CheckReport, build: BuildReport, retry: number, previewTry: PreviewTry | null): UIMessage<MessageMetadata> {
  const errors = check.counts.error;
  const buildErrors = build.errors.length;
  const previewProblems = previewTry?.problems.length ?? 0;
  const found: [summary: string, details: string][] = [];
  if (errors > 0) found.push([`the Check found ${plural(errors, "error")}`, describeCheck(check)]);
  if (buildErrors > 0) found.push([`the Build failed with ${plural(buildErrors, "error")}`, describeBuild(build)]);
  if (previewTry && previewProblems > 0) found.push([`the Preview logged ${countProblems(previewTry.problems)} when the platform tried it`, describePreviewTry(previewTry)]);
  const summary = found.map(([text]) => text).join(" and ");
  const details = found.map(([, text]) => text).join("\n\n");
  const ask =
    errors + buildErrors === 0
      ? "Fix any that need it. If none do, change nothing and end your Turn."
      : previewProblems > 0
        ? "Fix the errors, and any of the Preview's that need it."
        : "Fix them.";
  const text = `After your Turn, ${summary}. ${ask} This is retry ${retry} of ${maxRetries}.\n\n${details}`;
  return {
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text }],
    metadata: { from: "check", errors, buildErrors, retry },
  };
}

const previewProblemsShown = 50;

/** A try of the Preview as text for the Agent. */
export function describePreviewTry({ status, waitSeconds, problems }: PreviewTry): string {
  const answered = `The platform tried the Preview with GET /, which ${status === null ? `didn't answer within ${waitSeconds} seconds` : `answered ${status}`}.`;
  if (problems.length === 0) return `${answered} It has logged no errors or warnings since this Build.`;
  const lines = [`${answered} Since this Build, it has logged ${countProblems(problems)}:`];
  for (const entry of problems.slice(0, previewProblemsShown)) lines.push(`${entry.at} ${entry.source} ${entry.level}: ${entry.message}`);
  if (problems.length > previewProblemsShown) lines.push(`…and ${problems.length - previewProblemsShown} more.`);
  return lines.join("\n");
}

/** For example "1 error and 2 warnings". */
export function countProblems(problems: AppLogEntry[]): string {
  const warnings = problems.filter(isWarning).length;
  const errors = problems.length - warnings;
  return [errors > 0 && plural(errors, "error"), warnings > 0 && plural(warnings, "warning")].filter(Boolean).join(" and ");
}

/** A Build report as text for the Agent. */
export function describeBuild(report: BuildReport): string {
  const lines = report.ok ? ["The Build succeeded."] : ["The Build failed:", ...report.errors.map(describeBuildProblem)];
  for (const warning of report.warnings) lines.push(`Build warning: ${describeBuildProblem(warning)}`);
  return lines.join("\n");
}

function describeBuildProblem({ message, file, line, column }: BuildProblem): string {
  return file === null ? message : `/${file}:${line}:${column}: ${message}`;
}

const problemsShown = 50;

/** A Check report as text for the Agent: the Packages' state, then each problem. */
export function describeCheck(report: CheckReport): string {
  const lines: string[] = [];
  const { packages } = report;
  if (packages.state === "failed") lines.push(`The Packages couldn't be installed: ${packages.error ?? "no reason was given."}`);
  for (const warning of packages.warnings) lines.push(`Package warning: ${warning}`);
  const total = Object.values(report.counts).reduce((sum, count) => sum + count, 0);
  if (total === 0) lines.push("The Check found no problems.");
  for (const problem of report.problems.slice(0, problemsShown)) lines.push(describeProblem(problem));
  if (total > problemsShown) lines.push(`…and ${total - problemsShown} more.`);
  return lines.join("\n");
}

function describeProblem(problem: Problem): string {
  const where = problem.file === null ? problem.project : `/${problem.file}:${problem.line}:${problem.column}`;
  const code = problem.code === 0 ? "" : ` TS${problem.code}`;
  return `${where} ${problem.severity}${code}: ${problem.message}`;
}

const failuresShown = 30;
const consoleShown = 20;

/**
 * A test report as text for the Agent: each file's counts and failures, with
 * what it logged if it failed, then the totals. `requested` is the files the
 * Agent asked for, if it named any.
 */
export function describeTests(report: TestReport, requested?: string[]): string {
  if (report.bundleErrors.length > 0) {
    return ["The tests couldn't be bundled, so none ran:", ...report.bundleErrors.map(describeBuildProblem)].join("\n");
  }
  const lines: string[] = [];
  const unknown = (requested ?? []).filter((path) => !report.files.some(({ file }) => file === path));
  if (unknown.length > 0) {
    lines.push(`Not test files, so not run: ${unknown.map((path) => `/${path}`).join(", ")}. Test files are named like /src/index.test.ts.`);
  }
  if (report.files.length === 0) return [...lines, "There are no test files to run."].join("\n");
  let shown = 0;
  for (const file of report.files) {
    const counts = countBy(file.tests.map(({ state }) => state));
    const failures = failuresOf(file);
    const outside = file.errors.length > 0 ? `, and ${plural(file.errors.length, "error")} outside tests` : "";
    lines.push(`/${file.file}: ${describeCounts(counts)}${outside}.`);
    for (const { test, failure } of failures) {
      if (shown++ >= failuresShown) continue;
      const where = failure.file === null ? "" : ` (at /${failure.file}:${failure.line}:${failure.column})`;
      lines.push(`  FAILED ${test ? test.name.join(" > ") : "outside any test"}${where}: ${failure.message}`);
      if (failure.diff) lines.push(failure.diff.replace(/^/gm, "    "));
    }
    if (failures.length > 0 && file.console.length > 0) {
      lines.push("  It logged:", ...file.console.slice(0, consoleShown).map((line) => `    ${line}`));
    }
  }
  if (shown > failuresShown) lines.push(`…and ${shown - failuresShown} more failures.`);
  const outside = testFailures(report) - report.counts.failed;
  lines.push(
    `${plural(report.files.length, "test file")}: ${describeCounts(report.counts)}${outside > 0 ? `, and ${plural(outside, "error")} outside tests` : ""}.`,
  );
  return lines.join("\n");
}

/** For example "3 passed, 1 failed, 2 skipped or to do". */
function describeCounts({ passed = 0, failed = 0, skipped = 0, todo = 0 }: Partial<TestCounts>): string {
  return `${passed} passed, ${failed} failed${skipped + todo > 0 ? `, ${skipped + todo} skipped or to do` : ""}`;
}

function countBy<T extends string>(values: T[]): Partial<Record<T, number>> {
  const counts: Partial<Record<T, number>> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

/** The Agent's own tools. Think adds its file tools and bash. */
export function agentTools(workspace: {
  startApp: Workspace["startApp"];
  /** A Check, after the step's other tools have finished. */
  check: () => Promise<CheckReport>;
  /** A Build, after the step's other tools have finished, and the try of the Preview if it changed it. */
  build: () => Promise<{ report: BuildReport; previewTry: PreviewTry | null }>;
  /** A test run, of every test file or only `files`, after the step's other tools have finished. */
  test: (files?: string[]) => Promise<TestReport>;
  addPackageForAgent: Workspace["addPackageForAgent"];
  addAddonForAgent: Workspace["addAddonForAgent"];
  requestPreview: Workspace["requestPreview"];
  previewLogs: Workspace["previewLogs"];
  secretNames: Workspace["secretNames"];
  /** Whether the app has started from a Template (ADR 0018). */
  appStarted: () => boolean;
}): ToolSet {
  return {
    steps: tool({
      description:
        "Shows the Developer what you're doing as a short list of steps, in plain words, ticking each off when it's done. The page shows the latest list in your reply. Call it at the start of a Turn and again as each step finishes. It doesn't end your Turn.",
      inputSchema: z.object({
        steps: z
          .array(
            z.object({
              label: z.string().describe("The step in a few plain words, such as Adding a waiting list."),
              done: z.boolean().describe("Whether the step is finished."),
              detail: z
                .string()
                .optional()
                .describe("What the step decided, in a few plain words, such as A web page that remembers things. Leave it out when there's nothing to add."),
            }),
          )
          .min(1)
          .max(10),
      }),
      execute: async () => "Shown.",
    }),
    ask: tool({
      description:
        "Asks the Developer a question only they can answer, with 2 to 4 answers they can pick as buttons, and ends your Turn: their answer comes as their next message. They can type a different answer instead. Ask only when the answer would change what you build.",
      inputSchema: z.object({
        question: z.string().trim().min(1).describe("The question, in plain words, such as Which address should the emails go to?"),
        // Refused unless the page can show 2 different answers to pick.
        choices: z
          .array(z.string().trim().min(1).describe("An answer in a few words, as the Developer would say it, such as My sign-in address."))
          .min(2)
          .max(4)
          .refine((choices) => new Set(choices).size === choices.length, "Each answer must be different."),
      }),
      execute: async () => "Asked. Your Turn ends here, and the Developer's answer comes as their next message.",
    }),
    ask_for_secret: tool({
      description:
        "Asks the Developer for a secret the app needs, such as an email service's key, and ends your Turn. Only for values that must stay secret, such as keys and passwords: ask for anything else, such as an email address, with ask. The page shows why, with a field that saves the value as a secret under the name, which the app reads from env. The value never enters the Conversation and you never see it. Once they save it, your next Turn starts with the platform's note that they added it, and you try it. They can write to you instead.",
      inputSchema: z.object({
        name: z
          .string()
          .trim()
          .refine(isSecretName, secretNameRule)
          .describe("The secret's name, which the app's code reads from env, such as EMAIL_API_KEY."),
        why: z
          .string()
          .trim()
          .min(1)
          .describe("Why the app needs it and where the Developer finds it, in plain words, such as To send the emails, your app needs a key from your email service. You'll find it in its settings."),
      }),
      execute: async () => {
        // The Developer couldn't save it: their Secrets are refused until then (ADR 0018).
        if (!workspace.appStarted()) throw new Error("The app hasn't started yet, so the Developer can't add a secret. Start it first with start_app.");
        return "Asked. Your Turn ends here, and the platform tells you when the Developer has added it.";
      },
    }),
    suggest: tool({
      description:
        "Suggests up to 3 next changes to the app, which the page shows as buttons once your Turn ends, so the Developer can ask for one with a click. It doesn't end your Turn.",
      inputSchema: z.object({
        suggestions: z
          .array(z.string().trim().min(1).describe("A short request in the Developer's own voice, such as Add a waiting list when it's full."))
          .min(1)
          .max(3),
      }),
      execute: async () => "Shown when your Turn ends.",
    }),
    start_app: tool({
      description:
        "Starts the app from a Template, under a name you choose from the Developer's description: writes the Template's files, installs their Packages, and makes the app's web address from the name. It works once, in a Workspace with no files. Call it before any other tool but steps.",
      inputSchema: z.object({
        template: z.string().describe("The Template's ID, such as worker-react."),
        name: z.string().describe("The app's name, in a few plain words, such as Sunday Runs."),
      }),
      execute: async ({ template, name }) => {
        const result = await workspace.startApp(template, name);
        // Thrown, so the Conversation shows the call as failed. The model still reads the message.
        if (!result.ok) throw new Error(`Couldn't start the app. ${result.error}`);
        // This Turn's instructions were written before the app had an AGENTS.md.
        const agentsMd = result.agentsMd === null ? "" : `\n\nIts AGENTS.md says:\n\n<agents-md>\n${result.agentsMd}\n</agents-md>`;
        return `Started ${name.trim()} from the ${template} Template.${agentsMd}`;
      },
    }),
    check: tool({
      description:
        "Type-checks the Workspace with each tsconfig and returns its errors and Package warnings. Installs Packages first if package.json changed. It sees the changes made by tools called in the same step.",
      inputSchema: z.object({}),
      execute: async () => {
        return describeCheck(await workspace.check());
      },
    }),
    build: tool({
      description:
        "Builds the Workspace with esbuild the way the platform runs it, using wrangler.jsonc, and returns any Build errors and warnings. Type errors don't stop a Build. A successful Build becomes the Preview: when that changes it, the platform tries it with GET / and adds what it answered and the errors and warnings it logged. Installs Packages first if package.json changed. It sees the changes made by tools called in the same step.",
      inputSchema: z.object({}),
      execute: async () => {
        const { report, previewTry } = await workspace.build();
        return previewTry ? `${describeBuild(report)}\n${describePreviewTry(previewTry)}` : describeBuild(report);
      },
    }),
    test: tool({
      description:
        "Runs the Workspace's tests, files named like *.test.ts or *.spec.tsx, each file on its own with the platform's vitest, and returns which tests failed and why, with what their files logged. Installs Packages first if package.json changed. It sees the changes made by tools called in the same step.",
      inputSchema: z.object({
        files: z.array(z.string()).optional().describe("The test files to run, such as /src/index.test.ts. Every test file if left out."),
      }),
      execute: async ({ files }) => {
        const requested = files?.map((path) => {
          try {
            return normalisePath(path);
          } catch {
            return path;
          }
        });
        return describeTests(await workspace.test(requested), requested);
      },
    }),
    add_package: tool({
      description:
        "Adds an npm Package at the newest version that's at least a day old, writes that exact version into package.json and installs it.",
      inputSchema: z.object({
        name: z.string().describe("The Package's name on npm, such as zod or @types/node."),
        range: z.string().optional().describe("A version range to choose within, such as ^4."),
        dev: z.boolean().optional().describe("Whether it goes in devDependencies. @types/ Packages do unless this is false."),
      }),
      execute: async ({ name, range, dev }) => {
        const result = await workspace.addPackageForAgent(name, { range, dev });
        // Thrown, so the Conversation shows the call as failed. The model still reads the message.
        if (!result.ok) throw new Error(`Couldn't add ${name}: ${result.error}`);
        return [`Added ${name} ${result.version}.`, ...describeInstall(result.status)].join("\n");
      },
    }),
    add_addon: tool({
      description:
        "Adds an add-on to the app by its ID, with the add-ons it needs first: writes its files, installs its Packages, and adds its notes to AGENTS.md. It refuses an add-on the app already has, or one whose files would overwrite different ones, and then changes nothing. Returns its notes, the edits that join it to the app for you to make, the secrets it needs, and its tests to run.",
      inputSchema: z.object({
        addon: z.string().describe("The add-on's ID, such as storage."),
      }),
      execute: async ({ addon }) => {
        const result = await workspace.addAddonForAgent(addon);
        // Thrown, so the Conversation shows the call as failed. The model still reads the message.
        if (!result.ok) throw new Error(`Couldn't add the ${addon} add-on. ${result.error}`);
        const secretsNeeded = result.added.flatMap(({ secrets }) => secrets);
        const given = secretsNeeded.length > 0 ? new Set((await workspace.secretNames()).map(({ name }) => name)) : new Set<string>();
        return describeAddons(result, given);
      },
    }),
    request_preview: tool({
      description:
        "Sends the Preview, which runs the latest successful Build, an HTTP request and returns the response's status, headers and body. It doesn't follow redirects: a redirect comes back with its Location and any Set-Cookie headers. Build first to try new changes.",
      inputSchema: z.object({
        method: z.string().default("GET").describe("The HTTP method, such as GET or POST."),
        path: z.string().describe("The path and query, such as /api/items?page=2."),
        headers: z.record(z.string(), z.string()).optional().describe("Request headers, such as content-type."),
        body: z.string().optional().describe("The request body, for methods that have one."),
      }),
      execute: async ({ method, path, headers, body }) => {
        const response = await workspace.requestPreview({ method: method.toUpperCase(), path, headers, body });
        const headerLines = Object.entries(response.headers).map(([name, value]) => `${name}: ${value}`).join("\n");
        const cut = response.truncated ? "\n[The body was cut short.]" : "";
        return `${response.status}\n${headerLines}\n\n${response.body}${cut}`;
      },
    }),
    preview_logs: tool({
      description:
        "Reads the Preview's newest log lines, oldest first: its Worker's console output and uncaught exceptions, and front-end errors that browsers reported.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(500).optional().describe("How many of the newest lines to read. 100 if left out."),
      }),
      execute: async ({ limit }) => {
        const entries = await workspace.previewLogs(limit);
        if (entries.length === 0) return "The Preview has no logs yet.";
        return entries.map((entry) => `${entry.at} ${entry.source} ${entry.level}: ${entry.message}`).join("\n");
      },
    }),
    list_secrets: tool({
      description:
        "Lists the names of the Workspace's secrets.",
      inputSchema: z.object({}),
      execute: async () => {
        const secrets = await workspace.secretNames();
        if (secrets.length === 0) return "The Workspace has no secrets yet. The Developer adds them on the Workspace page.";
        return secrets.map(({ name }) => name).join(", ");
      },
    }),
  };
}

/** What `add_addon` added, for the Agent: its notes, and the edits, Secrets and tests that follow. `given` is the Secrets the Workspace already has. */
export function describeAddons({ added, had, written, tests, status }: Extract<AddonsAdded, { ok: true }>, given: Set<string>): string {
  const lines: string[] = [];
  // Needs come first, so the add-on asked for is the last.
  const needed = added.slice(0, -1).map(({ id }) => id);
  const after = needed.length > 0 ? `, after ${andList(needed)}, which it needs` : "";
  lines.push(`Added the ${added.at(-1)!.id} add-on${after}.${written.length > 0 ? ` Wrote ${andList(written.map((path) => `/${path}`))}.` : ""}`);
  if (had.length > 0) lines.push(`It needs ${andList(had.map(({ id }) => id))} too, which the app already had.`);
  const packages = added.flatMap(({ packages }) => Object.entries(packages).map(([name, version]) => `${name} ${version}`));
  if (packages.length > 0) lines.push(`Added the Packages ${andList(packages)}.`);
  if (status) lines.push(...describeInstall(status));
  lines.push("", "Its notes, now in /AGENTS.md:", "", "<notes>", ...added.map(({ notes }) => notes.trim()), "</notes>");
  const edits = added.flatMap(({ edits }) => edits);
  if (edits.length > 0) lines.push("", "To join it to the app, make these edits in the files as they stand:", ...edits.map((edit) => `- ${edit}`));
  if (tests.length > 0) lines.push("", `Then run its tests with the test tool: ${andList(tests.map((path) => `/${path}`))}.`);
  const secrets = added.flatMap(({ secrets }) => secrets).filter(({ name }) => !given.has(name));
  if (secrets.length > 0) {
    lines.push("", "It needs secrets the Developer hasn't given. Once the app works, ask for each with ask_for_secret, giving this reason:");
    lines.push(...secrets.map(({ name, reason }) => `- ${name}: ${reason}`));
  }
  return lines.join("\n");
}

/** An install's failure and warnings, a line each, for the Agent. */
function describeInstall({ state, error, warnings }: PackageStatus): string[] {
  return [...(state === "failed" ? [`The install failed: ${error}`] : []), ...warnings.map((warning) => `Package warning: ${warning}`)];
}

/** For example "/a.ts, /b.ts and /c.ts". */
const andList = (items: string[]) => new Intl.ListFormat("en-GB").format(items);

const summaryInstructions = `Summarise this Conversation between a Developer and the Agent about a Workspace's files, so the Agent can carry on from the summary alone. Keep what the Developer wants, what was decided, which files were made or changed and why, and anything left unfinished. Leave out pleasantries. Write at most 300 words.`;

/** Start fresh's summary of `messages`, written by the model. */
export async function summarise(
  messages: { role: string; parts: { type: string; text?: string }[] }[],
  model: LanguageModel,
): Promise<string> {
  return (await generateText({ model, ...summaryPrompt(messages) })).text;
}

/** The prompt for the summary, keeping the newest text if it's long. */
function summaryPrompt(
  messages: { role: string; parts: { type: string; text?: string }[] }[],
): { system: string; prompt: string } {
  const transcript = messages
    .map((message) => {
      const text = message.parts
        .map((part) => {
          if (part.type === "text") return part.text ?? "";
          if (part.type.startsWith("tool-")) return `[used ${part.type.slice("tool-".length)}]`;
          return "";
        })
        .filter(Boolean)
        .join("\n");
      return `${message.role === "user" ? "Developer or platform" : "Agent"}: ${text}`;
    })
    .join("\n\n");
  return { system: summaryInstructions, prompt: transcript.slice(-200_000) };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
