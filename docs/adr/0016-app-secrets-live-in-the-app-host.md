# App secrets live in the app host, and the Agent sees only their names

The Developer gives a Workspace secrets, such as API keys, which its app reads from `env`. The Agent writes the app's code, but must never be handed a secret's value.

- **Where they live.** In the Workspace's app host (ADR 0009), which already builds the app's `env`. They're in its SQLite, apart from the Workspace's files, so the Agent's file tools and bash can't reach them.
- **How they reach the app.** The app host puts each secret in `env` under its name, after the `vars` from `wrangler.jsonc`, in the Preview and the Deployment alike. A change reaches both at once. Its Worker is loaded again with the new `env`, and its Durable Object instances are stopped so they start with it.
- **What the Agent sees.** Their names, through `list_secrets`. The platform replaces each value with `[secret NAME]`, as it is and escaped as JSON, as logged objects and JSON answers have it:
  - in everything `request_preview` returns, its errors included;
  - in the app's logs as they're kept, which `preview_logs` and the Preview pane read.

  It hides values before cutting text short, and drops the start of a value left at the end of text that was cut. For an hour after a secret is replaced or removed, its old value is kept, only to be hidden too: a request that started before the change can still log it or answer with it.
- **The API never sends a value back.** It lists names and when each was set, and takes new values.

## Consequences

- **This keeps values out of the Agent's sight, not out of its reach.** The Agent writes the app's code, so code that encodes a value, or sends it to another site, can still get it out. The platform doesn't pretend otherwise.
- **The Deployment isn't frozen against secrets.** Changing a secret changes what the Deployment runs with, as `wrangler secret put` does on Cloudflare. Publishing copies a Build, not secrets.
- **A secret overrides an entry of the same name in `vars`.** A Durable Object binding's name can't be a secret's, since the binding takes it in `env`. A binding added later takes it from the secret.
- **A value is at least 6 characters,** because hiding a shorter one would mangle ordinary text. Short settings that aren't secret belong in `vars`.
- **A removed value stays stored for an hour,** for hiding only. An alarm in the app host then deletes it.
- **None of the platform Worker's own secrets reach an app:** an app's `env` holds its `vars`, its secrets and, with Durable Object bindings, `AppData` (ADR 0015).
- **Limits follow Cloudflare's:** up to 64 secrets, each up to 5,120 bytes. A name starts with a letter or `_`, then has only letters, digits and `_`.
- **Deleting the Workspace deletes its secrets** with the app host.
