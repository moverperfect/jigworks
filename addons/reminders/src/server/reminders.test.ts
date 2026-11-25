import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { sendEmail } from "./email";
import { fakeReminders } from "./fake-reminders";
import { alarmAfterChange, instantAt, reminders, sentPerRing, type ReminderList } from "./reminders";

const env = { RESEND_API_KEY: "re_test_key" };
/** Resend's answer to an email it sent, new for each, as a body can be read only once. */
const accepted = async () => Response.json({ id: "email-1" });
const unreachable = "The email wasn't sent: Resend couldn't be reached (Network connection lost.).";
const minute = 60_000;
const day = 86_400_000;
const now = Date.UTC(2026, 11, 5, 9, 0);
const reminder = (to: string, at: number, about = "run-2026-12-06") => ({ to, about, subject: "Sunday's run", text: "See you at 9.", at });

/** Reminders kept in memory, as the Durable Object keeps them, without its alarm. */
const kept = () => fakeReminders().getByName("app") as unknown as ReminderList;
/** Sends each due reminder as the Durable Object's alarm() does, through Resend, on the alarm's try `retryCount`. */
const sendDue = (list: ReminderList, retryCount = 0) => list.sendDue(now, (due) => sendEmail(env, due), retryCount);
/** The address of each email sent to Resend. */
const sentTo = (resend: MockInstance<typeof fetch>) => resend.mock.calls.map(([, init]) => JSON.parse(init?.body as string).to);

