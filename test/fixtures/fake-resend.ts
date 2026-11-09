// Resend's API for sending email, for vitest's `outboundService`, so an app
// with the email add-on can send from the Preview. Like Resend's test sender,
// it sends only to the account's own address.

/** The key the Developer gives as the Secret RESEND_API_KEY. */
export const resendKey = "re_fake_key";
/** The address the fake Resend account signed up with. */
export const resendAccountAddress = "owner@example.com";

const refusal = (status: number, name: string, message: string) => Response.json({ statusCode: status, name, message }, { status });

/** Answers a request to Resend's emails endpoint, or null for any other, so the config can try its next handler. */
export async function fakeResend(request: Request): Promise<Response | null> {
  if (request.url !== "https://api.resend.com/emails") return null;
  if (request.headers.get("Authorization") !== `Bearer ${resendKey}`) return refusal(401, "validation_error", "API key is invalid");
  const { from, to } = (await request.json()) as { from?: unknown; to?: unknown };
  if (from === "onboarding@resend.dev" && to !== resendAccountAddress) {
    return refusal(
      403,
      "validation_error",
      `You can only send testing emails to your own email address (${resendAccountAddress}). To send emails to other recipients, please verify a domain at resend.com/domains, and change the \`from\` address to an email using this domain.`,
    );
  }
  return Response.json({ id: `email-to-${to}` });
}
