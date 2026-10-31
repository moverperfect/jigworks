// The types of the `vitest` a Workspace's tests import, which the platform
// provides (ADR 0017): vitest's own parts, as runtime.ts puts them together.
// Checks see this as node_modules/vitest/index.d.ts, beside the parts' own
// declarations (see scripts/pack-tester.mjs).
import type { Assertion, ExpectStatic, Tester } from "@vitest/expect";
import type { fn, isMockFunction, MaybeMocked, spyOn } from "@vitest/spy";

export {
  afterAll,
  afterEach,
  aroundAll,
  aroundEach,
  beforeAll,
  beforeEach,
  describe,
  it,
  onTestFailed,
  onTestFinished,
  suite,
  test,
} from "@vitest/runner";
export type { SuiteAPI, TestAPI, TestContext, TestFunction, TestOptions } from "@vitest/runner";
export type { Assertion, AsymmetricMatchersContaining, ExpectStatic } from "@vitest/expect";
export type { Mock, MockContext, Mocked, MockedClass, MockedFunction, MockedObject, MockInstance } from "@vitest/spy";

export interface Expect extends ExpectStatic {
  /** Fails the test unless it makes exactly this many assertions. */
  assertions(expected: number): void;
  /** Fails the test unless it makes at least one assertion. */
  hasAssertions(): void;
  /** Fails, saying the line should never have been reached. */
  unreachable(message?: string): never;
  /** Records a failure without stopping the test. */
  soft<T>(actual: T, message?: string): Assertion<T>;
  assert: Chai.AssertStatic;
  addEqualityTesters(testers: Tester[]): void;
}

export declare const expect: Expect;
export declare const assert: Chai.AssertStatic;

/** Options for `vi.useFakeTimers`. */
export interface FakeTimerOptions {
  now?: number | Date;
  toFake?: string[];
  loopLimit?: number;
  shouldAdvanceTime?: boolean;
  advanceTimeDelta?: number;
  shouldClearNativeTimers?: boolean;
}

export interface VitestUtils {
  fn: typeof fn;
  spyOn: typeof spyOn;
  isMockFunction: typeof isMockFunction;
  /** Types a value as mocked, without changing it. */
  mocked<T>(item: T): MaybeMocked<T>;
  clearAllMocks(): VitestUtils;
  resetAllMocks(): VitestUtils;
  restoreAllMocks(): VitestUtils;

  /** Fakes every timer and Date, until `useRealTimers`. */
  useFakeTimers(options?: FakeTimerOptions): VitestUtils;
  useRealTimers(): VitestUtils;
  isFakeTimers(): boolean;
  advanceTimersByTime(ms: number): VitestUtils;
  advanceTimersByTimeAsync(ms: number): Promise<VitestUtils>;
  advanceTimersToNextTimer(steps?: number): VitestUtils;
  advanceTimersToNextTimerAsync(steps?: number): Promise<VitestUtils>;
  runAllTimers(): VitestUtils;
  runAllTimersAsync(): Promise<VitestUtils>;
  runOnlyPendingTimers(): VitestUtils;
  runOnlyPendingTimersAsync(): Promise<VitestUtils>;
  runAllTicks(): VitestUtils;
  clearAllTimers(): VitestUtils;
  getTimerCount(): number;
  /** Sets the fake clock, or fakes only Date if the timers are real. */
  setSystemTime(time?: number | string | Date): VitestUtils;
  getMockedSystemTime(): Date | null;
  getRealSystemTime(): number;

  stubGlobal(name: string | symbol | number, value: unknown): VitestUtils;
  unstubAllGlobals(): VitestUtils;

  /** Not supported here, and throws: tests can't replace the modules they import. Pass a fake in, or use `vi.spyOn`. */
  mock(path: string, factory?: unknown): void;
  /** Not supported here, and throws. */
  doMock(path: string, factory?: unknown): void;
  /** Not supported here, and throws. */
  unmock(path: string): void;
  /** Not supported here, and throws. */
  doUnmock(path: string): void;
  /** Not supported here, and throws. */
  hoisted<T>(factory: () => T): T;
  /** Not supported here, and throws. */
  importActual<T = unknown>(path: string): Promise<T>;
  /** Not supported here, and throws. */
  importMock<T = unknown>(path: string): Promise<T>;
  /** Not supported here, and throws. */
  resetModules(): VitestUtils;
}

export declare const vi: VitestUtils;
export declare const vitest: VitestUtils;

declare module "@vitest/expect" {
  interface Assertion<T = any> {
    /** Not supported here, and throws: there's nowhere to keep snapshots. Compare with `toEqual` instead. */
    toMatchSnapshot(...args: unknown[]): void;
    /** Not supported here, and throws. Compare with `toEqual` instead. */
    toMatchInlineSnapshot(...args: unknown[]): void;
    /** Not supported here, and throws. Compare with `toEqual` instead. */
    toMatchFileSnapshot(...args: unknown[]): Promise<void>;
    /** Not supported here, and throws. Use `toThrow` instead. */
    toThrowErrorMatchingSnapshot(...args: unknown[]): void;
    /** Not supported here, and throws. Use `toThrow` instead. */
    toThrowErrorMatchingInlineSnapshot(...args: unknown[]): void;
  }
}

declare module "@vitest/runner" {
  interface TestContext {
    /** An `expect` for this test alone, for tests that run at the same time. */
    expect: Expect;
  }
}
