import packed from "../generated/templates.txt";

/** A starting set of files for a new Workspace, packed from templates/ by templates/pack.mjs. */
export interface Template {
  id: string;
  name: string;
  description: string;
  /** Path to text: the files copied into a new Workspace. */
  files: Record<string, string>;
}

const { runtimeTypes, templates: packedTemplates } = JSON.parse(packed) as {
  /** The end of every Template's `worker-configuration.d.ts`, packed once. */
  runtimeTypes: string;
  templates: Record<string, Omit<Template, "id">>;
};
const typesFile = "worker-configuration.d.ts";

const templates = new Map(
  Object.entries(packedTemplates).map(([id, { files, ...template }]) => [
    id,
    { id, ...template, files: typesFile in files ? { ...files, [typesFile]: files[typesFile] + runtimeTypes } : files },
  ]),
);

/** Every Template, without its files. */
export function listTemplates(): Omit<Template, "files">[] {
  return [...templates.values()].map(({ id, name, description }) => ({ id, name, description }));
}

export function getTemplate(id: string): Template | undefined {
  return templates.get(id);
}
