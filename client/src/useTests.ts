import { useEffect, useRef, useState } from "react";
import type { TestReport } from "../../src/shared/test-report.ts";
import { getLatestTests, runTests, toApiError, type ApiError } from "./api";

export interface Tests {
  /** The latest run of every test file, or null until one has loaded or run. */
  report: TestReport | null;
  running: boolean;
  /** Why the last run, or the last load of the stored report, failed. Failing tests are in the report. */
  error: ApiError | null;
  /** Runs every test file. */
  run(): void;
  /** Shows the stored report, such as the one from the tests that end each Turn. */
  showLatest(): void;
}

/** A Workspace's tests. Unlike Checks, they run only when asked, and at the end of each Turn. */
export function useTests(id: string): Tests {
  const [report, setReport] = useState<TestReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const actions = useRef<Pick<Tests, "run" | "showLatest"> | null>(null);

  useEffect(() => {
    let current = true;
    const load = async (request: (id: string) => Promise<TestReport | null>) => {
      try {
        const next = await request(id);
        if (!current) return;
        // Answers can arrive out of order, so keep the newest.
        if (next) setReport((old) => (old && Date.parse(old.ranAt) > Date.parse(next.ranAt) ? old : next));
        setError(null);
      } catch (caught) {
        if (current) setError(toApiError(caught));
      }
    };
    actions.current = {
      run() {
        setRunning(true);
        void load(runTests).finally(() => current && setRunning(false));
      },
      showLatest: () => void load(getLatestTests),
    };
    setReport(null);
    void load(getLatestTests);
    return () => {
      current = false;
      actions.current = null;
    };
  }, [id]);

  return {
    report,
    running,
    error,
    run: () => actions.current?.run(),
    showLatest: () => actions.current?.showLatest(),
  };
}
