# This Workspace

A Cloudflare Worker written with Hono, with a React front end styled with Tailwind.

- `src/server/index.ts` is the Worker. It answers `/api/*`.
- `index.html` is the front end's page. It links `src/client/main.tsx`, which runs in the browser, and `src/styles.css`.
- `src/shared/` holds code and types both use.
- `public/` holds files served as they are, at the root: `public/favicon.svg` is `/favicon.svg`.

## The platform does the running

This Workspace runs only inside the platform. There is no local machine and nothing to start: `npm`, `npx`, `wrangler` and `vite` aren't available, and nothing here needs them.

- **Packages:** add one with the `add_package` tool. It installs the Package and writes its exact version into `package.json`. Every version in `package.json` is exact (no `^` or `~`); leave them to `add_package`.
- **Checks:** a Check (a type-check with TypeScript 7 rules) runs automatically at the end of every Turn. It checks `tsconfig.server.json` (Workers types, no DOM) and `tsconfig.client.json` (the DOM, and JSX through React) separately. Call the `check` tool to see the errors sooner, for example after a large change.
- **Build:** a Build runs after the Check at the end of every Turn, and type errors don't stop it. Call the `build` tool to see Build errors sooner. The Build uses esbuild (through `@cloudflare/worker-bundler`):
  - it bundles the Worker from `main` in `wrangler.jsonc`, and reads the compatibility date, flags and `vars` there;
  - it bundles each `<script type="module" src="/src/...">` that `index.html` links for the browser, with React's automatic JSX runtime, and points `index.html` at the bundle;
  - it compiles each stylesheet that `index.html` links, and points `index.html` at the result.

## Serving

As on Cloudflare, with the `assets` settings in `wrangler.jsonc`:

- A request for a file the Build makes (`index.html`, a bundle, a stylesheet or a file in `public/`) gets that file, before the Worker sees it.
- `/api/*` always goes to the Worker (`run_worker_first`).
- Any other page navigation gets `index.html` (`single-page-application`), so the front end can route it. Other requests go to the Worker.

## Tailwind

- `src/styles.css` imports Tailwind with `@import "tailwindcss";`. The platform compiles it with its own Tailwind (version 4.3.3), so `tailwindcss` isn't a Package: don't add it.
- The CSS has the classes the Workspace's files use. Write each class name whole, such as `bg-sky-600`. A class name pieced together at runtime, such as `` `bg-${colour}-600` ``, isn't found.
- `@theme`, `@utility`, `@variant`, `@apply` and `@import` of your own stylesheets all work. `@plugin` and `@config` fail the Build: there are no Tailwind plugins, such as typography or forms, and no `tailwind.config.js`.
- A stylesheet that doesn't import `tailwindcss` is plain CSS. The Build combines it with its `@import`s.

## Code the Build understands

- Link stylesheets from `index.html`. Don't import CSS from code: the Build drops it.
- Don't use CSS modules (`*.module.css`): the Build treats them as plain, global CSS.
- Import your own files by relative path (`./routes/users`). The Build ignores `paths` in the tsconfig files, so `@/` aliases don't resolve.
- Don't import images or fonts from code. Put them in `public/` and refer to them by URL, such as `/logo.svg`.
- Don't use `import.meta.env`: the Build has none. The Worker reads configuration from `c.env`; the front end asks the Worker for what it needs.
- `Env`, the type of `c.env`, is declared in `worker-configuration.d.ts`. When you add a var to `wrangler.jsonc` or use a secret, add its name to the `__BaseEnv_Env` interface at the top of that file.

## Runtime

- **Cookies:** every cookie name starts with `__Host-`; the platform drops all other cookies. With `hono/cookie`, `setCookie(c, "session", value, { prefix: "host" })` and `getCookie(c, "session", "host")` add the prefix and its required attributes for you. The platform keeps the name `__Host-jigworks-preview` for itself.
- **Reserved paths:** the platform answers `/__jigworks/` and everything below it itself, so app code never sees those requests.
- **Storage:** Durable Objects are the only storage. KV, D1, R2, queues and cron triggers aren't available.
- **Outbound requests:** `fetch` to any external URL works.
- **Secrets:** each secret the Developer sets appears in `env` under its name, for example `c.env.API_KEY`.
