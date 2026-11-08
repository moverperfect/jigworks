import { describe, expect, it } from "vitest";
import { pack, type AddonManifest, type AddonSource, type TemplateSource } from "../src/templates/pack";

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

  it("fails when an add-on needs itself, even one no Template names", () => {
    expect(() => pack({}, { one: addon({ needs: ["one"] }) })).toThrow("The one add-on needs itself, through one, one.");
  });

  it("fails when an add-on needs itself through another", () => {
    expect(() => pack({ plain: template({}, ["one"]) }, { one: addon({ needs: ["two"] }), two: addon({ needs: ["one"] }) })).toThrow(
      "The one add-on needs itself, through one, two, one.",
    );
  });
});