describe("reminders", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps one reminder per person per thing, and removes it", async () => {
    const list = reminders(fakeReminders());
    const ada = await list.add(reminder(" ada@example.com", now));
    expect(ada).toEqual({ id: expect.any(String), ...reminder("ada@example.com", now), sent: false, tries: 0, error: null });
    // Signing up twice replaces the reminder, rather than adding a second.
    const again = await list.add({ ...reminder("Ada@example.com ", now + day), subject: "Moved" });
    expect(await list.list()).toEqual([{ ...ada, subject: "Moved", at: now + day }]);
    expect(again.id).toBe(ada.id);
    // Another thing is another reminder.
    await list.add(reminder("ada@example.com", now, "run-2026-12-13"));
    expect(await list.remove("ada@example.com", "run-2026-12-06")).toBe(true);
    expect(await list.remove("ada@example.com", "run-2026-12-06")).toBe(false);
    expect((await list.list()).map(({ about }) => about)).toEqual(["run-2026-12-13"]);
  });

  it("refuses a reminder without an address or a time", async () => {
    const list = reminders(fakeReminders());
    await expect(list.add(reminder(" ", now))).rejects.toThrow("A reminder needs the address it goes to");
    await expect(list.add(reminder("ada@example.com", Number.NaN))).rejects.toThrow("must be an instant in milliseconds");
  });

  it("sends each due reminder once, marks it sent, and gives the next one's time", async () => {
    const resend = vi.spyOn(globalThis, "fetch").mockImplementation(accepted);
    const list = kept();
    list.add(reminder("ada@example.com", now - minute));
    list.add(reminder("grace@example.com", now));
    list.add(reminder("alan@example.com", now + day));
    expect(list.next()).toBe(now - minute);

    expect(await sendDue(list)).toBeNull();
    expect(sentTo(resend)).toEqual(["ada@example.com", "grace@example.com"]);
    expect(list.list().map(({ to, sent }) => [to, sent])).toEqual([
      ["ada@example.com", true],
      ["grace@example.com", true],
      ["alan@example.com", false],
    ]);
    expect(list.next()).toBe(now + day);
    // Ringing again sends none twice.
    await sendDue(list);
    expect(resend).toHaveBeenCalledTimes(2);
  });

  it("on a retry, sends only the reminders that weren't sent before", async () => {
    const resend = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(accepted)
      .mockRejectedValueOnce(new Error("Network connection lost."))
      .mockImplementation(accepted);
    const list = kept();
    for (const to of ["ada@example.com", "grace@example.com", "alan@example.com"]) list.add(reminder(to, now));

    // Grace's couldn't be sent, so alarm() throws and is retried.
    expect(await sendDue(list)).toBe(`1 reminder wasn't sent, so it'll be tried again. ${unreachable}`);
    expect(list.list().map(({ sent }) => sent)).toEqual([true, false, true]);
    expect(list.next()).toBe(now);

    expect(await sendDue(list, 1)).toBeNull();
    expect(sentTo(resend)).toEqual(["ada@example.com", "grace@example.com", "alan@example.com", "grace@example.com"]);
    expect(list.list().map(({ sent }) => sent)).toEqual([true, true, true]);
    expect(list.next()).toBeNull();
  });

  it("doesn't try again a reminder Resend refused, and keeps why", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({ statusCode: 403, name: "validation_error", message: "You can only send testing emails to your own email address" }, { status: 403 }),
    );
    const list = kept();
    list.add(reminder("ada@example.com", now));
    expect(await sendDue(list)).toBeNull();
    expect(list.list()[0]).toMatchObject({ sent: false, error: "Resend refused the email: You can only send testing emails to your own email address" });
    expect(list.next()).toBeNull();
  });

  it("gives each reminder as many tries as the alarm gets, however many rings they take, then keeps why", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network connection lost."));
    const list = kept();
    list.add(reminder("ada@example.com", now));
    for (let retryCount = 0; retryCount < 6; retryCount++) expect(await sendDue(list, retryCount)).toContain("tried again");
    // The alarm's last try: Grace's came due only now, so she keeps her tries, and the next alarm takes them.
    list.add(reminder("grace@example.com", now));
    expect(await sendDue(list, 6)).toBeNull();
    expect(list.list().map(({ tries, error }) => [tries, error])).toEqual([
      [7, unreachable],
      [1, null],
    ]);
    expect(list.next()).toBe(now);
  });

  it("sends at most a ring's worth, leaving the rest to the next alarm", async () => {
    const resend = vi.spyOn(globalThis, "fetch").mockImplementation(accepted);
    const list = kept();
    for (let runner = 0; runner < sentPerRing + 5; runner++) list.add(reminder(`runner-${runner}@example.com`, now));
    expect(await sendDue(list)).toBeNull();
    expect(resend).toHaveBeenCalledTimes(sentPerRing);
    expect(list.list().filter(({ sent }) => !sent)).toHaveLength(5);
    expect(list.next()).toBe(now);
  });

  it("with more due than a ring sends while Resend is out of reach, retries with the alarm's backoff, the untried first", async () => {
    const resend = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network connection lost."));
    const list = kept();
    for (let runner = 0; runner < sentPerRing + 5; runner++) list.add(reminder(`runner-${runner}@example.com`, now));
    expect(await sendDue(list)).toBe(`${sentPerRing} reminders weren't sent, so they'll be tried again. ${unreachable}`);
    resend.mockClear();
    await sendDue(list, 1);
    expect(sentTo(resend).slice(0, 5)).toEqual([40, 41, 42, 43, 44].map((runner) => `runner-${runner}@example.com`));
  });

  it("doesn't send a reminder again when it's added again unchanged, but does once it's moved, or tries again one that failed", async () => {
    const resend = vi.spyOn(globalThis, "fetch").mockImplementation(accepted);
    const list = kept();
    list.add(reminder("ada@example.com", now));
    await sendDue(list);
    list.add(reminder("ada@example.com", now));
    expect(list.next()).toBeNull();
    list.add(reminder("ada@example.com", now - minute));
    await sendDue(list);
    expect(resend).toHaveBeenCalledTimes(2);

    // Refused while the app sent from Resend's test sender: added again, once the Developer has a domain, it's tried afresh.
    list.add(reminder("grace@example.com", now));
    await list.sendDue(now, async () => ({ ok: false, error: "Resend refused the email: You can only send testing emails to your own email address" }));
    expect(list.list()[1]).toMatchObject({ error: expect.stringContaining("Resend refused the email") });
    list.add(reminder("grace@example.com", now));
    expect(list.list()[1]).toMatchObject({ sent: false, tries: 0, error: null });
    expect(list.next()).toBe(now);
  });

  it("keeps sending the reminder that took a sending one's place", async () => {
    const list = kept();
    list.add(reminder("ada@example.com", now));
    // Moved to tomorrow while today's was being sent.
    await list.sendDue(now, async () => (list.add(reminder("ada@example.com", now + day)), { ok: true, id: "email-1" }));
    expect(list.list()[0]).toMatchObject({ at: now + day, sent: false });
    expect(list.next()).toBe(now + day);
  });

  it("doesn't send a reminder removed or moved on while an earlier one in the same ring was sending", async () => {
    const list = kept();
    for (const to of ["ada@example.com", "grace@example.com", "alan@example.com"]) list.add(reminder(to, now));
    const sentTo: string[] = [];
    await list.sendDue(now, async (due) => {
      sentTo.push(due.to);
      if (due.to === "ada@example.com") {
        list.remove("grace@example.com", "run-2026-12-06");
        list.add(reminder("alan@example.com", now + day));
      }
      return { ok: true, id: "email-1" };
    });
    expect(sentTo).toEqual(["ada@example.com"]);
    expect(list.list().map(({ to, sent }) => [to, sent])).toEqual([
      ["ada@example.com", true],
      ["alan@example.com", false],
    ]);
    expect(list.next()).toBe(now + day);
  });

  it("doesn't retry a reminder that failed after it was moved or removed while sending", async () => {
    const list = kept();
    list.add(reminder("ada@example.com", now));
    const failing = { ok: false as const, error: unreachable };
    await expect(list.sendDue(now, async () => (list.add(reminder("ada@example.com", now + 2 * minute)), failing), 5)).resolves.toBeNull();
    expect(list.list()[0]).toMatchObject({ at: now + 2 * minute, tries: 0, error: null });
    await expect(list.sendDue(now + 2 * minute, async () => (list.remove("ada@example.com", "run-2026-12-06"), failing), 5)).resolves.toBeNull();
    expect(list.list()).toEqual([]);
  });
});

