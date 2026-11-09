/** Anthropic's smallest, cheapest current model, which suits sorting and summarising. */
export const defaultModel = "claude-haiku-5-5";

export interface Question {
  /** What to ask, with any text people sent in it. */
  prompt: string;
  /** Standing instructions, such as what the answer should look like. */
  system?: string;
  /** The most the reply may use, thinking included. Cost grows with it. */
  maxTokens?: number;
  /** Another Claude model, if not `defaultModel`: a current one, which takes the effort setting `askClaude` sends. */
  model?: string;
}

/** Claude's reply, or why there isn't one, in words to log. */
export type Answer = { ok: true; text: string } | { ok: false; error: string };

/**
 * Asks Claude `question` through Anthropic's Messages API, not streamed, with
 * the Secret `ANTHROPIC_API_KEY` from `env`, which is the Developer's, so they
 * pay for each request. Never throws: a failure comes back as `{ ok: false, error }`.
 */
export async function askClaude(env: { ANTHROPIC_API_KEY?: string }, question: Question): Promise<Answer> {
  const key = env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, error: "Claude wasn't asked: the Secret ANTHROPIC_API_KEY hasn't been set yet." };
  const { prompt, system, maxTokens = 1024, model = defaultModel } = question;
  let response: Response;
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      // The key goes to Anthropic and nowhere else.
      headers: { Authorization: `Bearer ${key}`, "anthropic-version": "2026-10-21", "content-type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        // Little thinking, which also counts towards max_tokens: enough for sorting and summarising, and cheaper.
        output_config: { effort: "low" },
        system,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch (error) {
    return { ok: false, error: `Claude wasn't asked: Anthropic couldn't be reached (${error instanceof Error ? error.message : String(error)}).` };
  }
  const body = (await response.json().catch(() => null)) as {
    content?: { type?: unknown; text?: unknown }[];
    stop_reason?: unknown;
    error?: { type?: unknown; message?: unknown };
  } | null;
  if (!response.ok) {
    const { type, message } = body?.error ?? {};
    const why = typeof message === "string" ? ` (${String(type)}): ${message}` : ` ${response.statusText}`;
    return { ok: false, error: `Claude wasn't asked: Anthropic answered ${response.status}${why}`.trim() };
  }
  // Only a reply that ended by itself is whole.
  const stop = body?.stop_reason;
  if (stop === "refusal") return { ok: false, error: "Claude declined to answer this request." };
  if (stop === "max_tokens") {
    return { ok: false, error: `Claude's reply was cut off at ${maxTokens} tokens: ask for a shorter answer, or raise maxTokens.` };
  }
  if (typeof stop === "string" && stop !== "end_turn") return { ok: false, error: `Claude's reply stopped early (${stop}).` };
  // The reply may start with thinking, so only its text blocks are the answer.
  const text = (body?.content ?? []).flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : [])).join("");
  if (!text) return { ok: false, error: "Claude's reply had no text." };
  return { ok: true, text };
}
