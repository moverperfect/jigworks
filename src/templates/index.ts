import packed from "../generated/templates.txt";
import type { Packed, PackedAddon, PackedTemplate } from "./pack";

/** A starting set of files for a new Workspace, packed from templates/ by templates/pack.mjs. */
export interface Template extends PackedTemplate {
  id: string;
}

/** A tested set of files and notes that gives an app one ability, packed from addons/ by templates/pack.mjs. */
export interface Addon extends PackedAddon {
  id: string;
}

const { runtimeTypes, templates: packedTemplates, addons: packedAddons } = JSON.parse(packed) as Packed;
const typesFile = "worker-configuration.d.ts";

const templates = new Map(
  Object.entries(packedTemplates).map(([id, { files, ...template }]) => [
    id,
    { id, ...template, files: typesFile in files ? { ...files, [typesFile]: files[typesFile] + runtimeTypes } : files },
  ]),
);

/** Every Template, without its files. */
export function listTemplates(): Omit<Template, "files">[] {
  return [...templates.values()].map(({ id, name, description, fits }) => ({ id, name, description, fits }));
}

export function getTemplate(id: string): Template | undefined {
  return templates.get(id);
}

const addons = new Map(Object.entries(packedAddons).map(([id, addon]) => [id, { id, ...addon }]));

/** Every add-on's ID, name, description and when it fits. */
export function listAddons(): Pick<Addon, "id" | "name" | "description" | "fits">[] {
  return [...addons.values()].map(({ id, name, description, fits }) => ({ id, name, description, fits }));
}
