import packed from "../generated/templates.txt";

/** A starting set of files for a new Workspace, packed from templates/ by templates/pack.mjs. */
export interface Template {
  id: string;
  name: string;
  description: string;
  /** Path to text: the files copied into a new Workspace. */
  files: Record<string, string>;
}

const templates = new Map(
  Object.entries(JSON.parse(packed) as Record<string, Omit<Template, "id">>).map(([id, template]) => [
    id,
    { id, ...template },
  ]),
);

/** Every Template, without its files. */
export function listTemplates(): Omit<Template, "files">[] {
  return [...templates.values()].map(({ id, name, description }) => ({ id, name, description }));
}

export function getTemplate(id: string): Template | undefined {
  return templates.get(id);
}
