// When something happened to an app, as the page says it.

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
const words = new Intl.RelativeTimeFormat("en-GB", { numeric: "auto" });

/** Midnight before `date`, in the Developer's own time zone, so "yesterday" means the day before today. */
const midnight = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** Such as "changed just now", "changed 3 hours ago", "changed yesterday" or "changed last week". */
export const changedWhen = (changedAt: string, now = new Date()) => `changed ${howLongAgo(changedAt, now)}`;

/** Such as "just now", "3 hours ago", "yesterday" or "last week". */
export function howLongAgo(at: string, now = new Date()): string {
  const then = new Date(at);
  const elapsed = now.getTime() - then.getTime();
  if (elapsed < minute) return "just now";
  // Rounded, as a day with a clock change is an hour short or long.
  const days = Math.round((midnight(now) - midnight(then)) / day);
  const [count, unit]: [number, Intl.RelativeTimeFormatUnit] =
    elapsed < hour ? [Math.floor(elapsed / minute), "minute"]
    : days === 0 ? [Math.floor(elapsed / hour), "hour"]
    : days < 7 ? [days, "day"]
    : days < 30 ? [Math.floor(days / 7), "week"]
    : days < 365 ? [Math.min(Math.floor(days / 30), 11), "month"]
    : [Math.floor(days / 365), "year"];
  return words.format(-count, unit);
}
