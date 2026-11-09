import { afterEach, describe, expect, it, vi } from "vitest";
import { sendEmail } from "./email";

const env = { RESEND_API_KEY: "re_test_key" };
const email = { to: "owner@example.com", subject: "Ada signed up", text: "Ada is coming on Sunday." };

/** Replaces `fetch` with one that answers `response`, as Resend would. */
const resendAnswers = (response: Response) => vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

describe("sending an email", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends it to Resend with the key, from the test sender, and gives back its ID", async () => {
    const resend = resendAnswers(Response.json({ id: "email-1" }));
    expect(await sendEmail(env, { ...email, html: "<p>Ada is coming on Sunday.</p>", replyTo: "ada@example.com" })).toEqual({
      ok: true,
      id: "email-1",
    });

    expect(resend).toHaveBeenCalledOnce();
    const [url, init] = resend.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ Authorization: "Bearer re_test_key", "Content-Type": "application/json" });
    expect(JSON.parse(init?.body as string)).toEqual({
      from: "onboarding@resend.dev",
      to: "owner@example.com",
      subject: "Ada signed up",
      text: "Ada is coming on Sunday.",
      html: "<p>Ada is coming on Sunday.</p>",
      reply_to: "ada@example.com",
    });
  });

  it("sends from another address, to several", async () => {
    const resend = resendAnswers(Response.json({ id: "email-2" }));
    await sendEmail(env, { ...email, to: ["a@example.com", "b@example.com"], from: "Sunday Runs <runs@example.com>" });
    expect(JSON.parse(resend.mock.calls[0]![1]?.body as string)).toMatchObject({
      from: "Sunday Runs <runs@example.com>",
      to: ["a@example.com", "b@example.com"],
    });
  });

  it("reports an email Resend refuses, in Resend's words", async () => {
    const refusal =
      "You can only send testing emails to your own email address (owner@example.com). To send emails to other recipients, please verify a domain at resend.com/domains, and change the `from` address to an email using this domain.";
    resendAnswers(Response.json({ statusCode: 403, name: "validation_error", message: refusal }, { status: 403 }));
    expect(await sendEmail(env, { ...email, to: "someone@example.com" })).toEqual({ ok: false, error: `Resend refused the email: ${refusal}` });
  });

  it("reports Resend failing without saying why, and Resend out of reach, without throwing", async () => {
    resendAnswers(new Response("Bad gateway", { status: 502, statusText: "Bad Gateway" }));
    expect(await sendEmail(env, email)).toEqual({ ok: false, error: "The email wasn't sent: Resend answered 502 Bad Gateway" });

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network connection lost."));
    expect(await sendEmail(env, email)).toEqual({
      ok: false,
      error: "The email wasn't sent: Resend couldn't be reached (Network connection lost.).",
    });
  });

  it("sends nothing before the key is set", async () => {
    const resend = resendAnswers(Response.json({ id: "never" }));
    expect(await sendEmail({}, email)).toEqual({ ok: false, error: "The email wasn't sent: the Secret RESEND_API_KEY hasn't been set yet." });
    expect(resend).not.toHaveBeenCalled();
  });
});
