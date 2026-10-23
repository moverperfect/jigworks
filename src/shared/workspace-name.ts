// The rule for a Workspace's name, shared by the API and the platform's pages.

export const maxNameLength = 60;

/** Says what's wrong with a Workspace name, or returns null if it's fine. The name is trimmed first. */
export function validateWorkspaceName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Enter a name for the Workspace.";
  if (trimmed.length > maxNameLength) {
    return `Use ${maxNameLength} characters or fewer. This name has ${trimmed.length}.`;
  }
  return null;
}
