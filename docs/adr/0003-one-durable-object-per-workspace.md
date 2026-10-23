# A Workspace's files and its one Conversation share a Durable Object

Each Workspace is one Think Durable Object, and its Conversation and files both live in that object's storage. Think holds exactly one conversation per instance. So several Conversations per Workspace would mean a Durable Object per Conversation, a separate one for the files, file access over RPC, and our own Turn lock across Conversations. None of that tests ts-rust. With one Conversation per Workspace, Turns queue inside the object, and Developer edits and Checks go through the same object.

## Consequences

- Cloudflare calls its file store `Workspace` too. In our code it's called `files`, so the word Workspace only ever means ours. The one exception is the property Think itself reads, `workspace`, whose name Think fixes; only the Workspace class and the file store's own test touch it.
- Think 0.20.2 keeps files in `@cloudflare/shell`'s store. Cloudflare is moving Think to `@cloudflare/computer`, which uses different tables, so the Think upgrade that makes that move is a data migration, not a version bump. See `docs/research/think-file-store.md`.
- "Start fresh" compacts older messages in the Conversation. It doesn't open a new one.
- Think can move large media out of the chat history into `/attachments/` in the same file store. That path is hidden from the Developer's file tree, left out of the zip export, and skipped by the Check.
- The Workspace's apps run in a second object, so a Check or a Build can't stall them (ADR 0009).
- Moving to several Conversations per Workspace later means splitting the files into their own Durable Object and migrating existing Workspaces. See `docs/research/think-sessions-workspace.md`.
