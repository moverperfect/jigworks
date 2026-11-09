// Packs the Templates and add-ons, read from templates/ and addons/ by
// templates/pack.mjs, which runs this under Node. No Node APIs here, so the
// platform's tests can run it too.
import { valid } from "semver";

/** A Template's folder: its template.json, and every other file in it. */
export interface TemplateSource {
  manifest: { name: string; description: string; fits: string; addons?: string[] };
  files: Record<string, string>;
}

/** An add-on's addon.json. */
export interface AddonManifest {
  name: string;
  description: string;
  /** When the Agent should add it, as a sentence for its instructions, like a Template's. */
  fits: string;
  /** The add-ons it needs, by ID. */
  needs: string[];
  /** Each Package it installs, by name, at an exact version. */
  packages: Record<string, string>;
  /** The Secrets it needs, each with the reason to give the Developer. */
  secrets: { name: string; reason: string }[];
  /** The edits that join it to an app, for the Agent to make. */
  edits: string[];
}

/** An add-on's folder: its addon.json, its notes.md, and every other file in it. */
export interface AddonSource {
  /** Its lists may be left out when they're empty. */
  manifest: Omit<AddonManifest, "needs" | "packages" | "secrets" | "edits"> &
    Partial<Pick<AddonManifest, "needs" | "packages" | "secrets" | "edits">>;
  notes: string;
  files: Record<string, string>;
}

export interface PackedTemplate {
  name: string;
  description: string;
  /** When the Agent should choose it, as a sentence for its instructions (ADR 0018). */
  fits: string;
  /** Path to text: the files copied into a new Workspace. */
  files: Record<string, string>;
}

export interface PackedAddon extends AddonManifest {
  /** Its notes for the Workspace's AGENTS.md, under a heading that names it, which records that the app has it. */
  notes: string;
  files: Record<string, string>;
}

export interface Packed {
  /** The end of every Template's `worker-configuration.d.ts`, packed once. */
  runtimeTypes: string;
  templates: Record<string, PackedTemplate>;
  addons: Record<string, PackedAddon>;
}

const runtimeTypesStart = "// Begin runtime types";
const typesFile = "worker-configuration.d.ts";
const agentsFile = "AGENTS.md";

/** What ends the heading an add-on's notes go under in AGENTS.md, whatever the add-on was called then. */
const addonMark = (id: string) => `(add-on \`${id}\`)`;

/** The heading an add-on's notes go under in AGENTS.md, which records that the app has it. */
export const addonHeading = (id: string, name: string) => `## ${name} ${addonMark(id)}`;

/** Whether an app has the add-on `id`, going by the headings in its `agentsMd`. */
export function hasAddon(agentsMd: string, id: string): boolean {
  return agentsMd.split("\n").some((line) => line.startsWith("## ") && line.trimEnd().endsWith(addonMark(id)));
}

/**
 * The add-ons `ids` and those they need, each once, with an add-on's needs
 * before it, appended to `into`. Throws, naming `namedBy`, on one that isn't
 * in `addons` or that needs itself.
 */
export function withNeeds(
  addons: Record<string, Pick<AddonManifest, "needs">>,
  ids: string[],
  namedBy: string,
  into: string[] = [],
  path: string[] = [],
): string[] {
  for (const id of ids) {
    if (!addons[id]) throw new Error(`${namedBy} names the add-on ${id}, but there's no addons/${id}.`);
    if (path.includes(id)) throw new Error(`The ${id} add-on needs itself, through ${[...path, id].join(", ")}.`);
    withNeeds(addons, addons[id].needs, `The ${id} add-on`, into, [...path, id]);
    if (!into.includes(id)) into.push(id);
  }
  return into;
}

/**
 * Packs the Templates and add-ons. A Template that names add-ons gets their
 * files, and those of the add-ons they need, with their notes appended to
 * its AGENTS.md; its own files already make the edits that join them to it.
 * Throws, with a message saying what to fix, on a manifest that names a
 * missing add-on or a Package without an exact version, or on two that write
 * the same file.
 */
