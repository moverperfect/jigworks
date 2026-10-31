// App secrets (ADR 0016): named values the Developer gives a Workspace, which
// reach its app's env, and whose values the Agent never reads.

/** A Workspace's secrets: up to this many, each value up to this many bytes, as Cloudflare allows. */
export const maxSecrets = 64;
export const maxSecretBytes = 5120;

/** Why a secret can't be set, or null if it can. */
export function secretProblem(name: string, value: unknown): string | null {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) || name.startsWith("__jigworks")) {
    return "A secret's name starts with a letter or _, then has only letters, digits and _, up to 64 in all.";
  }
  if (typeof value !== "string" || value === "") return "Give the secret a value.";
  if (new TextEncoder().encode(value).length > maxSecretBytes) return `A secret's value can be up to ${maxSecretBytes} bytes.`;
  return null;
}

// Shorter values would hide ordinary text along with them.
const hiddenFrom = 6;

/** `text` with each secret's value, of 6 characters or more, replaced by `[secret NAME]`. */
export function withoutSecrets(text: string, secrets: Record<string, string>): string {
  let hidden = text;
  for (const [name, value] of Object.entries(secrets)) {
    if (value.length >= hiddenFrom) hidden = hidden.replaceAll(value, `[secret ${name}]`);
  }
  return hidden;
}
