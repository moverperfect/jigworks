import { DurableObject } from "cloudflare:workers";
import { sendEmail, type Sent } from "./email";
import { Records, type Stored } from "./store";

/** A reminder to add: who it goes to, what it's about and says, and when it's due. */
export interface Reminder {
  /** The address it's emailed to. */
  to: string;
  /**
   * The thing it's about, such as `"run-2026-12-06"`. One reminder per person
   * per thing: adding another with the same `to` and `about` replaces it.
   */
  about: string;
  subject: string;
  /** The email's words, as plain text. */
  text: string;
  /** When it's due: an instant, in milliseconds, as `Date.now()` gives. Make one with `instantAt`. */
  at: number;
}

/** A reminder as kept: whether it was sent, the tries that failed, and why it never will be, if so. */
export type KeptReminder = Stored<Reminder & { sent: boolean; tries: number; error: string | null }>;

const collection = "reminders";
/** How many times the platform retries a failing `alarm()` before it drops it, and so how many more tries a reminder gets. */
const retries = 6;
/** The most reminders one ring sends, well within the 50 requests an app's call may make. */
export const sentPerRing = 40;

/**
 * The reminders, kept in `records`, and sending those due. `Reminders` keeps
 * them in its own storage; tests keep them in memory (see fake-reminders.ts).
 */
export class ReminderList {
  constructor(private readonly records: Records) {}

  /** Every reminder, oldest first. */
  list(): KeptReminder[] {
    return this.records.list(collection) as unknown as KeptReminder[];
  }

  /**
   * Keeps a reminder, replacing any with the same `to` and `about`. One
   * already sent isn't sent again unless its time changes; one that failed
   * is tried afresh.
   */
  add({ to, about, subject, text, at }: Reminder): KeptReminder {
    if (typeof to !== "string" || !to.trim()) throw new Error("A reminder needs the address it goes to, as to.");
    if (typeof about !== "string") throw new Error("A reminder needs what it's about, as about, such as the run's ID.");
    if (typeof at !== "number" || !Number.isFinite(at)) throw new Error(`A reminder's time, at, must be an instant in milliseconds, such as instantAt gives, not ${String(at)}.`);
    to = to.trim();
    const afresh = { sent: false, tries: 0, error: null };
    const same = this.find(to, about);
    if (!same) return this.records.add(collection, { to, about, subject, text, at, ...afresh }) as unknown as KeptReminder;
    const again = same.at !== at || same.error !== null;
    return this.records.update(collection, same.id, { subject, text, at, ...(again && afresh) }) as unknown as KeptReminder;
  }

  /** Removes the reminder for `to` about `about`. Returns whether there was one. */
  remove(to: string, about: string): boolean {
    const same = this.find(to, about);
    return same ? this.records.remove(collection, same.id) : false;
  }

  /** The reminders still to send that are due by `now`: those tried least first, so each gets its turn when more are due than a ring sends. */
  private due(now: number): KeptReminder[] {
    return this.waiting()
      .filter(({ at }) => at <= now)
      .sort((a, b) => a.tries - b.tries);
  }

  /** When the earliest reminder still to send is due, or null if there's none. */
  next(): number | null {
    const times = this.waiting().map(({ at }) => at);
    return times.length > 0 ? Math.min(...times) : null;
  }

  /**
   * Sends the reminders due by `now` with `send`, up to `sentPerRing`, marking
   * each sent as soon as it's sent, so a retry sends only those not sent.
   * Returns why `alarm()` should throw, so the platform retries it, when some
   * couldn't be sent but may be on a later try, such as when Resend couldn't
   * be reached; or null. One that has had all its tries, or that Resend
   * refused, which it would again, keeps its error and isn't tried again.
   * `retryCount` is the `alarm()`'s: on its last try it doesn't throw, as the
   * platform would drop the alarm, and the next alarm takes those left.
   */
  async sendDue(now: number, send: (reminder: KeptReminder) => Promise<Sent>, retryCount = 0): Promise<string | null> {
    const failed: string[] = [];
    for (const queued of this.due(now).slice(0, sentPerRing)) {
      // As it is now: one removed, moved on or sent while an earlier one was sending is skipped.
      const reminder = this.records.get(collection, queued.id) as unknown as KeptReminder | null;
      if (!reminder || reminder.sent || reminder.error !== null || reminder.at > now) continue;
      const sent = await send(reminder);
      if (sent.ok) {
        this.mark(reminder, { sent: true });
        continue;
      }
      console.error(`Reminder ${reminder.id} wasn't sent. ${sent.error}`);
      const tries = reminder.tries + 1;
      // sendEmail's errors that start so may pass, such as Resend being out of reach.
      const mayPass = sent.error.startsWith("The email wasn't sent") && tries <= retries;
      // Not retried for one moved or removed meanwhile, which waits afresh.
      if (this.mark(reminder, mayPass ? { tries } : { tries, error: sent.error }) && mayPass) failed.push(sent.error);
    }
    if (failed.length === 0 || retryCount >= retries) return null;
    const which = failed.length === 1 ? "1 reminder wasn't sent, so it'll" : `${failed.length} reminders weren't sent, so they'll`;
    return `${which} be tried again. ${failed[0]}`;
  }

  private waiting(): KeptReminder[] {
    return this.list().filter(({ sent, error }) => !sent && error === null);
  }

  private find(to: string, about: string): KeptReminder | undefined {
    return this.list().find((reminder) => reminder.to.toLowerCase() === to.trim().toLowerCase() && reminder.about === about);
  }

  /** Changes a reminder that was sending, unless it was moved or removed meanwhile, so a moved one is still sent. Returns whether it did. */
  private mark(reminder: KeptReminder, changes: Partial<KeptReminder>): boolean {
    if (this.records.get(collection, reminder.id)?.at !== reminder.at) return false;
    this.records.update(collection, reminder.id, changes);
    return true;
  }
}

