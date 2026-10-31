// The `vitest` a Workspace's tests import, built from vitest's own parts
// (ADR 0017): its runner, `expect` and spies, with fake timers from the
// library vitest builds its own on. The Tester loads this module inside a call,
// because fake timers try a timer when they load, which Workers allow only
// inside a request.
import { withGlobal, type Clock, type Config } from "@sinonjs/fake-timers";
import {
  ASYMMETRIC_MATCHERS_OBJECT,
  ChaiStyleAssertions,
  GLOBAL_EXPECT,
  JestAsymmetricMatchers,
  JestChaiExpect,
  JestExtend,
  addCustomEqualityTesters,
  chai,
  customMatchers,
  getState,
  setState,
  type ExpectStatic,
  type MatcherState,
} from "@vitest/expect";
import {
  afterAll,
  afterEach,
  aroundAll,
  aroundEach,
  beforeAll,
  beforeEach,
  describe,
  getCurrentTest,
  it,
  onTestFailed,
  onTestFinished,
  startTests,
  suite,
  test,
  type File,
  type Task,
  type Test,
  type VitestRunner,
} from "@vitest/runner";
import { clearAllMocks, fn, isMockFunction, resetAllMocks, restoreAllMocks, spyOn } from "@vitest/spy";
import { format } from "@vitest/utils/display";
import { DecodedMap, getOriginalPosition, parseSingleStack } from "@vitest/utils/source-map";
import { setSafeTimers } from "@vitest/utils/timers";
import type { TestCase, TestFailure, TestFileReport } from "../shared/test-report";
import { testsModule, vitestGlobal } from "./names";

const notSupported = (what: string, instead: string) => () => {
  throw new Error(`${what} isn't supported here. ${instead}`);
};
const noModuleMocks = notSupported(
  "Replacing modules (vi.mock and its kin)",
  "Pass a fake in to the code under test, or use vi.spyOn on an object it calls.",
);
const noSnapshots = (name: string) =>
  notSupported(name, "There's nowhere to keep snapshots. Compare with toEqual, toContain or toMatch instead.");

chai.use(JestExtend);
chai.use(JestChaiExpect);
chai.use(ChaiStyleAssertions);
chai.use(JestAsymmetricMatchers);
chai.use((chai, utils) => {
  for (const name of [
    "toMatchSnapshot",
    "toMatchInlineSnapshot",
    "toMatchFileSnapshot",
    "toThrowErrorMatchingSnapshot",
    "toThrowErrorMatchingInlineSnapshot",
  ]) {
    utils.addMethod(chai.Assertion.prototype, name, noSnapshots(name));
  }
});

/** A test's name, after those of the describe blocks it's in. The file, which holds them all, isn't one. */
function fullName(task: Task): string[] {
  const path: string[] = [];
  for (let current: Task | undefined = task; current && !("filepath" in current); current = current.suite) path.unshift(current.name);
  return path;
}

const testName = (test: Test) => fullName(test).join(" > ");

const freshState = () => ({
  assertionCalls: 0,
  isExpectingAssertions: false,
  isExpectingAssertionsError: null,
  expectedAssertionsNumber: null,
  expectedAssertionsNumberErrorGen: null,
});

type Expect = ExpectStatic & {
  assertions(expected: number): void;
  hasAssertions(): void;
  unreachable(message?: string): never;
  soft<T>(actual: T, message?: string): ReturnType<ExpectStatic>;
};

