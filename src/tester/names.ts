// Names the Tester's host, its Dynamic Worker and its runtime share. Kept
// apart so the platform's own code doesn't take in the runtime.

/** The names the host gives the tests' bundle and its source map, as modules beside the Tester. */
export const testsModule = "tests.js";
export const sourceMapModule = "tests.js.map";

/** The global where the tests' `vitest` module finds the runtime's exports. */
export const vitestGlobal = "jigworks.vitest";