/**
 * The app's reminders: one Durable Object instance, which keeps them and sets
 * its alarm for the next one due. Reach it with `reminders`.
 */
export class Reminders extends DurableObject<Env> {
  private readonly kept = new ReminderList(new Records(this.ctx.storage.kv));
  /** Whether alarm() is running, which sets the next alarm itself once it's done, or throws for the platform to retry it. */
  private ringing = false;

  async add(reminder: Reminder): Promise<KeptReminder> {
    const before = this.kept.next();
    const added = this.kept.add(reminder);
    await this.moveAlarm(before);
    return added;
  }

  async remove(to: string, about: string): Promise<boolean> {
    const before = this.kept.next();
    const removed = this.kept.remove(to, about);
    await this.moveAlarm(before);
    return removed;
  }

  list(): KeptReminder[] {
    return this.kept.list();
  }

  override async alarm(info?: AlarmInvocationInfo): Promise<void> {
    this.ringing = true;
    let failed: string | null;
    try {
      failed = await this.kept.sendDue(Date.now(), (reminder) => sendEmail(this.env, reminder), info?.retryCount);
    } finally {
      this.ringing = false;
    }
    // Thrown before the next alarm is set, so the platform retries alarm(), with its backoff.
    if (failed) throw new Error(failed);
    // getAlarm() reads null during alarm(), so this sets the next one due.
    const next = this.kept.next();
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }

  /** After a change made when `before` was the earliest reminder still to send, moves the alarm as `alarmAfterChange` says. */
  private async moveAlarm(before: number | null): Promise<void> {
    const set = await this.ctx.storage.getAlarm();
    if (this.ringing) return;
    const move = alarmAfterChange(before, this.kept.next(), set, Date.now());
    if (move === null) await this.ctx.storage.deleteAlarm();
    else if (move !== undefined) await this.ctx.storage.setAlarm(move);
  }
}

/**
 * What a change to the reminders does to the alarm, when `before` was the
 * earliest still to send, `next` is now, and the alarm is `set`: the time to
 * set it for, null to delete it, or undefined to leave it. The alarm is left
 * when it already serves: for an earlier reminder, or held back for those
 * already due, as for a retry, which setting it again would start afresh.
 */
export function alarmAfterChange(before: number | null, next: number | null, set: number | null, now: number): number | null | undefined {
  if (next === null) return set === null ? undefined : null;
  // One whose time has passed won't ring, such as one the platform dropped.
  if (set === null || set < now) return next;
  const heldForDue = before !== null && before <= now && next <= now;
  // What the alarm was set for: the earliest before, or later if that's no longer waiting.
  const setFor = before !== null && before > now ? before : set;
  return !heldForDue && next < setFor ? next : undefined;
}

/** The reminders' one instance. Renaming it starts the reminders afresh. */
const instance = "app";

/** The app's reminders: `reminders(c.env.REMINDERS).add({ to, about, subject, text, at })`. */
export function reminders(namespace: DurableObjectNamespace<Reminders>) {
  const stub = namespace.getByName(instance);
  return {
    /** Keeps a reminder and sets the alarm for it, replacing any with the same `to` and `about`. Returns it as kept. */
    add: async (reminder: Reminder) => (await stub.add(reminder)) as KeptReminder,
    /** Removes the reminder for `to` about `about`. Returns whether there was one. */
    remove: async (to: string, about: string) => (await stub.remove(to, about)) as boolean,
    /** Every reminder, oldest first, with whether it was sent. */
    list: async () => (await stub.list()) as KeptReminder[],
  };
}

/**
 * The instant, in milliseconds, of a date and time on the clock in a named
 * time zone, following its summer time: `instantAt("2026-12-05", "09:00", "Europe/London")`.
 * A time the clocks skip, when they go forward, is taken as that long after,
 * such as 1:30 as 2:30; a time they pass twice, when they go back, as the first.
 */
export function instantAt(date: string, time: string, timeZone: string): number {
  const fields = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(`${date} ${time}`);
  if (!fields) throw new Error(`instantAt takes a date such as "2026-12-05" and a time such as "09:00", not "${date}" and "${time}".`);
  const [year, month, day, hour, minute] = fields.slice(1).map(Number) as [number, number, number, number, number];
  // The date and time as if the zone were UTC.
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  if (new Date(wall).toISOString().slice(0, 16) !== `${date}T${time}`) throw new Error(`There's no ${date} ${time}.`);
  if (typeof timeZone !== "string" || !timeZone.trim()) throw new Error('instantAt needs a time zone, such as "Europe/London", from the TIME_ZONE var.');
  let clockThere: Intl.DateTimeFormat;
  try {
    clockThere = new Intl.DateTimeFormat("en-GB", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
  } catch {
    throw new Error(`There's no time zone called "${timeZone}". Give one such as "Europe/London".`);
  }
  /** How far the zone's clock is ahead of UTC at `instant`. */
  const offset = (instant: number) => {
    const part = Object.fromEntries(clockThere.formatToParts(instant).map(({ type, value }) => [type, Number(value)]));
    return Date.UTC(part.year!, part.month! - 1, part.day!, part.hour!, part.minute!, part.second!) - instant;
  };
  // The zone's offset the day before and the day after: the same, unless the clocks change between.
  const before = wall - offset(wall - 86_400_000);
  const after = wall - offset(wall + 86_400_000);
  const shows = (instant: number) => instant + offset(instant) === wall;
  // The first that shows the time, or, for a time the clocks skip, the old offset, which lands that long after.
  return shows(before) || !shows(after) ? before : after;
}
