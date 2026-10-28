import { createAnthropic } from "@ai-sdk/anthropic";
import type { TurnConfig } from "@cloudflare/think";
import { generateText, tool, type LanguageModel, type ToolSet, type UIMessage } from "ai";
import { z } from "zod";
import type { BuildProblem, BuildReport } from "../shared/build-report";
import type { CheckReport, Problem } from "../shared/check-report";
import { maxRetries, type MessageMetadata } from "../shared/conversation";
import type { Workspace } from "../workspace";

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

/** The Agent's standing instructions. Each Turn adds the Workspace's AGENTS.md (see `withAgentsMd`). */
export const instructions = `You are the Agent on a development platform where a Developer and you build Cloudflare Workers together, entirely in the browser. You work in one Workspace. Its files are at the root of your file system, such as /package.json and /src/index.ts.

- Change files with the file tools or bash. Bash works on the Workspace's files only: there's no network, no npm and no Node.js.
- Add an npm Package with add_package, which picks a version that's at least a day old. Don't add one by editing package.json.
- The check tool type-checks the Workspace and returns its errors. The build tool builds it the way the platform runs it and returns any Build errors. Every Turn ends with a Check and then a Build. If either has errors you'll be asked to fix them, up to ${maxRetries} times in all.
- Each good Build becomes the Preview. Try it with request_preview, and read its server logs and front-end errors with preview_logs.
- The Developer can't change files while your Turn runs. If they changed files since your last Turn, their message says which. Read those files before you change them.
- Keep your replies short: say what you changed and anything the Developer needs to know.`;

/** The Turn's instructions: Think's, then the Workspace's AGENTS.md as it is now. */
export function withAgentsMd(system: string, agentsMd: string | null): string {
  return agentsMd === null
    ? `${system}\n\nThe Workspace has no AGENTS.md.`
    : `${system}\n\nThe Workspace's AGENTS.md says:\n\n<agents-md>\n${agentsMd}\n</agents-md>`;
}

/** The Developer's message, with a note of the files they changed since the last Turn. */
export function developerMessage(text: string, changedFiles: string[]): UIMessage<MessageMetadata> {
  const parts: UIMessage["parts"] = [{ type: "text", text }];
  if (changedFiles.length > 0) {
    const list = changedFiles.map((path) => `/${path}`).join(", ");
    parts.push({
      type: "text",
      text: `(From the platform: since your last Turn, the Developer changed ${list}. Read them before you change them.)`,
    });
  }
  return { id: crypto.randomUUID(), role: "user", parts, metadata: { from: "developer", changedFiles } };
}

/** The platform's message asking the Agent to fix the errors a Turn's Check and Build found. */
export function fixMessage(check: CheckReport, build: BuildReport, retry: number): UIMessage<MessageMetadata> {
  const errors = check.counts.error;
  const buildErrors = build.errors.length;
  const found: [summary: string, details: string][] = [];
  if (errors > 0) found.push([`the Check found ${plural(errors, "error")}`, describeCheck(check)]);
  if (buildErrors > 0) found.push([`the Build failed with ${plural(buildErrors, "error")}`, describeBuild(build)]);
  const summary = found.map(([text]) => text).join(" and ");
  const details = found.map(([, text]) => text).join("\n\n");
  const text = `After your Turn, ${summary}. Fix them. This is retry ${retry} of ${maxRetries}.\n\n${details}`;
  return { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }], metadata: { from: "check", errors, buildErrors, retry } };
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

/** The Agent's own tools. Think adds its file tools and bash. */
export function agentTools(workspace: {
  /** A Check, after the step's other tools have finished. */
  check: () => Promise<CheckReport>;
  /** A Build, after the step's other tools have finished. */
  build: () => Promise<BuildReport>;
  addPackageForAgent: Workspace["addPackageForAgent"];
  requestPreview: Workspace["requestPreview"];
  previewLogs: Workspace["previewLogs"];
}): ToolSet {
  return {
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
        "Builds the Workspace with esbuild the way the platform runs it, using wrangler.jsonc, and returns any Build errors and warnings. Type errors don't stop a Build. Installs Packages first if package.json changed. It sees the changes made by tools called in the same step.",
      inputSchema: z.object({}),
      execute: async () => {
        return describeBuild(await workspace.build());
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
        const warnings = result.status.warnings.map((warning) => `\nPackage warning: ${warning}`).join("");
        const failed = result.status.state === "failed" ? `\nThe install failed: ${result.status.error}` : "";
        return `Added ${name} ${result.version}.${failed}${warnings}`;
      },
    }),
    request_preview: tool({
      description:
        "Sends the Preview, which runs the latest good Build, an HTTP request and returns the response's status, headers and body. Build first to try new changes.",
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
  };
}

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
