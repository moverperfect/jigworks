import { describe, expect, it } from "vitest";
import { instructions } from "../src/agent";
import { alarmRetries } from "../src/apphost/app-data";
import { parseJsonc } from "../src/shared/jsonc";
import { addonWithNeeds, getTemplate, listTemplates } from "../src/templates";
import { hasAddon, pack, type AddonManifest, type AddonSource, type TemplateSource } from "../src/templates/pack";
import wranglerConfig from "../wrangler.jsonc?raw";

// Packing the Templates and add-ons, as `pnpm generate` does (templates/pack.mjs).

const template = (files: Record<string, string> = {}, addons?: string[]): TemplateSource => ({
  manifest: { name: "Plain", description: "A plain app.", fits: "Choose it for plain apps.", ...(addons && { addons }) },
  files: { "AGENTS.md": "# This Workspace\n", "src/index.ts": "export default {};\n", ...files },
});

const addon = (manifest: Partial<AddonManifest> = {}, files: Record<string, string> = { "src/server/thing.ts": "export const thing = 1;\n" }): AddonSource => ({
  manifest: { name: "Thing", description: "A thing.", fits: "Add it for things.", needs: [], packages: {}, secrets: [], edits: [], ...manifest },
  notes: "Use the thing.\n",
  files,
});

describe("packing", () => {
  it("builds a Template from the add-ons it names, with those they need first, and their notes under headings", () => {
    const packed = pack(
      { plain: template({}, ["organiser"]) },
      {
        store: addon({ name: "Storage" }, { "src/server/store.ts": "s" }),
        organiser: addon({ name: "Organiser's area", needs: ["store"] }, { "src/server/organiser.ts": "o" }),
      },
    );
    expect(packed.templates.plain!.files).toEqual({
      "AGENTS.md": "# This Workspace\n\n## Storage (add-on `store`)\n\nUse the thing.\n\n## Organiser's area (add-on `organiser`)\n\nUse the thing.\n",
      "src/index.ts": "export default {};\n",
      "src/server/store.ts": "s",
      "src/server/organiser.ts": "o",
    });
    expect(packed.addons.store).toMatchObject({ name: "Storage", notes: "## Storage (add-on `store`)\n\nUse the thing.\n" });
  });

  it("fails when an add-on needs one that isn't there", () => {
    expect(() => pack({}, { email: addon({ needs: ["storage"] }) })).toThrow(
      "The email add-on needs the add-on storage, but there's no addons/storage.",
    );
  });

  it("fails when a Template names an add-on that isn't there", () => {
    expect(() => pack({ plain: template({}, ["storage"]) }, {})).toThrow(
      "The plain Template names the add-on storage, but there's no addons/storage.",
    );
  });

  it.each(["^1.2.3", "~1.2.3", "1.x", "latest", "v1.2.3", ""])("fails on a Package whose version, %j, isn't exact", (version) => {
    expect(() => pack({}, { email: addon({ packages: { resend: version } }) })).toThrow(
      `The email add-on's Package resend has the version "${version}", which isn't exact.`,
    );
  });

  it("fails on a Secret without the reason to give the Developer", () => {
    expect(() => pack({}, { email: addon({ secrets: [{ name: "RESEND_API_KEY" } as AddonManifest["secrets"][number]] }) })).toThrow(
      "The email add-on's Secret RESEND_API_KEY needs a name and the reason to give the Developer.",
    );
  });

  it("fails when an add-on and its Template write the same file", () => {
    expect(() => pack({ plain: template({ "src/server/thing.ts": "mine" }, ["thing"]) }, { thing: addon() })).toThrow(
      "The thing add-on and the plain Template both write src/server/thing.ts. Only one of them may.",
    );
  });

  it("fails when two add-ons a Template applies write the same file", () => {
    expect(() => pack({ plain: template({}, ["one", "two"]) }, { one: addon(), two: addon() })).toThrow(
      "The two add-on and the one add-on both write src/server/thing.ts. Only one of them may.",
    );
  });

  it("fails when an add-on and one it needs write the same file, as add_addon would add them together", () => {
    expect(() => pack({}, { one: addon(), two: addon({ needs: ["one"] }) })).toThrow(
      "The two add-on and the one add-on both write src/server/thing.ts. Only one of them may.",
    );
  });

  it("fails when an add-on and one it needs ask for different versions of a Package, but not the same one", () => {
    const one = (version: string) => addon({ packages: { resend: version } }, { "src/server/one.ts": "1" });
    const two = (version: string) => addon({ needs: ["one"], packages: { resend: version } }, { "src/server/two.ts": "2" });
    expect(() => pack({}, { one: one("1.0.0"), two: two("1.1.0") })).toThrow(
      "The two add-on and the one add-on ask for different versions of the Package resend, 1.1.0 and 1.0.0. Give them one.",
    );
    expect(() => pack({}, { one: one("1.0.0"), two: two("1.0.0") })).not.toThrow();
  });

  it("fails when an add-on needs itself, even one no Template names", () => {
    expect(() => pack({}, { one: addon({ needs: ["one"] }) })).toThrow("The one add-on needs itself, through one, one.");
  });

  it("fails when an add-on needs itself through another", () => {
    expect(() => pack({ plain: template({}, ["one"]) }, { one: addon({ needs: ["two"] }), two: addon({ needs: ["one"] }) })).toThrow(
      "The one add-on needs itself, through one, two, one.",
    );
  });
});

