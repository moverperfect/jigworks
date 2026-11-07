// The rule for a Workspace's name, shared by the API and the platform's pages.

const maxNameLength = 60;

/** What a Workspace is called until the Agent starts its app and names it (ADR 0018). */
export const newAppName = "New app";

/** Says what's wrong with a Workspace name, or returns null if it's fine. The name is trimmed first. */
export function validateWorkspaceName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Enter a name for your app.";
  if (trimmed.length > maxNameLength) {
    return `Use ${maxNameLength} characters or fewer. This name has ${trimmed.length}.`;
  }
  return null;
}