/** An `expect`, as vitest makes one: counting assertions, for one test or whichever is running. */
function createExpect(test?: Test): Expect {
  const expect = ((value: unknown, message?: string) => {
    const { assertionCalls } = getState(expect);
    setState({ assertionCalls: assertionCalls + 1 }, expect);
    const assertion = chai.expect(value, message);
    const current = test ?? getCurrentTest();
    return current ? (assertion as unknown as { withTest(test: Test): unknown }).withTest(current) : assertion;
  }) as unknown as Expect;
  Object.assign(expect, chai.expect);
  Object.assign(expect, (globalThis as Record<symbol, unknown>)[ASYMMETRIC_MATCHERS_OBJECT]);
  expect.getState = () => getState(expect);
  expect.setState = (state) => setState(state, expect);
  setState<MatcherState>({ ...freshState(), currentTestName: test ? testName(test) : "" } as MatcherState, expect);
  (expect as unknown as Record<string, unknown>).assert = chai.assert;
  expect.extend = (matchers) => (chai.expect as unknown as { extend(expect: Expect, matchers: object): void }).extend(expect, matchers);
  (expect as unknown as Record<string, unknown>).addEqualityTesters = addCustomEqualityTesters;
  expect.soft = (actual, message) => (expect(actual, message) as unknown as { withContext(context: object): never }).withContext({ soft: true });
  expect.unreachable = (message) => chai.assert.fail(`expected${message ? ` "${message}" ` : " "}not to be reached`);
  (expect as unknown as Record<string, unknown>).addSnapshotSerializer = noSnapshots("expect.addSnapshotSerializer");
  chai.util.addMethod(expect, "assertions", (expected: number) => {
    expect.setState({
      expectedAssertionsNumber: expected,
      expectedAssertionsNumberErrorGen: () =>
        new Error(`expected number of assertions to be ${expected}, but got ${expect.getState().assertionCalls}`),
    });
  });
  chai.util.addMethod(expect, "hasAssertions", () => {
    expect.setState({ isExpectingAssertions: true, isExpectingAssertionsError: new Error("expected any number of assertion, but got none") });
  });
  expect.extend(customMatchers);
  return expect;
}

const expect = createExpect();
Object.defineProperty(globalThis, GLOBAL_EXPECT, { value: expect, writable: true, configurable: true });

/** Fake timers, as vitest's: they fake every timer but microtasks, until `useRealTimers`. */
class FakeTimers {
  readonly #timers = withGlobal(globalThis);
  #clock: Clock | null = null;
  // Only Date is faked, by setSystemTime before any useFakeTimers.
  #onlyDate = false;

  get faking(): boolean {
    return this.#clock !== null && !this.#onlyDate;
  }

  use(config: Config = {}): void {
    const now = this.#clock?.now ?? Date.now();
    this.restore();
    const toFake = Object.keys(this.#timers.timers).filter((name) => name !== "nextTick" && name !== "queueMicrotask");
    this.#clock = this.#timers.install({ now, toFake: toFake as Config["toFake"], ignoreMissingTimers: true, ...config });
  }

  restore(): void {
    this.#clock?.uninstall();
    this.#clock = null;
    this.#onlyDate = false;
  }

  clock(): Clock {
    if (!this.faking) throw new Error("The timers aren't fake. Call vi.useFakeTimers() first.");
    return this.#clock!;
  }

  setSystemTime(time: number | string | Date = Date.now()): void {
    const date = time instanceof Date ? time : new Date(time);
    if (!this.#clock) {
      this.#clock = this.#timers.install({ now: date, toFake: ["Date"] });
      this.#onlyDate = true;
    } else {
      this.#clock.setSystemTime(date);
    }
  }

  mockedTime(): Date | null {
    return this.#clock ? new Date(this.#clock.now) : null;
  }
}

const timers = new FakeTimers();
const realNow = Date.now;
const stubbedGlobals = new Map<PropertyKey, PropertyDescriptor | undefined>();

// `vi`'s methods that change something return `vi`, so calls chain.
const chain =
  <A extends unknown[]>(change: (...args: A) => unknown) =>
  (...args: A): object => {
    change(...args);
    return vi;
  };
const chainAsync =
  <A extends unknown[]>(change: (...args: A) => Promise<unknown>) =>
  async (...args: A): Promise<object> => {
    await change(...args);
    return vi;
  };

export const vi = {
  fn,
  spyOn,
  isMockFunction,
  mocked: <T>(item: T): T => item,
  clearAllMocks: chain(clearAllMocks),
  resetAllMocks: chain(resetAllMocks),
  restoreAllMocks: chain(restoreAllMocks),
  useFakeTimers: chain((config?: Config) => timers.use(config)),
  useRealTimers: chain(() => timers.restore()),
  isFakeTimers: () => timers.faking,
  advanceTimersByTime: chain((ms: number) => timers.clock().tick(ms)),
  advanceTimersByTimeAsync: chainAsync((ms: number) => timers.clock().tickAsync(ms)),
  advanceTimersToNextTimer: chain((steps: number = 1) => {
    const clock = timers.clock();
    for (let step = 0; step < steps && clock.countTimers() > 0; step++) {
      clock.next();
      clock.tick(0);
    }
  }),
  advanceTimersToNextTimerAsync: chainAsync(async (steps: number = 1) => {
    const clock = timers.clock();
    for (let step = 0; step < steps && clock.countTimers() > 0; step++) {
      await clock.nextAsync();
      clock.tick(0);
    }
  }),
  runAllTimers: chain(() => timers.clock().runAll()),
  runAllTimersAsync: chainAsync(() => timers.clock().runAllAsync()),
  runOnlyPendingTimers: chain(() => timers.clock().runToLast()),
  runOnlyPendingTimersAsync: chainAsync(() => timers.clock().runToLastAsync()),
  runAllTicks: chain(() => timers.clock().runMicrotasks()),
  clearAllTimers: chain(() => timers.faking && timers.clock().reset()),
  getTimerCount: () => (timers.faking ? timers.clock().countTimers() : 0),
  setSystemTime: chain((time?: number | string | Date) => timers.setSystemTime(time)),
  getMockedSystemTime: () => timers.mockedTime(),
  getRealSystemTime: () => realNow(),
  stubGlobal: chain((name: PropertyKey, value: unknown) => {
    if (!stubbedGlobals.has(name)) stubbedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true, enumerable: true });
  }),
  unstubAllGlobals: chain(() => {
    for (const [name, original] of stubbedGlobals) {
      if (original) Object.defineProperty(globalThis, name, original);
      else Reflect.deleteProperty(globalThis, name);
    }
    stubbedGlobals.clear();
  }),
  mock: noModuleMocks,
  doMock: noModuleMocks,
  unmock: noModuleMocks,
  doUnmock: noModuleMocks,
  hoisted: noModuleMocks,
  importActual: noModuleMocks,
  importMock: noModuleMocks,
  resetModules: noModuleMocks,
};

