# Durable Objects are the only storage

Everything is kept in Durable Object SQLite, so that an Operator has the fewest products to set up: only Workers and Durable Objects. That covers each Workspace's files, its Conversation, the packages it has downloaded and their resolved versions, its Builds, and its apps' data. It also covers one small object per Developer that lists their Workspaces. We don't use R2, D1 or Workers KV. (A Durable Object's own key-value storage is part of its SQLite database, so using it is fine.) Packages are stored in each Workspace rather than in a shared cache. That duplicates them, but a Check never has to reach into another object.

## Consequences

- A single file can't be larger than about 2 MB, the SQLite row limit. Cloudflare's file store normally moves files over 1.5 MB to R2. Without R2 it keeps them inline and logs a warning.
- Each Workspace downloads its own copy of every package from npm.
- If R2 is used later, the shared package cache is the first thing to move there (ticket 19).
