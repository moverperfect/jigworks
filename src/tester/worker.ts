// The Tester as the main module of a Dynamic Worker (ADR 0017). The host
// loads it with the tests' bundle as `tests.js`, and the bundle's source map
// as `tests.js.map`, and calls `run` once per test file, each time in a new
// isolate: an isolate runs a module only once, and a test file's `describe`
// and `it` calls must run for each run.
import { WorkerEntrypoint } from "cloudflare:workers";
import type { TestFileReport } from "../shared/test-report";
import { sourceMapModule, testsModule } from "./names";

// Imports a module by a name held in a variable, which the packing leaves for
// the Worker Loader to find rather than looking for it itself.
const importModule = (name: string): Promise<unknown> => import(name);

export class Tester extends WorkerEntrypoint {
  async run(path: string): Promise<TestFileReport> {
    // Each loads inside the call: the runtime's fake timers try a timer as
    // they load, and the tests may too, which Workers allow only in a request.
    const [{ runFile }, { files }, { default: sourceMap }] = await Promise.all([
      import("./runtime"),
      importModule(`./${testsModule}`) as Promise<{ files: Record<string, () => Promise<unknown>> }>,
      importModule(`./${sourceMapModule}`) as Promise<{ default: string }>,
    ]);
    return runFile(path, Object.hasOwn(files, path) ? files[path] : undefined, sourceMap);
  }
}

export default {
  fetch: () => new Response("Not used", { status: 404 }),
};