export function pack(templateSources: Record<string, TemplateSource>, addonSources: Record<string, AddonSource>): Packed {
  const addons: Record<string, PackedAddon> = {};
  for (const [id, { manifest, notes, files }] of Object.entries(addonSources)) {
    for (const field of ["name", "description", "fits"] as const) {
      if (typeof manifest[field] !== "string" || !manifest[field]) throw new Error(`The ${id} add-on's addon.json has no ${field}.`);
    }
    const { name, description, fits, needs = [], packages = {}, secrets = [], edits = [] } = manifest;
    for (const [pkg, version] of Object.entries(packages)) {
      if (valid(version) !== version) {
        throw new Error(`The ${id} add-on's Package ${pkg} has the version "${version}", which isn't exact. Give one version, such as 1.2.3.`);
      }
    }
    for (const secret of secrets) {
      if (!secret?.name || !secret.reason) {
        throw new Error(`The ${id} add-on's Secret ${secret?.name ?? ""} needs a name and the reason to give the Developer.`);
      }
    }
    addons[id] = { name, description, fits, needs, packages, secrets, edits, notes: `${addonHeading(id, name)}\n\n${notes}`, files };
  }
  for (const [id, { needs }] of Object.entries(addons)) {
    for (const need of needs) if (!addons[need]) throw new Error(`The ${id} add-on needs the add-on ${need}, but there's no addons/${need}.`);
  }

  // Every add-on's, so one no Template names can't need itself either.
  withNeeds(addons, Object.keys(addons), "addons/");
  // add_addon adds an add-on with those it needs, so together they may write
  // each file only once and ask for only one version of each Package.
  for (const id of Object.keys(addons)) {
    const writtenBy = new Map<string, string>();
    const versions = new Map<string, { version: string; by: string }>();
    for (const one of withNeeds(addons, [id], "addons/")) {
      const { files, packages } = addons[one]!;
      for (const file of Object.keys(files)) {
        const other = writtenBy.get(file);
        if (other) throw new Error(`The ${one} add-on and the ${other} add-on both write ${file}. Only one of them may.`);
        writtenBy.set(file, one);
      }
      for (const [pkg, version] of Object.entries(packages)) {
        const other = versions.get(pkg);
        if (other && other.version !== version) {
          throw new Error(`The ${one} add-on and the ${other.by} add-on ask for different versions of the Package ${pkg}, ${version} and ${other.version}. Give them one.`);
        }
        versions.set(pkg, { version, by: one });
      }
    }
  }

  let runtimeTypes = "";
  const templates: Record<string, PackedTemplate> = {};
  for (const [templateId, { manifest, files: own }] of Object.entries(templateSources)) {
    const { name, description, fits, addons: applied = [] } = manifest;
    const files = { ...own };
    const writtenBy = new Map(Object.keys(own).map((file) => [file, `the ${templateId} Template`]));
    for (const id of withNeeds(addons, applied, `The ${templateId} Template`)) {
      const addon = addons[id]!;
      if (Object.keys(addon.packages).length) {
        throw new Error(`The ${templateId} Template is built from the ${id} add-on, whose Packages packing can't add yet.`);
      }
      for (const [file, text] of Object.entries(addon.files)) {
        const other = writtenBy.get(file);
        if (other) throw new Error(`The ${id} add-on and ${other} both write ${file}. Only one of them may.`);
        writtenBy.set(file, `the ${id} add-on`);
        files[file] = text;
      }
      if (!(agentsFile in files)) throw new Error(`The ${templateId} Template has no ${agentsFile} for the ${id} add-on's notes.`);
      files[agentsFile] = `${files[agentsFile]!.trimEnd()}\n\n${addon.notes}`;
    }

    const start = files[typesFile]?.indexOf(runtimeTypesStart) ?? -1;
    if (start >= 0) {
      const types = files[typesFile]!.slice(start);
      if (runtimeTypes && types !== runtimeTypes) {
        throw new Error(`${templateId}'s runtime types differ from another Template's. Generate them with the same wrangler and compatibility date.`);
      }
      runtimeTypes = types;
      files[typesFile] = files[typesFile]!.slice(0, start);
    }
    templates[templateId] = { name, description, fits, files };
  }
  return { runtimeTypes, templates, addons };
}
