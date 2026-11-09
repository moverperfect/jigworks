/**
 * Resend's test sender. Until the Developer verifies a domain with Resend, it
 * sends only to the address they signed up to Resend with. Once they have,
 * change it to an address at that domain, such as "Sunday Runs <runs@example.com>".
 */
export const sender = "onboarding@resend.dev";

export interface Email {
  /** One address, or a list of up to 50. */
  to: string | string[];
  subject: string;
  /** The email's words, as plain text. */
  text: string;
  /** The same as HTML, if it should look better than plain text. */
  html?: string;
  /** Where replies go, such as the address of the person who signed up. */
  replyTo?: string;
  /** Who it's from, if not `sender`. */
  from?: string;
}

/** Whether the email was sent: Resend's ID for it, or why it wasn't, in words to log. */
export type Sent = { ok: true; id: string } | { ok: false; error: string };

/**
 * Sends `email` through Resend, with the Secret `RESEND_API_KEY` from `env`.
 * Never throws: a failure comes back as `{ ok: false, error }`.
 */
export async function sendEmail(env: { RESEND_API_KEY?: string }, email: Email): Promise<Sent> {
  const key = env.RESEND_API_KEY;
  if (!key) return { ok: false, error: "The email wasn't sent: the Secret RESEND_API_KEY hasn't been set yet." };
  const { to, subject, text, html, replyTo, from = sender } = email;
  let response: Response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, subject, text, html, reply_to: replyTo }),
    });
  } catch (error) {
    return { ok: false, error: `The email wasn't sent: Resend couldn't be reached (${error instanceof Error ? error.message : String(error)}).` };
  }
  const body = (await response.json().catch(() => null)) as { id?: unknown; message?: unknown } | null;
  if (response.ok && typeof body?.id === "string") return { ok: true, id: body.id };
  if (typeof body?.message === "string") return { ok: false, error: `Resend refused the email: ${body.message}` };
  return { ok: false, error: `The email wasn't sent: Resend answered ${response.status} ${response.statusText}`.trim() };
}
