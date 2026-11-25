# This Workspace

A Cloudflare Worker written with Hono. `src/index.ts` is the entry point.

## The platform does the running

This Workspace runs only inside the platform. There is no local machine and nothing to start: `npm`, `npx`, `wrangler` and `vite` aren't available, and nothing here needs them.

- **Packages:** add one with the `add_package` tool. It installs the Package and writes its exact version into `package.json`. Every version in `package.json` is exact (no `^` or `~`); leave them to `add_package`.
- **Checks:** a Check (a type-check with TypeScript 7 rules) runs automatically at the end of every Turn. Call the `check` tool to see the errors sooner, for example after a large change.
- **Build:** the Build uses esbuild (through `@cloudflare/worker-bundler`), starting from `src/index.ts`, and reads `wrangler.jsonc` for the compatibility date, flags and `vars`. A Build runs after the Check at the end of every Turn, and type errors don't stop it. Call the `build` tool to see Build errors sooner.

## Tests

- Write tests in files named like `src/index.test.ts`, beside the code they test, and import from `vitest`. The platform provides `vitest`, so it isn't a Package: don't add it.
- Run them with the `test` tool. They also run at the end of every Turn, after the Build. Failing tests show in the Developer's problems list, but don't ask you to retry.
- Each test file runs on its own, in a fresh Worker. Supported: `describe`, `it` and `test` (with `skip`, `only`, `todo` and `each`), the hooks, `expect` with vitest's matchers, `vi.fn`, `vi.spyOn`, `vi.stubGlobal` and fake timers.
- Not supported: `vi.mock` and anything else that replaces a module, snapshots, and coverage. Pass fakes in, or spy on an object the code calls, and compare with `toEqual`.
- Test the app's routes end to end with `app.request(path, init, env)`, as `src/index.test.ts` does. Pass the `env` the test needs: tests don't get the app's vars, secrets or Durable Object bindings.
- Tests have no network: `fetch` to another site fails. Replace it with `vi.spyOn(globalThis, "fetch")`.

## Code the Build understands

- Import your own files by relative path (`./routes/users`). The Build ignores `paths` in `tsconfig.json`, so `@/` aliases don't resolve.
- Read configuration from `c.env`. The Build has no `import.meta.env`.
- Import only code and JSON. The Build drops CSS imported from code, treats CSS modules as plain CSS, and can't import images.
- `Env`, the type of `c.env`, is declared in `worker-configuration.d.ts`. When you add a var to `wrangler.jsonc` or use a secret, add its name to the `__BaseEnv_Env` interface at the top of that file.

## Runtime

- **Cookies:** every cookie name starts with `__Host-`; the platform drops all other cookies. With `hono/cookie`, `setCookie(c, "session", value, { prefix: "host" })` and `getCookie(c, "session", "host")` add the prefix and its required attributes for you. The platform keeps the name `__Host-jigworks-preview` for itself.
- **Reserved paths:** the platform answers `/__jigworks/` and everything below it itself, so app code never sees those requests.
- **Storage:** Durable Objects are the only storage. KV, D1, R2, queues and cron triggers aren't available: the Build fails if `wrangler.jsonc` asks for them. To keep records, add the storage add-on with the `add_addon` tool. For a Durable Object of your own:
  - declare a binding in `wrangler.jsonc`: `"durable_objects": { "bindings": [{ "name": "NOTES", "class_name": "Notes" }] }`. No `migrations` are needed;
  - export `class Notes extends DurableObject` (from `cloudflare:workers`) from `src/index.ts`, and keep its data in `this.ctx.storage.sql`, each instance's own SQLite database;
  - add `NOTES: DurableObjectNamespace<import("./src/index").Notes>;` to `__BaseEnv_Env` in `worker-configuration.d.ts`;
  - reach an instance with `c.env.NOTES.getByName(name)`, and call its methods or its `fetch`. Arguments and results must be values that can be copied. Use the `env` the platform passes in (`c.env`, or `fetch`'s and the class's `env`): `env` imported from `cloudflare:workers` doesn't have the binding;
  - in the class, `this.ctx.id.name` is the name the instance was reached by.

  The Preview's data and the Deployment's are kept apart. Both survive new code, and the Preview's isn't copied when the Developer publishes. Renaming a binding starts it afresh.
- **Alarms:** for anything the app does at a time with no one opening it, such as emailing a reminder the day before a run, give a Durable Object of your own an alarm, as Cloudflare's docs show. Cron triggers aren't available, so a timetable is an alarm too.
  - `await this.ctx.storage.setAlarm(time)` sets the instance's one alarm, replacing any other. At that time the platform calls the class's `async alarm(info)` method, which a class that sets an alarm must have. `getAlarm()` reads the time, or `null`, and `deleteAlarm()` cancels it.
  - A repeating task, such as a rota every Monday, is one alarm: `alarm()` does the task, then sets the next with `setAlarm`.
  - An alarm rings at least a minute after it was set: one set sooner rings a minute after, and `getAlarm()` reads that time. The Preview and the Deployment can each have alarms set in at most 1,000 instances, and past that `setAlarm` throws. So keep a list of times in one instance and set its alarm for the next one due, rather than an instance for each person or thing.
  - If `alarm()` throws, it's retried a minute later, then after twice as long each time, 6 times, with `info.retryCount` 1 to 6, and then dropped. A ring that's cut off, such as by new code, is retried too. A retry runs `alarm()` from the start, and what it stored before then is kept. So record each thing it does as soon as it's done, such as each email sent, and skip what's recorded, so a retry doesn't do it again. `getAlarm()` reads `null` in `alarm()`, so keep the time you set the alarm for in storage beside it, and for a repeating task, record what it's done under the time it was set for, so the next time starts afresh.
  - One that set or deleted its alarm before it threw isn't retried. So a repeating task sets the next alarm last, after anything that can throw. On its last try, when `info.retryCount` is 6, it catches a failure, logs it and sets the next anyway, so a failure that won't pass doesn't end the task.
  - The Preview's alarms ring by themselves, as the Deployment's do, each with its own data and the code it has when the alarm rings. Each ring, and each failure, is in the Preview's logs, which `preview_logs` reads.
  - Tests don't get Durable Objects, so keep what `alarm()` does in a function that takes what it needs, such as the time now, test that, and call it from `alarm()`.
- **Outbound requests:** `fetch` to any external URL works.
- **Secrets:** each secret the Developer sets appears in `env` under its name, for example `c.env.API_KEY`, in the Preview and the Deployment. Never log a secret or send it anywhere but the service it's for.
