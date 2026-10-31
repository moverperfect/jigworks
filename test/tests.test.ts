import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { countProblems, summariseTests, testProblems } from "../client/src/problems";
import { bundleTests, type TestBundle } from "../src/builder";
import type { TestFileReport, TestReport } from "../src/shared/test-report";
import { isTestFile, testInDynamicWorkers, vitestModule } from "../src/tester";
import { call, create } from "./helpers/api";

// Tests a Workspace's own tests: they run in Dynamic Workers on a runner
// built from vitest's parts (ADR 0017).

const workspace = (files: Record<string, string>) =>
  new Map(
    Object.entries({
      "package.json": JSON.stringify({ name: "app", private: true, type: "module" }),
      "wrangler.jsonc": '{ "name": "app", "main": "src/index.ts", "compatibility_date": "2026-10-01" }',
      "src/index.ts": "export const add = (a: number, b: number) => a + b;\n",
      ...files,
    }),
  );

/** Bundles and runs a Workspace's tests, and reports each file. */
async function run(files: Record<string, string>): Promise<TestFileReport[]> {
  const snapshot = workspace(files);
  const testFiles = [...snapshot.keys()].filter(isTestFile).sort();
  const bundle = await bundleTests(snapshot, testFiles, { vitest: vitestModule });
  if (!bundle.ok) throw new Error(`The tests didn't bundle: ${JSON.stringify(bundle.errors)}`);
  return testInDynamicWorkers(env.LOADER, bundle as TestBundle, testFiles);
}

const only = async (files: Record<string, string>) => (await run(files))[0]!;

