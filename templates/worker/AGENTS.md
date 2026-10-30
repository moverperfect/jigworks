# This Workspace

A Cloudflare Worker written with Hono. `src/index.ts` is the entry point.

## The platform does the running

This Workspace runs only inside the platform. There is no local machine and nothing to start: `npm`, `npx`, `wrangler` and `vite` aren't available, and nothing here needs them.

- **Packages:** add one with the `add_package` tool. It installs the Package and writes its exact version into `package.json`. Every version in `package.json` is exact (no `^` or `~`); leave them to `add_package`.
- **Checks:** a Check (a type-check with TypeScript 7 rules) runs automatically at the end of every Turn. Call the `check` tool to see the errors sooner, for example after a large change.
- **Build:** the Build uses esbuild (through `@cloudflare/worker-bundler`), starting from `src/index.ts`, and reads `wrangler.jsonc` for the compatibility date, flags and `vars`. A Build runs after the Check at the end of every Turn, and type errors don't stop it. Call the `build` tool to see Build errors sooner.

## Code the Build understands

- Import your own files by relative path (`./routes/users`). The Build ignores `paths` in `tsconfig.json`, so `@/` aliases don't resolve.
- Read configuration from `c.env`. The Build has no `import.meta.env`.
- Import only code and JSON. The Build drops CSS imported from code, treats CSS modules as plain CSS, and can't import images.
- `Env`, the type of `c.env`, is declared in `worker-configuration.d.ts`. When you add a var to `wrangler.jsonc` or use a secret, add its name to the `__BaseEnv_Env` interface at the top of that file.

## Runtime

- **Cookies:** every cookie name starts with `__Host-`; the platform drops all other cookies. With `hono/cookie`, `setCookie(c, "session", value, { prefix: "host" })` and `getCookie(c, "session", "host")` add the prefix and its required attributes for you. The platform keeps the name `__Host-jigworks-preview` for itself.
- **Reserved paths:** the platform answers `/__jigworks/` and everything below it itself, so app code never sees those requests.
- **The Preview:** each good Build runs as the Preview. Try it with the `request_preview` tool, and read its logs and front-end errors with `preview_logs`.
- **Storage:** Durable Objects are the only storage. KV, D1, R2, queues and cron triggers aren't available.
- **Outbound requests:** `fetch` to any external URL works.
- **Secrets:** each secret the Developer sets appears in `env` under its name, for example `c.env.API_KEY`.
