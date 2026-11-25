// Resend's API for sending email, for vitest's `outboundService`, so an app
// with the email add-on can send from the Preview. Like Resend's test sender,
// it sends only to the account's own address.

/** The key the Developer gives as the Secret RESEND_API_KEY. */
export const resendKey = "re_fake_key";
/** The address the fake Resend account signed up with. */
export const resendAccountAddress = "owner@example.com";

const refusal = (status: number, name: string, message: string) => Response.json({ statusCode: status, name, message }, { status });

/** An email with this in its subject fails, as Resend failing for a moment would, the first time it's sent. */
export const failsOnce = "[fails once]";
const failed = new Set<string>();
/** Each email sent, in order, which `GET` on the endpoint lists for the tests. */
const sent: { to: unknown; subject: unknown }[] = [];

/** Answers a request to Resend's emails endpoint, or null for any other, so the config can try its next handler. */
export async function fakeResend(request: Request): Promise<Response | null> {
  if (request.url !== "https://api.resend.com/emails") return null;
  if (request.method === "GET") return Response.json({ data: sent });
  if (request.headers.get("Authorization") !== `Bearer ${resendKey}`) return refusal(401, "validation_error", "API key is invalid");
  const { from, to, subject } = (await request.json()) as { from?: unknown; to?: unknown; subject?: unknown };
  if (from === "onboarding@resend.dev" && to !== resendAccountAddress) {
    return refusal(
      403,
      "validation_error",
      `You can only send testing emails to your own email address (${resendAccountAddress}). To send emails to other recipients, please verify a domain at resend.com/domains, and change the \`from\` address to an email using this domain.`,
    );
  }
  if (typeof subject === "string" && subject.includes(failsOnce) && !failed.has(subject)) {
    failed.add(subject);
    return new Response("Service unavailable", { status: 503, statusText: "Service Unavailable" });
  }
  sent.push({ to, subject });
  return Response.json({ id: `email-to-${to}` });
}