/** What the tests' `vitest` module exports. */
const vitest = {
  describe,
  suite,
  it,
  test,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  aroundAll,
  aroundEach,
  onTestFailed,
  onTestFinished,
  expect,
  assert: chai.assert,
  vi,
};

// How much of what the tests logged is kept for each file, and of each failure.
const consoleLines = 100;
const consoleLineLength = 500;
const messageLength = 2000;
const diffLength = 4000;

/**
 * Runs one test file, which `load` imports, and reports each test. Stack
 * frames in the tests' bundle are mapped back to the Workspace's files with
 * its source map.
 */
export async function runFile(path: string, load: (() => Promise<unknown>) | undefined, sourceMap: string): Promise<TestFileReport> {
  setSafeTimers();
  (globalThis as Record<symbol, unknown>)[Symbol.for(vitestGlobal)] = vitest;
  // The bundle's name as parsed stack frames give it, which resolves it to a path.
  const bundlePath = parseSingleStack(`    at ${testsModule}:1:1`)!.file;
  const locate = locator(bundlePath, sourceMap);
  const output = captureConsole();
  const unhandled: unknown[] = [];
  const onRejection = (event: PromiseRejectionEvent) => unhandled.push(event.reason);
  addEventListener("unhandledrejection", onRejection);

  const runner: VitestRunner = {
    config: {
      root: "/",
      setupFiles: [],
      name: undefined,
      passWithNoTests: true,
      testNamePattern: undefined,
      allowOnly: true,
      sequence: { seed: 0, hooks: "stack", setupFiles: "list" },
      chaiConfig: undefined,
      maxConcurrency: 5,
      testTimeout: 5000,
      hookTimeout: 10000,
      retry: 0,
      includeTaskLocation: true,
      tags: [],
      tagsFilter: undefined,
      strictTags: false,
    },
    async importFile() {
      if (!load) throw new Error(`${path} isn't one of the Workspace's test files.`);
      await load();
    },
    onBeforeTryTask(test) {
      const state = { ...freshState(), currentTestName: testName(test) };
      setState(state, expect);
      // The test's own `expect` lasts as long as its context, across retries and repeats.
      const context = test.context as typeof test.context & { _local?: boolean };
      if (context._local) (context.expect as Expect).setState(state);
    },
    onAfterTryTask(test) {
      const context = test.context as typeof test.context & { _local?: boolean };
      const state = context._local ? (context.expect as Expect).getState() : getState(expect);
      if (state.expectedAssertionsNumber !== null && state.assertionCalls !== state.expectedAssertionsNumber) {
        throw state.expectedAssertionsNumberErrorGen!();
      }
      if (state.isExpectingAssertions && state.assertionCalls === 0) throw state.isExpectingAssertionsError;
    },
    extendTaskContext(context) {
      let local: Expect | undefined;
      Object.defineProperty(context, "expect", { get: () => (local ??= createExpect(context.task)) });
      Object.defineProperty(context, "_local", { get: () => local !== undefined });
      return context;
    },
  };

  try {
    // The runner names the file as stack frames name the bundle, so it finds where each test is declared.
    const [file] = await startTests([{ filepath: bundlePath }], runner);
    return report(path, file!, locate, output.lines, unhandled);
  } finally {
    output.restore();
    removeEventListener("unhandledrejection", onRejection);
    timers.restore();
  }
}

