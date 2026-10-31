# Tests run on vitest's own parts, in Dynamic Workers

The Agent writes tests as it would for vitest. Real vitest needs Node, and so does Cloudflare's vitest integration (`docs/research/build-and-test-in-isolates.md`, §6). So the platform provides a `vitest` of its own, put together from the parts of vitest that run in Workers.

- **What it's made of.** vitest's runner, `expect` and spies, at the version of the platform's own vitest, with chai and the fake-timers library vitest builds its own timers on. The platform's own code is only the glue: how `expect` counts assertions, `vi`'s timers, and the report. All of it is packed into one module, the Tester.
- **What tests get.** `describe`, `it` and `test` with `skip`, `only`, `todo` and `each`, the hooks, `expect` with vitest's matchers, `vi.fn`, `vi.spyOn`, `vi.stubGlobal` and fake timers. `vi.mock` and the rest of `vi`'s module mocking, and the snapshot matchers, throw an error saying they aren't supported.
- **Bundling.** The test files are bundled as a Build is, with the Workspace's Packages, into one module, in a Dynamic Worker of its own: the Test bundler, reused, as the Checker is (ADR 0010). esbuild never gives memory back, and bundling React's tests in the Workspace's Durable Object put its isolate over the memory limit on the third run (`docs/findings.md`, stage 6), which would end a running Turn (ADR 0010). The bundle's entry imports each test file only when the Tester runs it, inside a call, because Workers allow timers and randomness only there. `vitest` in the bundle is a module that hands the tests the Tester's own.
- **Running.** Each test file runs in a new Dynamic Worker, because an isolate runs a module only once, so a file's tests can't be collected twice in one. A file gets the app's limits, 10 seconds of CPU and 50 subrequests, and no network. The files run one after another, and each file's report comes back over RPC.
- **Places.** The bundle's source map takes each test, and each failure's stack, back to the Workspace's file and line.
- **When they run.** With the Agent's `test` tool, the Developer's Run tests, and once at the end of each Turn, after its last Check and Build. A Turn's failing tests don't ask the Agent to retry. The latest run of every test file is kept for the problems list.
- **Types.** Checks see the platform's `vitest` as `node_modules/vitest`, with the declarations of the parts it's made of, in place of any Package of that name.

## Consequences

- **A test can pass here and fail in real vitest, or the other way round.** The glue is small, but it isn't vitest's.
- **There's no DOM.** jsdom and happy-dom can't run in Workers, so component tests that click and type can't either. React components can be rendered to HTML with `react-dom/server`, and their logic tested as plain functions.
- **No module mocks, snapshots, coverage or durations.** Time stands still during CPU work, so a test's duration would read 0.
- **Every test file starts a Dynamic Worker,** which parses the Tester and the tests' bundle again.
- **esbuild's memory now grows in the Test bundler's isolate.** If it goes over the limit, that run fails as unable to bundle, and the next starts a new isolate.
- **The Test bundler is sent the Workspace's files and Packages in one call,** which can carry at most 32 MiB. The Packages' type declarations, source maps and Markdown stay behind. Workspaces whose Packages are larger than that can't run their tests.
- **One test file that won't bundle stops them all,** since the files share a bundle. The error names the file and line, a missing import's included.
- **A test that loops without yielding runs until the CPU limit stops its Dynamic Worker.** Its file is reported as not finishing, and the files after it still run.
- **The tests' app code isn't the Build's.** It's bundled without a front end, with React's automatic JSX runtime for any `.tsx` file, and gets no `vars`, secrets or Durable Object bindings unless a test passes them in.
- **vitest 5 deprecates the separate runner,** having moved it inside `vitest`. The parts stay at the platform's own vitest version and are upgraded with it (`docs/development.md`).
