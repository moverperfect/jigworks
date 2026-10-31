// App secrets (ADR 0016): named values the Developer gives a Workspace, which
// reach its app's env, and whose values the Agent never reads.

import { platformEnvPrefix } from "./app-data";

/** The most secrets a Workspace can have, as Cloudflare allows a Worker. */
export const maxSecrets = 64;
/** The longest value a secret can have, in bytes, as Cloudflare allows. */
export const maxSecretBytes = 5120;

// A value shorter than this would hide ordinary text along with it, so it
// can't be a secret: settings that short belong in `vars`.
const shortestValue = 6;
// The shortest start of a value dropped from the end of text cut short.
const shortestPart = 4;

/** Why a secret can't be set, or null if it can. */
export function secretProblem(name: string, value: unknown): string | null {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) || name.startsWith(platformEnvPrefix)) {
    return "A secret's name starts with a letter or _, then has only letters, digits and _, up to 64 in all.";
  }
  if (typeof value !== "string" || value === "") return "Give the secret a value.";
  if (value.length < shortestValue) {
    return `A secret's value is at least ${shortestValue} characters, so it can be hidden from the Agent. Put a short setting in vars in wrangler.jsonc.`;
  }
  if (new TextEncoder().encode(value).length > maxSecretBytes) return `A secret's value can be up to ${maxSecretBytes} bytes.`;
  return null;
}

/** Each form a value takes in what the Agent reads: as it is, and escaped as JSON, as logged objects and JSON answers have it. */
function formsOf(secrets: [name: string, value: string][]): [name: string, form: string][] {
  return secrets.flatMap(([name, value]) => {
    const escaped = JSON.stringify(value).slice(1, -1);
    return escaped === value ? [[name, value]] : [[name, value], [name, escaped]];
  });
}

/** The length of the longest form of a value, so text read for hiding can run that far past where it's cut. */
export function longestSecret(secrets: [name: string, value: string][]): number {
  return Math.max(0, ...formsOf(secrets).map(([, form]) => form.length));
}

/**
 * `text` with each secret's value, in each of its forms, replaced by
 * `[secret NAME]`, then cut to `limit` characters. Longer forms are matched
 * first and all in one pass, so a value that contains another is hidden
 * whole. Text that ends with the start of a value loses that start.
 */
export function withoutSecrets(text: string, secrets: [name: string, value: string][], limit = Infinity): string {
  const forms = formsOf(secrets).sort(([, a], [, b]) => b.length - a.length);
  if (forms.length === 0) return text.slice(0, limit);
  const names = new Map([...forms].reverse().map(([name, form]) => [form, name] as const));
  const pattern = new RegExp(forms.map(([, form]) => form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  const hidden = text.replace(pattern, (form) => `[secret ${names.get(form)}]`).slice(0, limit);
  for (let length = Math.min(hidden.length, longestSecret(secrets)); length >= shortestPart; length--) {
    const end = hidden.slice(-length);
    if (forms.some(([, form]) => form.startsWith(end))) return hidden.slice(0, -length);
  }
  return hidden;
}
