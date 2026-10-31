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
- **Build:** a Build runs after the Check at the end of every Turn, and type errors don't stop it. Call the `build` tool to see Build errors sooner. The Build uses esbuild (through `@cloudflare/worker-bundler`). It builds the Worker from `main` in `wrangler.jsonc`, reading the compatibility date, flags and `vars` there, and the scripts and stylesheets `index.html` links, with React's automatic JSX runtime. `index.html` keeps its `/src/...` links: the Build points them at what it makes.

## Serving

The platform serves the front end and `public/` in front of the Worker, as Cloudflare would with the `assets` settings in `wrangler.jsonc`. Only `not_found_handling` and `run_worker_first` apply. There's no `ASSETS` binding, so `c.env.ASSETS` doesn't exist: the Worker never needs to serve the front end itself.

## Tailwind

- `src/styles.css` imports Tailwind with `@import "tailwindcss";`. The platform compiles it with its own Tailwind 4, so `tailwindcss` isn't a Package: don't add it.
- The CSS has the classes the Workspace's files use. Write each class name whole, such as `bg-sky-600`. A class name pieced together at runtime, such as `` `bg-${colour}-600` ``, isn't found.
- `@theme`, `@utility`, `@variant`, `@apply` and `@import` of your own stylesheets all work. `@plugin` and `@config` fail the Build: there are no Tailwind plugins, such as typography or forms, and no `tailwind.config.js`.
- A stylesheet that doesn't import `tailwindcss` is plain CSS. The Build combines it with its `@import`s.

## Tests

- Write tests in files named like `src/index.test.ts`, beside the code they test, and import from `vitest`. The platform provides `vitest`, so it isn't a Package: don't add it.
- Run them with the `test` tool. They also run at the end of every Turn, after the Build. Failing tests show in the Developer's problems list, but don't ask you to retry.
- Each test file runs on its own, in a fresh Worker. Supported: `describe`, `it` and `test` (with `skip`, `only`, `todo` and `each`), the hooks, `expect` with vitest's matchers, `vi.fn`, `vi.spyOn`, `vi.stubGlobal` and fake timers.
- Not supported: `vi.mock` and anything else that replaces a module, snapshots, and coverage. Pass fakes in, or spy on an object the code calls, and compare with `toEqual`.
- Test the Worker's routes end to end with `app.request(path, init, env)`, as `src/server/index.test.ts` does. Pass the `env` the test needs: tests don't get the app's vars, secrets or Durable Object bindings.
- There's no DOM in tests, so `@testing-library/react` and its kin don't work. Render components to HTML with `renderToString` from `react-dom/server`, as `src/client/App.test.tsx` does, and test their logic as plain functions.
- Tests have no network: `fetch` to another site fails. Replace it with `vi.spyOn(globalThis, "fetch")`.

## Code the Build understands

- Link stylesheets from `index.html`. Don't import CSS from code, and don't use CSS modules (`*.module.css`): the Build drops CSS imported from code.
- Import your own files by relative path (`./routes/users`). The Build ignores `paths` in the tsconfig files, so `@/` aliases don't resolve.
- Don't import images from code. Put SVG images in `public/` and refer to them by URL, such as `/logo.svg`. Files in `public/` are served as text, so a PNG, a JPEG or a font file there would arrive damaged: use SVG, or a URL on another site.
- Don't use `import.meta.env`: the Build has none. The Worker reads configuration from `c.env`; the front end asks the Worker for what it needs.
- `Env`, the type of `c.env`, is declared in `worker-configuration.d.ts`. When you add a var to `wrangler.jsonc` or use a secret, add its name to the `__BaseEnv_Env` interface at the top of that file.

## Runtime

- **Cookies:** every cookie name starts with `__Host-`; the platform drops all other cookies. With `hono/cookie`, `setCookie(c, "session", value, { prefix: "host" })` and `getCookie(c, "session", "host")` add the prefix and its required attributes for you. The platform keeps the name `__Host-jigworks-preview` for itself.
- **Reserved paths:** the platform answers `/__jigworks/` and everything below it itself, so app code never sees those requests.
- **Storage:** Durable Objects are the only storage. KV, D1, R2, queues and cron triggers aren't available: the Build fails if `wrangler.jsonc` asks for them. To store data:
  - declare a binding in `wrangler.jsonc`: `"durable_objects": { "bindings": [{ "name": "NOTES", "class_name": "Notes" }] }`. No `migrations` are needed;
  - export `class Notes extends DurableObject` (from `cloudflare:workers`) from `src/server/index.ts`, and keep its data in `this.ctx.storage.sql`, each instance's own SQLite database;
  - add `NOTES: DurableObjectNamespace<import("./src/server/index").Notes>;` to `__BaseEnv_Env` in `worker-configuration.d.ts`;
  - reach an instance with `c.env.NOTES.getByName(name)`, and call its methods or its `fetch`. Arguments and results must be values that can be copied. Use the `env` the platform passes in (`c.env`, or `fetch`'s and the class's `env`): `env` imported from `cloudflare:workers` doesn't have the binding;
  - in the class, `this.ctx.id.name` is the name the instance was reached by.

  The Preview's data and the Deployment's are kept apart. Both survive new code, and the Preview's isn't copied when the Developer publishes. Renaming a binding starts it afresh.
- **Outbound requests:** `fetch` to any external URL works.
- **Secrets:** each secret the Developer sets appears in `env` under its name, for example `c.env.API_KEY`, in the Preview and the Deployment. Never log a secret or send it anywhere but the service it's for.