describe("whether an app has an add-on", () => {
  it("goes by a heading that ends with its ID, whatever the add-on was called then", () => {
    expect(hasAddon("# This Workspace\n\n## Storage (add-on `storage`)\n\nNotes.\n", "storage")).toBe(true);
    expect(hasAddon("## Somewhere to keep things (add-on `storage`)  \n", "storage")).toBe(true);
    expect(hasAddon("## Storage (add-on `storage`)\n", "email")).toBe(false);
    // Only a heading counts, not a mention.
    expect(hasAddon("Like the one called Storage (add-on `storage`)\n", "storage")).toBe(false);
  });
});

describe("what the Agent is told about alarms (#147)", () => {
  // The limits are the Installation's configuration, and the notes give its defaults in words.
  const { APP_ALARM_MIN_INTERVAL_MS: interval, APP_ALARMS_PER_SLOT: cap } = (
    parseJsonc(wranglerConfig) as { vars: { APP_ALARM_MIN_INTERVAL_MS: number; APP_ALARMS_PER_SLOT: number } }
  ).vars;
  const intervalInWords = interval === 60_000 ? "a minute" : `${interval / 60_000} minutes`;
  const told = [
    ["the Agent's instructions", instructions],
    ...listTemplates().map(({ id }) => [`the ${id} Template's notes`, getTemplate(id)!.files["AGENTS.md"]!]),
  ];

  it.each(told)("%s say alarms work as on Cloudflare, with the Installation's limits, a repeating task's next alarm, and no cron triggers", (_, text) => {
    expect(text).toContain("setAlarm");
    expect(text).toContain("alarm()");
    expect(text).toContain(`at least ${intervalInWords} after`);
    expect(text).toContain(`at most ${cap.toLocaleString("en-GB")} instances`);
    expect(text).toMatch(/repeating task[^.]*alarm\(\)[^.]*then sets the next/);
    expect(text).toMatch(/[Cc]ron triggers aren't available/);
  });

  it.each(told.slice(1))(
    "%s say a failing alarm() is retried, to record what each ring has done so a retry doesn't do it again, and how a repeating task survives a failure that won't pass",
    (_, notes) => {
      expect(notes).toContain(`retried ${intervalInWords} later`);
      expect(notes).toContain(`${alarmRetries} times, with \`info.retryCount\` 1 to ${alarmRetries}, and then dropped`);
      expect(notes).toContain("a retry doesn't do it again");
      // Marks kept for good would skip everyone the next time a repeating task rings, and
      // getAlarm() reads null during alarm(), so the task keeps the time it set.
      expect(notes).toContain("under the time it was set for");
      // Thrown after setAlarm, a failure isn't retried; thrown on the last retry, it ends the task.
      expect(notes).toContain("sets the next alarm last");
      expect(notes).toContain(`\`info.retryCount\` is ${alarmRetries}`);
    },
  );

  it("the email add-on's notes say the Preview's alarms send real email, to suggest the Developer's own address, and to mark each email sent", () => {
    const notes = addonWithNeeds("email")!.at(-1)!.notes;
    expect(notes).toContain("the Preview's alarms ring by themselves");
    expect(notes).toContain("real email");
    expect(notes).toContain("their own address");
    expect(notes).toContain("mark each email sent");
    // Thrown after setting the next alarm, a failure isn't retried; a refusal that won't pass mustn't end a repeating task.
    expect(notes).toContain("before setting the next alarm");
    // A refusal is refused again, so only an email that couldn't be sent is retried, going by sendEmail's error.
    expect(notes).toContain("an `error` that starts \"The email wasn't sent\"");
    expect(notes).toContain("Log one Resend refused and carry on");
  });
});

describe("what the Agent is told about reminders (#148)", () => {
  it("the Agent's instructions list the reminders add-on with when it fits, point to it from alarms, and call an alarm a reminder", () => {
    expect(instructions).toMatch(/ {2}- reminders \(Reminders\): .+ Add it when the app has to email people at a set time/);
    expect(instructions).toContain("To email someone a reminder at a time the app keeps, such as the day before each run they signed up for, add the reminders add-on rather than an alarm of your own.");
    expect(instructions).toContain('"a reminder" for an alarm');
  });

  it.each(listTemplates().map(({ id }) => [id]))("the %s Template's notes point to the reminders add-on from alarms", (id) => {
    expect(getTemplate(id)!.files["AGENTS.md"]).toContain("To email someone a reminder at a time the app keeps, such as the day before each run they signed up for, add the reminders add-on");
  });

  it("its notes cover time zones, asking for the Developer's with ask, real email from the Preview, and one reminder per person per thing", () => {
    const chain = addonWithNeeds("reminders")!;
    expect(chain.map(({ id }) => id)).toEqual(["storage", "email", "reminders"]);
    const notes = chain.at(-1)!.notes;
    expect(notes).toMatch(/^## Reminders \(add-on `reminders`\)\n/);
    expect(notes).toContain("instantAt(date, time, c.env.TIME_ZONE)");
    expect(notes).toContain("follows summer time");
    expect(notes).toContain("When you don't know the Developer's time zone, ask with `ask`");
    expect(notes).toContain("The Preview sends real email");
    expect(notes).toContain("their own address");
    expect(notes).toContain("One reminder per person per thing");
    // A retry never sends one twice.
    expect(notes).toContain("so a retry sends only those not sent");
  });
});
