import { textOf, type MessagesRequest, type Script } from "./fake-anthropic.ts";

// What the scripted model does, by the name a test's first message gives as
// `[script:<name>]`. Each script answers from the request alone.

export const brokenCount = 'export const count: number = "many";\n';
export const fixedCount = "export const count: number = 3;\n";
const checkFound = "After your Turn, the Check found";
const buildFailed = "the Build failed";
// Type-checks, but the Build fails: the bundle still requires a package that isn't installed.
export const unbuildableIndex =
  'declare function require(name: string): unknown;\nrequire("left-pad");\nexport default { fetch: () => new Response("hi") };\n';
export const buildableIndex = 'export default { fetch: () => new Response("hi") };\n';

export const agentScripts: Record<string, Script> = {
  // Answers once, with no tools.
  "say-hello": () => ({ text: "Hello from the scripted model." }),

  // Reports what the platform sent, as JSON, for the test to read.
  "report-request": (request) => ({
    text: JSON.stringify({
      model: request.model,
      system: textOf(request.system),
      latest: latestInstruction(request),
      tools: (request.tools ?? []).map((tool) => tool.name).sort(),
      cacheControl: "cache_control" in request,
      effort: request.output_config?.effort,
      fallbacks: request.fallbacks,
      thinking: request.thinking,
    }),
  }),

  // Writes a file with a type error, then fixes it when the Check asks.
  "break-then-fix": (request) => {
    const fixing = latestInstruction(request).includes(checkFound);
    if (afterToolResult(request)) return { text: fixing ? "Fixed it." : "Wrote src/count.ts." };
    return { toolCalls: [{ name: "write", input: { path: "/src/count.ts", content: fixing ? fixedCount : brokenCount } }] };
  },

  // Writes an entry point that type-checks but doesn't build, then fixes it when asked.
  "break-build-then-fix": (request) => {
    const fixing = latestInstruction(request).includes(buildFailed);
    if (afterToolResult(request)) return { text: fixing ? "Fixed the Build." : "Rewrote src/index.ts." };
    return { toolCalls: [{ name: "write", input: { path: "/src/index.ts", content: fixing ? buildableIndex : unbuildableIndex } }] };
  },

  // Writes a file with a type error, and never fixes it.
  "never-fixes": (request) =>
    afterToolResult(request)
      ? { text: "I can't fix it." }
      : { toolCalls: [{ name: "write", input: { path: "/src/count.ts", content: brokenCount } }] },

  // Pauses mid-reply, so a test can act while the Turn streams.
  slow: () => ({ text: "Done, slowly.", delayMs: 2_000 }),

  // Use one tool, then repeat what it said.
  "add-package": echoTool("add_package", { name: "@fake/a" }),
  "add-missing-package": echoTool("add_package", { name: "@fake/missing" }),
  "use-check": echoTool("check", {}),
  "use-build": echoTool("build", {}),
  "request-preview": echoTool("request_preview", { method: "get", path: "/api/hello/Agent" }),
  "read-preview-logs": echoTool("preview_logs", {}),

  // Writes a file with a type error and runs check in the same step, as the model often does.
  "write-and-check": (request) =>
    afterToolResult(request)
      ? { text: `The tools said: ${lastToolResult(request)}` }
      : {
          toolCalls: [
            { name: "write", input: { path: "/src/count.ts", content: brokenCount } },
            { name: "check", input: {} },
          ],
        },

  // Breaks the entry point with bash and runs build in the same step. Bash
  // writes its changes back only when its script ends.
  "bash-and-build": (request) =>
    afterToolResult(request)
      ? { text: `The tools said: ${lastToolResult(request)}` }
      : {
          toolCalls: [
            { name: "bash", input: { script: "sleep 0.2; echo 'export default { fetch: ( };' > /src/index.ts" } },
            { name: "build", input: {} },
          ],
        },

  // Lists files forever, to reach the step limit.
  "keep-going": () => ({ toolCalls: [{ name: "list", input: { path: "/" } }] }),

  // Writes a file with a type error, then lists files forever.
  "break-and-keep-going": (request) =>
    afterToolResult(request)
      ? { toolCalls: [{ name: "list", input: { path: "/" } }] }
      : { toolCalls: [{ name: "write", input: { path: "/src/count.ts", content: brokenCount } }] },
};

/** Calls one tool, then says what it returned. */
function echoTool(name: string, input: Record<string, unknown>): Script {
  return (request) =>
    afterToolResult(request) ? { text: `The tool said: ${lastToolResult(request)}` } : { toolCalls: [{ name, input }] };
}

/** The newest user message that isn't only tool results: the Developer's, or the platform's after a Check. */
function latestInstruction(request: MessagesRequest): string {
  for (const message of [...request.messages].reverse()) {
    if (message.role !== "user") continue;
    const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
    const text = content.filter((block) => block.type === "text");
    if (text.length > 0) return textOf(text);
  }
  return "";
}

/** Whether the model's last step called tools, whose results are now in. */
function afterToolResult(request: MessagesRequest): boolean {
  const last = request.messages.at(-1);
  return last?.role === "user" && typeof last.content !== "string" && last.content.some((block) => block.type === "tool_result");
}

function lastToolResult(request: MessagesRequest): string {
  const last = request.messages.at(-1);
  if (!last || typeof last.content === "string") return "";
  return textOf(last.content.filter((block) => block.type === "tool_result"));
}
