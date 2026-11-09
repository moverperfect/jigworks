import { afterEach, describe, expect, it, vi } from "vitest";
import { askClaude } from "./ai";

const env = { ANTHROPIC_API_KEY: "sk-ant-test-key" };
const request = { prompt: "Sort this into praise, complaint or question: The coffee was cold." };

/** Replaces `fetch` with one that answers `response`, as Anthropic would. */
const anthropicAnswers = (response: Response) => vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

/** A reply from the Messages API: a thinking block, as the model may start with, then `content`. */
const reply = (stop_reason: string, ...texts: string[]) =>
  Response.json({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content: [{ type: "thinking", thinking: "", signature: "sig" }, ...texts.map((text) => ({ type: "text", text }))],
    stop_reason,
    stop_details: null,
    usage: { input_tokens: 20, output_tokens: 5 },
  });

describe("asking Claude", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends the prompt to Anthropic with the key, and gives back the reply's text", async () => {
    const anthropic = anthropicAnswers(reply("end_turn", "complaint"));
    expect(await askClaude(env, { ...request, system: "Answer with one word." })).toEqual({ ok: true, text: "complaint" });

    expect(anthropic).toHaveBeenCalledOnce();
    const [url, init] = anthropic.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ Authorization: "Bearer sk-ant-test-key", "anthropic-version": "2026-10-21", "content-type": "application/json" });
    expect(JSON.parse(init?.body as string)).toEqual({
      model: "claude-haiku-5-5",
      max_tokens: 1024,
      output_config: { effort: "low" },
      system: "Answer with one word.",
      messages: [{ role: "user", content: request.prompt }],
    });
  });

  it("joins a reply in several parts, and takes another model and limit", async () => {
    const anthropic = anthropicAnswers(reply("end_turn", "Two people ", "signed up."));
    expect(await askClaude(env, { ...request, model: "claude-sonnet-5-5", maxTokens: 200 })).toEqual({ ok: true, text: "Two people signed up." });
    expect(JSON.parse(anthropic.mock.calls[0]![1]?.body as string)).toMatchObject({ model: "claude-sonnet-5-5", max_tokens: 200 });
  });

  it("reports a key Anthropic refuses, in Anthropic's words", async () => {
    anthropicAnswers(Response.json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, { status: 401 }));
    expect(await askClaude(env, request)).toEqual({
      ok: false,
      error: "Claude wasn't asked: Anthropic answered 401 (authentication_error): invalid x-api-key",
    });
  });

  it("reports a reply that was declined, cut off or otherwise stopped early", async () => {
    anthropicAnswers(reply("refusal"));
    expect(await askClaude(env, request)).toEqual({ ok: false, error: "Claude declined to answer this request." });

    anthropicAnswers(reply("max_tokens", "The coffee"));
    expect(await askClaude(env, request)).toEqual({
      ok: false,
      error: "Claude's reply was cut off at 1024 tokens: ask for a shorter answer, or raise maxTokens.",
    });

    anthropicAnswers(reply("model_context_window_exceeded", "The coffee"));
    expect(await askClaude(env, request)).toEqual({ ok: false, error: "Claude's reply stopped early (model_context_window_exceeded)." });
  });

  it("reports Anthropic failing without saying why, and out of reach, without throwing", async () => {
    anthropicAnswers(new Response("Bad gateway", { status: 502, statusText: "Bad Gateway" }));
    expect(await askClaude(env, request)).toEqual({ ok: false, error: "Claude wasn't asked: Anthropic answered 502 Bad Gateway" });

    anthropicAnswers(new Response("Not a reply"));
    expect(await askClaude(env, request)).toEqual({ ok: false, error: "Claude's reply had no text." });

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network connection lost."));
    expect(await askClaude(env, request)).toEqual({
      ok: false,
      error: "Claude wasn't asked: Anthropic couldn't be reached (Network connection lost.).",
    });
  });

  it("asks nothing before the key is set", async () => {
    const anthropic = anthropicAnswers(reply("end_turn", "never"));
    expect(await askClaude({}, request)).toEqual({ ok: false, error: "Claude wasn't asked: the Secret ANTHROPIC_API_KEY hasn't been set yet." });
    expect(anthropic).not.toHaveBeenCalled();
  });
});
