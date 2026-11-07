import { describe, expect, it } from "vitest";
import { changedWhen } from "../client/src/changed";

// When an app last changed, as the start page's list says it. The tests run
// in UTC, so midnight is at "T00:00".

const now = new Date("2026-11-07T15:00:00.000Z");
const ago = (iso: string) => changedWhen(iso, now);

describe("when an app last changed", () => {
  it("is just now within a minute, or when the clocks disagree", () => {
    expect(ago("2026-11-07T14:59:30.000Z")).toBe("changed just now");
    expect(ago("2026-11-07T15:00:05.000Z")).toBe("changed just now");
  });

  it("counts minutes, then hours, on the same day", () => {
    expect(ago("2026-11-07T14:59:00.000Z")).toBe("changed 1 minute ago");
    expect(ago("2026-11-07T14:01:00.000Z")).toBe("changed 59 minutes ago");
    expect(ago("2026-11-07T13:00:00.000Z")).toBe("changed 2 hours ago");
    expect(ago("2026-11-07T00:00:01.000Z")).toBe("changed 14 hours ago");
  });

  it("says yesterday for any time the day before, however few hours ago", () => {
    expect(ago("2026-11-06T23:59:00.000Z")).toBe("changed yesterday");
    expect(ago("2026-11-06T00:00:00.000Z")).toBe("changed yesterday");
  });

  it("counts days, then weeks, months and years", () => {
    expect(ago("2026-11-05T12:00:00.000Z")).toBe("changed 2 days ago");
    expect(ago("2026-10-31T12:00:00.000Z")).toBe("changed last week");
    expect(ago("2026-10-17T12:00:00.000Z")).toBe("changed 3 weeks ago");
    expect(ago("2026-10-01T12:00:00.000Z")).toBe("changed last month");
    expect(ago("2026-05-01T12:00:00.000Z")).toBe("changed 6 months ago");
    expect(ago("2025-11-12T12:00:00.000Z")).toBe("changed 11 months ago");
    expect(ago("2025-11-01T12:00:00.000Z")).toBe("changed last year");
    expect(ago("2023-11-01T12:00:00.000Z")).toBe("changed 3 years ago");
  });
});