describe("the alarm after a reminder is added or removed", () => {
  it("is set for the earliest, and deleted when none is left", () => {
    expect(alarmAfterChange(null, now + day, null, now)).toBe(now + day);
    expect(alarmAfterChange(now + day, now + minute, now + day, now)).toBe(now + minute);
    expect(alarmAfterChange(now + day, null, now + day, now)).toBeNull();
    expect(alarmAfterChange(null, null, null, now)).toBeUndefined();
  });

  it("is set again when its time has passed without ringing, such as when the platform dropped it", () => {
    expect(alarmAfterChange(now - day, now - day, now - day, now)).toBe(now - day);
  });

  it("is moved on from a retry once nothing is due", () => {
    // Ada's failed and waits for a retry half an hour on; she's moved to tomorrow, and Grace is due in two minutes.
    expect(alarmAfterChange(now - minute, now + 2 * minute, now + 30 * minute, now)).toBe(now + 2 * minute);
    // A reminder due now is added while the alarm waits for tomorrow's.
    expect(alarmAfterChange(now + day, now - minute, now + day, now)).toBe(now - minute);
  });

  it("is left when it already serves: for an earlier one, or held back for those already due, as for a retry", () => {
    expect(alarmAfterChange(now + minute, now + minute, now + minute, now)).toBeUndefined();
    expect(alarmAfterChange(now + minute, now + day, now + minute, now)).toBeUndefined();
    // Held back to the minimum interval for one due in ten seconds: another added doesn't hold it back again.
    expect(alarmAfterChange(now + 10_000, now + 10_000, now + minute, now)).toBeUndefined();
    // A retry four minutes on, for one due a minute ago: adding another, even one due now, doesn't start the retries afresh.
    expect(alarmAfterChange(now - minute, now - minute, now + 4 * minute, now)).toBeUndefined();
    expect(alarmAfterChange(now - minute, now - 2 * minute, now + 4 * minute, now)).toBeUndefined();
  });
});

