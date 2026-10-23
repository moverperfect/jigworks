import { useEffect, useRef, useState } from "react";
import type { BuildReport } from "../../src/shared/build-report.ts";
import type { CheckReport } from "../../src/shared/check-report.ts";
import { getLatestBuild, getLatestCheck, runBuild, runCheck, toApiError, type ApiError } from "./api";
import { createCheckScheduler, type CheckScheduler } from "./checkScheduler";

export interface Checks {
  /** The latest Check's report, or null until one has loaded or run. */
  report: CheckReport | null;
  /**
   * Whether no save finished after the report's Check started. If so, a file
   * with no unsaved changes has the text that Check saw.
   */
  reportIsCurrent: boolean;
  /**
   * How long this page waited for the report's Check, or null for a stored
   * report. The platform can't time a Check itself (see the check route).
   */
  reportTookMs: number | null;
  checking: boolean;
  /** Why the last Check failed. */
  error: ApiError | null;
  /** The latest Build's report, or null until one has loaded or run. */
  build: BuildReport | null;
  /** How long this page waited for the Build, or null for a stored report. */
  buildTookMs: number | null;
  building: boolean;
  /** Why the last Build didn't run. Errors in the code are in its report. */
  buildError: ApiError | null;
  /** Call after each save: a Check and then a Build run shortly after the last one. */
  checkSoon(): void;
  /** Runs a Check and then a Build. */
  checkNow(): void;
  /** Shows the stored reports, such as those from the Check and Build that end each Turn. */
  showLatest(): void;
}

interface Shown<T> {
  report: T;
  tookMs: number | null;
}

// Answers can arrive out of order, so keep the newest.
const newer = <T extends Shown<{ ranAt: string }>>(old: T | null, next: T): T =>
  old && Date.parse(old.report.ranAt) > Date.parse(next.report.ranAt) ? old : next;

/**
 * A Workspace's Checks, each followed by a Build. Shows the stored reports on
 * opening, then runs a Check and a Build in case the files changed since.
 */
export function useChecks(id: string): Checks {
  const [shown, setShown] = useState<(Shown<CheckReport> & { isCurrent: boolean }) | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [shownBuild, setShownBuild] = useState<Shown<BuildReport> | null>(null);
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<ApiError | null>(null);
  const scheduler = useRef<CheckScheduler | null>(null);
  const loadLatest = useRef<(() => Promise<void>) | null>(null);
  const saves = useRef(0);

  useEffect(() => {
    let current = true;
    const show = (report: CheckReport, savesBefore: number, tookMs: number | null) => {
      const isCurrent = savesBefore === saves.current;
      setShown((old) => newer(old, { report, isCurrent, tookMs }));
    };
    const showBuild = (report: BuildReport, tookMs: number | null) => setShownBuild((old) => newer(old, { report, tookMs }));

    /** Runs a Check or a Build, then shows its report, timed from here, or why it failed. */
    async function run<T>(
      request: (id: string) => Promise<T>,
      setRunning: (running: boolean) => void,
      setFailed: (error: ApiError | null) => void,
      done: (report: T, tookMs: number) => void,
    ) {
      setRunning(true);
      try {
        const started = performance.now();
        const report = await request(id);
        if (current) {
          done(report, performance.now() - started);
          setFailed(null);
        }
      } catch (caught) {
        if (current) setFailed(toApiError(caught));
      } finally {
        if (current) setRunning(false);
      }
    }

    // One scheduler for both, so each Build follows its Check and sees the same saves.
    const checks = createCheckScheduler(async () => {
      const savesBefore = saves.current;
      await run(runCheck, setChecking, setError, (report, tookMs) => show(report, savesBefore, tookMs));
      // A Build goes ahead whatever the Check found.
      if (current) await run(runBuild, setBuilding, setBuildError, showBuild);
    });
    scheduler.current = checks;

    const latest = async () => {
      const savesBefore = saves.current;
      const [report, build] = await Promise.all([getLatestCheck(id), getLatestBuild(id)]);
      if (!current) return;
      if (report) {
        show(report, savesBefore, null);
        setError(null);
      }
      if (build) {
        showBuild(build, null);
        setBuildError(null);
      }
    };
    loadLatest.current = latest;

    latest()
      // The Check and Build that follow show their own errors.
      .catch(() => {})
      .finally(() => {
        if (current) checks.checkNow();
      });

    return () => {
      current = false;
      checks.stop();
      scheduler.current = null;
      loadLatest.current = null;
    };
  }, [id]);

  return {
    report: shown?.report ?? null,
    reportIsCurrent: shown?.isCurrent ?? false,
    reportTookMs: shown?.tookMs ?? null,
    checking,
    error,
    build: shownBuild?.report ?? null,
    buildTookMs: shownBuild?.tookMs ?? null,
    building,
    buildError,
    checkSoon() {
      saves.current += 1;
      scheduler.current?.checkSoon();
    },
    checkNow: () => scheduler.current?.checkNow(),
    showLatest() {
      // If the stored reports can't be read, a Check and Build make new ones.
      loadLatest.current?.().catch(() => scheduler.current?.checkNow());
    },
  };
}
