/** A request to the Messages API, as much of it as the scripts read. */
export interface MessagesRequest {
  model: string;
  stream?: boolean;
  system?: string | ContentBlock[];
  messages: { role: "user" | "assistant"; content: string | ContentBlock[] }[];
  tools?: { name: string }[];
  thinking?: unknown;
  output_config?: { effort?: string };
  fallbacks?: unknown;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_result"; content: string | { type: "text"; text: string }[] }
  | { type: string };

/** The scripted model's next reply: some text, then any tool calls, which end the step. */
export interface Reply {
  text?: string;
  toolCalls?: { name: string; input: Record<string, unknown> }[];
  /** How long to pause after the reply's first text, to hold a Turn open while it streams. */
  delayMs?: number;
}

/** The reply to a request with no tools, which is Start fresh asking for a summary. */
export const summaryReply = "Summary: the Developer and the Agent talked about the Workspace.";

/** Decides the next reply from everything the model has been sent so far. */
export type Script = (request: MessagesRequest) => Reply;

const encoder = new TextEncoder();

/**
 * The Anthropic Messages API, answering from `scripts`, for vitest's
 * `outboundService`. The Conversation's first user message names its script
 * as `[script:<name>]`. A script sees the whole request, so it can answer the
 * same way every time and report what the platform sent it. A request with no
 * tools gets `summaryReply`. Answers null for any other origin so the config
 * can try its next handler.
 */
export function fakeAnthropic(
  scripts: Record<string, Script>,
  { api = "https://api.anthropic.com", apiKey }: { api?: string; apiKey: string },
): (request: Request) => Promise<Response | null> {
  return async (request) => {
    const url = new URL(request.url);
    if (url.origin !== new URL(api).origin) return null;
    if (request.method !== "POST" || !url.pathname.endsWith("/v1/messages")) return error(404, "not_found_error", "Not found");
    if (request.headers.get("x-api-key") !== apiKey) return error(401, "authentication_error", "invalid x-api-key");

    const body = (await request.json()) as MessagesRequest;
    if (body.messages[0]?.role !== "user") return error(400, "invalid_request_error", "The first message must use the user role");
    let reply: Reply = { text: summaryReply };
    if (body.tools?.length) {
      const name = scriptName(body);
      const script = name === null ? undefined : scripts[name];
      if (!script) return error(400, "invalid_request_error", `No script named ${name}`);
      reply = script(body);
    }
    return body.stream ? stream(body, reply) : Response.json(message(body, reply));
  };
}

/** The script named in the Conversation's first user message. */
function scriptName(request: MessagesRequest): string | null {
  for (const message of request.messages) {
    if (message.role !== "user") continue;
    const match = /\[script:([\w-]+)\]/.exec(textOf(message.content));
    if (match) return match[1]!;
  }
  return null;
}

/** All the text in some content, tool results included. */
export function textOf(content: string | ContentBlock[] | undefined): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content
    .map((block) => {
      if ("text" in block && typeof block.text === "string") return block.text;
      if (block.type === "tool_result" && "content" in block) {
        return typeof block.content === "string" ? block.content : block.content.map((part) => part.text).join("");
      }
      return "";
    })
    .join("\n");
}

function blocks(reply: Reply) {
  return [
    ...(reply.text ? [{ type: "text" as const, text: reply.text }] : []),
    ...(reply.toolCalls ?? []).map((call, index) => ({
      type: "tool_use" as const,
      id: `toolu_${index}_${crypto.randomUUID().slice(0, 8)}`,
      name: call.name,
      input: call.input,
    })),
  ];
}

const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

function message(request: MessagesRequest, reply: Reply) {
  const content = blocks(reply);
  return {
    id: `msg_${crypto.randomUUID().slice(0, 12)}`,
    type: "message",
    role: "assistant",
    model: request.model,
    content,
    stop_reason: content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage,
  };
}

/** The reply as the Messages API streams it: one content block at a time. */
function stream(request: MessagesRequest, reply: Reply): Response {
  const { content, usage: totals, stop_reason, ...rest } = message(request, reply);
  const events: [string, unknown][] = [
    ["message_start", { type: "message_start", message: { ...rest, content: [], stop_reason: null, usage: totals } }],
  ];
  content.forEach((block, index) => {
    if (block.type === "text") {
      events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }]);
      events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } }]);
    } else {
      events.push([
        "content_block_start",
        { type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } },
      ]);
      events.push([
        "content_block_delta",
        { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } },
      ]);
    }
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
  });
  events.push([
    "message_delta",
    { type: "message_delta", delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: totals.output_tokens } },
  ]);
  events.push(["message_stop", { type: "message_stop" }]);
  const sse = (part: [string, unknown][]) =>
    encoder.encode(part.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""));
  // Up to the first delta, then any pause, then the rest.
  const split = events.findIndex(([event]) => event === "content_block_delta") + 1 || events.length;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(sse(events.slice(0, split)));
      if (reply.delayMs) await sleep(reply.delayMs);
      controller.enqueue(sse(events.slice(split)));
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function error(status: number, type: string, message: string): Response {
  return Response.json({ type: "error", error: { type, message } }, { status });
}