describe("the Tester", () => {
  it("runs describe, it and expect, and says which tests passed and which failed, why, and where", async () => {
    const report = await only({
      "src/index.test.ts": [
        'import { describe, expect, it } from "vitest";',
        'import { add } from "./index";',
        "",
        'describe("add", () => {',
        '  it("adds", () => {',
        "    expect(add(1, 2)).toBe(3);",
        "  });",
        "",
        '  it("adds wrongly", () => {',
        "    expect(add(1, 2)).toEqual(4);",
        "  });",
        "});",
        "",
        'it.skip("is skipped", () => {});',
        'it.todo("is to do");',
        "",
      ].join("\n"),
    });
    expect(report.errors).toEqual([]);
    expect(report.tests).toEqual([
      { name: ["add", "adds"], state: "passed", line: 5, failure: null },
      {
        name: ["add", "adds wrongly"],
        state: "failed",
        line: 9,
        failure: {
          message: "AssertionError: expected 3 to deeply equal 4",
          diff: expect.stringContaining("- 4\n+ 3"),
          file: "src/index.test.ts",
          line: 10,
          column: expect.any(Number),
        },
      },
      { name: ["is skipped"], state: "skipped", line: 14, failure: null },
      { name: ["is to do"], state: "todo", line: 15, failure: null },
    ]);
  });

  it("has vi.fn, vi.spyOn, hooks and fake timers", async () => {
    const report = await only({
      "src/vi.test.ts": [
        'import { afterEach, beforeEach, expect, it, vi } from "vitest";',
        "",
        "const calls: string[] = [];",
        'beforeEach(() => calls.push("before"));',
        "afterEach(() => {",
        "  vi.useRealTimers();",
        "  vi.restoreAllMocks();",
        "});",
        "",
        'it("records calls", () => {',
        "  const greet = vi.fn((name: string) => `Hi ${name}`);",
        '  expect(greet("Ada")).toBe("Hi Ada");',
        '  expect(greet).toHaveBeenCalledWith("Ada");',
        '  expect(calls).toEqual(["before"]);',
        "});",
        "",
        'it("spies on a method", () => {',
        '  const notes = { list: () => ["real"] };',
        '  vi.spyOn(notes, "list").mockReturnValue(["fake"]);',
        '  expect(notes.list()).toEqual(["fake"]);',
        "  expect(notes.list).toHaveBeenCalledTimes(1);",
        "});",
        "",
        'it("moves time on", async () => {',
        "  vi.useFakeTimers();",
        '  vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));',
        "  const done = vi.fn();",
        "  setTimeout(done, 10_000);",
        "  vi.advanceTimersByTime(9_999);",
        "  expect(done).not.toHaveBeenCalled();",
        "  vi.advanceTimersByTime(1);",
        "  expect(done).toHaveBeenCalledOnce();",
        '  expect(new Date().toISOString()).toBe("2030-01-01T00:00:10.000Z");',
        "  let resolved = false;",
        "  new Promise((resolve) => setTimeout(resolve, 500)).then(() => (resolved = true));",
        "  await vi.runAllTimersAsync();",
        "  expect(resolved).toBe(true);",
        "});",
        "",
        'it("waits for real time with the timers back", async () => {',
        "  await new Promise((resolve) => setTimeout(resolve, 5));",
        "  expect(vi.isFakeTimers()).toBe(false);",
        "});",
        "",
      ].join("\n"),
    });
    expect(report.errors).toEqual([]);
    expect(report.tests.map(({ name, state, failure }) => [name[0], state, failure?.message])).toEqual([
      ["records calls", "passed", undefined],
      ["spies on a method", "passed", undefined],
      ["moves time on", "passed", undefined],
      ["waits for real time with the timers back", "passed", undefined],
    ]);
  });

  it("fails vi.mock and snapshots with a clear message that they aren't supported", async () => {
    const [mocked, snapshot] = await run({
      "src/a-mock.test.ts": [
        'import { expect, it, vi } from "vitest";',
        'vi.mock("./index", () => ({ add: () => 0 }));',
        'it("adds", () => expect(1).toBe(1));',
        "",
      ].join("\n"),
      "src/b-snapshot.test.ts": [
        'import { expect, it } from "vitest";',
        'it("matches", () => expect({ a: 1 }).toMatchSnapshot());',
        'it("matches inline", () => expect("text").toMatchInlineSnapshot());',
        "",
      ].join("\n"),
    });
    expect(mocked!.errors).toEqual([
      expect.objectContaining({
        message: expect.stringMatching(/^Replacing modules \(vi\.mock and its kin\) isn't supported here\. Pass a fake in/),
        file: "src/a-mock.test.ts",
        line: 2,
      }),
    ]);
    expect(snapshot!.tests.map(({ state, failure }) => [state, failure?.message, failure?.line])).toEqual([
      ["failed", expect.stringMatching(/^toMatchSnapshot: snapshots isn't supported here\. Compare with toEqual/), 2],
      ["failed", expect.stringMatching(/^toMatchInlineSnapshot: snapshots isn't supported here/), 3],
    ]);
  });

  it("runs each file in a fresh isolate, and keeps what the tests logged", async () => {
    const counter = [
      'import { expect, it } from "vitest";',
      'import { count } from "./counter";',
      'it("counts from one", () => {',
      '  console.log("counted", { to: count() });',
      "  expect(count()).toBe(2);",
      "});",
      "",
    ].join("\n");
    const reports = await run({
      "src/counter.ts": "let calls = 0;\nexport const count = () => ++calls;\n",
      "src/one.test.ts": counter,
      "src/two.test.ts": counter,
    });
    expect(reports.map(({ file, tests, console }) => [file, tests[0]!.state, console])).toEqual([
      ["src/one.test.ts", "passed", ["log: counted { to: 1 }"]],
      ["src/two.test.ts", "passed", ["log: counted { to: 1 }"]],
    ]);
  });

  // Local workerd doesn't enforce CPU limits, and runs every isolate on one
  // thread, so a test that never yields can't be tried here.
  it("reports a file that throws as it loads, and a test that never ends, without losing the others", async () => {
    const reports = await run({
      "src/a.test.ts": 'import { it } from "vitest";\nthrow new Error("broken at the top");\nit("never runs", () => {});\n',
      "src/b.test.ts": 'import { it } from "vitest";\nit("waits", () => new Promise(() => {}), 50);\n',
      "src/c.test.ts": 'import { expect, it } from "vitest";\nit("passes", () => expect(true).toBe(true));\n',
    });
    expect(reports[0]!.errors).toEqual([expect.objectContaining({ message: "broken at the top", file: "src/a.test.ts", line: 2 })]);
    expect(reports[1]!.tests).toEqual([
      expect.objectContaining({ state: "failed", failure: expect.objectContaining({ message: expect.stringContaining("Test timed out in 50ms") }) }),
    ]);
    expect(reports[2]!.tests).toEqual([expect.objectContaining({ state: "passed" })]);
  });

  it("can't reach the network", async () => {
    const report = await only({
      "src/fetch.test.ts": [
        'import { expect, it } from "vitest";',
        'it("fetches", async () => {',
        '  await expect(fetch("https://example.com/")).rejects.toThrow();',
        "});",
        "",
      ].join("\n"),
    });
    expect(report.tests[0]!.state).toBe("passed");
  });
});

describe("a Workspace's tests", () => {
  it("run from the API, where the latest run of them all is kept, starting with the Worker Template's", async () => {
    const workspace = await create("Tested");
    expect(await (await call(`/api/workspaces/${workspace.id}/tests`)).json()).toBeNull();
    const response = await call(`/api/workspaces/${workspace.id}/tests`, { method: "POST" });
    expect(response.status).toBe(200);
    const report = await response.json<TestReport>();
    expect(report).toMatchObject({
      bundleErrors: [],
      counts: { passed: 1, failed: 0, skipped: 0, todo: 0 },
      files: [{ file: "src/index.test.ts", tests: [{ name: ["the app", "greets by name"], state: "passed", line: 8 }], errors: [] }],
    });
    expect(await (await call(`/api/workspaces/${workspace.id}/tests`)).json()).toEqual(report);
  });

  it("report why they couldn't be bundled, and nothing when there are none", async () => {
    const workspace = await create("Untestable");
    const save = (path: string, text: string) => call(`/api/workspaces/${workspace.id}/files/${path}`, { method: "PUT", text });
    await save("src/index.test.ts", 'import { it } from "vitest";\nimport { gone } from "@fake/missing";\nit("x", () => gone());\n');
    const failed = await (await call(`/api/workspaces/${workspace.id}/tests`, { method: "POST" })).json<TestReport>();
    expect(failed.files).toEqual([]);
    expect(failed.bundleErrors).toEqual([expect.objectContaining({ message: expect.stringContaining("@fake/missing") })]);

    await runInDurableObject(env.WORKSPACES.getByName(workspace.id), (instance) => instance.workspace.rm("/src/index.test.ts"));
    const none = await (await call(`/api/workspaces/${workspace.id}/tests`, { method: "POST" })).json<TestReport>();
    expect(none).toMatchObject({ files: [], bundleErrors: [], counts: { passed: 0, failed: 0 } });
  });
});

describe("bundling the tests", () => {
  it("fails with the Build's errors when a test imports what isn't there", async () => {
    const snapshot = workspace({ "src/index.test.ts": 'import { it } from "vitest";\nimport { missing } from "./missing";\nit("x", () => missing());\n' });
    const result = await bundleTests(snapshot, ["src/index.test.ts"], { vitest: vitestModule });
    expect(result).toEqual({
      ok: false,
      errors: [{ file: null, line: null, column: null, message: 'The tests import "./missing", which isn\'t in the Workspace or its Packages' }],
    });
  });

  it("finds test files as vitest does", () => {
    const paths = ["src/a.test.ts", "src/b.spec.tsx", "test/c.test.mjs", "src/d.ts", "src/test.ts", "node_modules/x/e.test.js"];
    expect(paths.filter(isTestFile)).toEqual(["src/a.test.ts", "src/b.spec.tsx", "test/c.test.mjs"]);
  });
});

describe("the problems list's tests", () => {
  const failure = { message: "AssertionError: expected 2 to be 3", diff: "- 3\n+ 2", file: "src/sum.ts", line: 4, column: 3 };
  const report: TestReport = {
    ranAt: "2026-10-31T12:00:00.000Z",
    bundleErrors: [],
    counts: { passed: 1, failed: 2, skipped: 1, todo: 0 },
    files: [
      {
        file: "src/sum.test.ts",
        tests: [
          { name: ["sum", "adds"], state: "failed", line: 5, failure },
          { name: ["sum", "adds again"], state: "failed", line: 9, failure: { ...failure, diff: null, file: null, line: null, column: null } },
          { name: ["passes"], state: "passed", line: 12, failure: null },
          { name: ["skips"], state: "skipped", line: 13, failure: null },
        ],
        errors: [{ message: "Unhandled rejection: boom", diff: null, file: null, line: null, column: null }],
        console: [],
      },
    ],
  };

  it("lists each failure where it happened, or else where its test or file is, and counts them as errors", () => {
    expect(testProblems(report)).toEqual([
      { message: "Unhandled rejection: boom", diff: null, file: "src/sum.test.ts", line: null, column: null },
      { message: "sum › adds: AssertionError: expected 2 to be 3", diff: "- 3\n+ 2", file: "src/sum.ts", line: 4, column: 3 },
      { message: "sum › adds again: AssertionError: expected 2 to be 3", diff: null, file: "src/sum.test.ts", line: 9, column: null },
    ]);
    expect(countProblems(null, null, report).error).toBe(3);
    expect(summariseTests(report)).toBe("1 passed, 2 failed, 1 skipped");
    expect(summariseTests({ ...report, files: [] })).toBe("No tests");
  });
});