describe("instantAt", () => {
  it("turns a date and time on the clock into an instant, in winter and in summer", () => {
    expect(instantAt("2026-12-05", "09:00", "Europe/London")).toBe(Date.UTC(2026, 11, 5, 9, 0));
    expect(instantAt("2026-06-05", "09:00", "Europe/London")).toBe(Date.UTC(2026, 5, 5, 8, 0));
    expect(instantAt("2026-12-05", "09:00", "America/New_York")).toBe(Date.UTC(2026, 11, 5, 14, 0));
    expect(instantAt("2026-06-05", "18:30", "Australia/Sydney")).toBe(Date.UTC(2026, 5, 5, 8, 30));
    expect(instantAt("2028-02-29", "09:00", "Asia/Kolkata")).toBe(Date.UTC(2028, 1, 29, 3, 30));
    expect(instantAt("2026-12-31", "23:59", "UTC")).toBe(Date.UTC(2026, 11, 31, 23, 59));
  });

  it("takes the days the clocks change, east and west of UTC", () => {
    // Before and after the clocks go forward, at 1am in London, on 29 March 2026.
    expect(instantAt("2026-03-29", "00:30", "Europe/London")).toBe(Date.UTC(2026, 2, 29, 0, 30));
    expect(instantAt("2026-03-29", "09:00", "Europe/London")).toBe(Date.UTC(2026, 2, 29, 8, 0));
    // A time the clocks skip is taken as that long after: 1:30 as 2:30, and New York's 2:30 as 3:30.
    expect(instantAt("2026-03-29", "01:30", "Europe/London")).toBe(Date.UTC(2026, 2, 29, 1, 30));
    expect(instantAt("2026-03-08", "02:30", "America/New_York")).toBe(Date.UTC(2026, 2, 8, 7, 30));
    // They go back on 25 October 2026, passing 1:30 twice: it's taken as the first.
    expect(instantAt("2026-10-25", "01:30", "Europe/London")).toBe(Date.UTC(2026, 9, 25, 0, 30));
    expect(instantAt("2026-11-01", "01:30", "America/New_York")).toBe(Date.UTC(2026, 10, 1, 5, 30));
    expect(instantAt("2026-10-25", "09:00", "Europe/London")).toBe(Date.UTC(2026, 9, 25, 9, 0));
  });

  it("refuses a date, time or time zone it can't read", () => {
    expect(() => instantAt("5/12/2026", "09:00", "Europe/London")).toThrow('instantAt takes a date such as "2026-12-05"');
    expect(() => instantAt("2026-12-05", "9am", "Europe/London")).toThrow('a time such as "09:00"');
    for (const [date, time] of [
      ["2026-02-29", "09:00"],
      ["2026-13-05", "09:00"],
      ["2026-00-05", "09:00"],
      ["0099-06-01", "09:00"],
      ["2026-12-05", "24:00"],
      ["2026-12-05", "09:60"],
    ] as const) {
      expect(() => instantAt(date, time, "Europe/London")).toThrow(`There's no ${date} ${time}.`);
    }
    expect(() => instantAt("2026-12-05", "09:00", "London")).toThrow('There\'s no time zone called "London". Give one such as "Europe/London".');
    // A TIME_ZONE var that was never added.
    expect(() => instantAt("2026-12-05", "09:00", undefined as unknown as string)).toThrow("instantAt needs a time zone");
  });
});