type Place = { file: string; line: number; column: number };
type Locate = { fromStack(stack: string | undefined): Place | null; fromBundle(line: number, column: number): Place | null };

function report(path: string, file: File, locate: Locate, console: string[], unhandled: unknown[]): TestFileReport {
  const tests: TestCase[] = [];
  const errors: TestFailure[] = [];
  const failureOf = (error: { message?: string; name?: string; stack?: string; diff?: string }): TestFailure => {
    const place = locate.fromStack(error.stack);
    return {
      message: cut(plain(error.name && error.name !== "Error" ? `${error.name}: ${error.message}` : String(error.message)), messageLength),
      diff: error.diff ? cut(plain(error.diff), diffLength) : null,
      file: place?.file ?? null,
      line: place?.line ?? null,
      column: place?.column ?? null,
    };
  };
  const visit = (task: Task) => {
    if (task.type === "test") {
      const state = task.result?.state;
      const declared = task.location ? locate.fromBundle(task.location.line, task.location.column) : null;
      tests.push({
        name: fullName(task),
        state: task.mode === "todo" ? "todo" : state === "pass" ? "passed" : state === "fail" ? "failed" : "skipped",
        line: declared?.file === path ? declared.line : null,
        failure: task.result?.errors?.[0] ? failureOf(task.result.errors[0]) : null,
      });
      return;
    }
    // The file's or a describe block's own errors: it threw as it loaded, or a beforeAll or afterAll threw.
    for (const error of task.result?.errors ?? []) errors.push(failureOf(error));
    for (const child of task.tasks) visit(child);
  };
  visit(file);
  for (const reason of unhandled) {
    const failure = failureOf(reason instanceof Error ? reason : new Error(String(reason)));
    errors.push({ ...failure, message: `Unhandled rejection: ${failure.message}` });
  }
  return { file: path, tests, errors, console };
}

/**
 * Finds where in the Workspace's files a place in the bundle came from, and
 * where an error happened: the first frame of its stack in the bundle that
 * maps back to a Workspace file outside `node_modules`.
 */
function locator(bundlePath: string, sourceMap: string): Locate {
  let map: DecodedMap | null = null;
  const fromBundle = (line: number, column: number): Place | null => {
    map ??= new DecodedMap(JSON.parse(sourceMap), "/");
    // Stack frames count columns from 1, and source maps from 0.
    const original = getOriginalPosition(map, { line, column: column - 1 });
    const file = original?.source?.replace(/^.*virtual:\/?/, "");
    if (!original || !file || file.startsWith("node_modules/") || original.line === null) return null;
    return { file, line: original.line, column: original.column + 1 };
  };
  return {
    fromBundle,
    fromStack(stack) {
      for (const line of stack?.split("\n") ?? []) {
        const frame = parseSingleStack(line);
        const place = frame && frame.file === bundlePath ? fromBundle(frame.line, frame.column) : null;
        if (place) return place;
      }
      return null;
    },
  };
}

const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");
const cut = (text: string, length: number) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);

/** Keeps what the tests write to the console, as well as writing it. */
function captureConsole(): { lines: string[]; restore(): void } {
  const lines: string[] = [];
  const levels = ["log", "info", "warn", "error", "debug"] as const;
  const originals = levels.map((level) => console[level]);
  for (const level of levels) {
    const original = console[level];
    console[level] = (...args: unknown[]) => {
      if (lines.length < consoleLines) lines.push(cut(plain(`${level}: ${format(...args)}`), consoleLineLength));
      original.apply(console, args);
    };
  }
  return {
    lines,
    restore: () => levels.forEach((level, index) => (console[level] = originals[index]!)),
  };
}
