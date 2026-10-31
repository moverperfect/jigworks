import { useId, type ReactNode } from "react";
import type { BuildReport } from "../../src/shared/build-report.ts";
import type { CheckReport, Severity } from "../../src/shared/check-report.ts";
import type { TestReport } from "../../src/shared/test-report.ts";
import { ErrorMessage } from "./ErrorMessage";
import {
  buildProblems,
  countProblems,
  groupProblems,
  problemLocation,
  problemPath,
  problemTotal,
  summarise,
  summariseTests,
  testProblems,
  type PlacedProblem,
} from "./problems";
import type { Checks } from "./useChecks";
import type { Tests } from "./useTests";

const severityLabel: Record<Severity, string> = {
  error: "Error",
  warning: "Warning",
  suggestion: "Suggestion",
  message: "Message",
};

const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: "medium" });
const dateTimeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** A time, with its date unless it was today. */
export function formatTime(iso: string): string {
  const date = new Date(iso);
  return date.toDateString() === new Date().toDateString() ? timeFormat.format(date) : dateTimeFormat.format(date);
}

const formatDuration = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

/** Opens a file at a line and column, both from 1. */
type OpenAt = (path: string, line: number | null, column: number | null) => void;

/** The problems list: the Package warnings, the Build's errors and warnings, the tests' failures, then the latest Check's problems by file. */
export function ProblemsPanel({
  checks,
  tests,
  expanded,
  onToggle,
  canOpen,
  onOpen,
}: {
  checks: Checks;
  tests: Tests;
  expanded: boolean;
  onToggle(): void;
  /** Whether a file can be opened from the list: Package files and TypeScript's own files can't. */
  canOpen(path: string): boolean;
  onOpen: OpenAt;
}) {
  const id = useId();
  const { report, reportTookMs, checking, error, build, buildTookMs, building, buildError } = checks;

  // A Check always runs when the page opens, so with no report and no error one is on its way.
  let status: ReactNode = "Checking…";
  if (!checking && error) status = "The Check didn't run";
  else if (!checking && report) {
    status = (
      <>
        Checked at <time dateTime={report.ranAt}>{formatTime(report.ranAt)}</time>
        {reportTookMs !== null && ` in ${formatDuration(reportTookMs)}`}
      </>
    );
  }
  // A Build follows each Check, so while one runs the last Build is about to be replaced.
  let buildStatus: string | null = null;
  if (building) buildStatus = "Building…";
  else if (!checking && buildError) buildStatus = "The Build didn't run";
  else if (!checking && build) {
    buildStatus = build.ok ? `Built${buildTookMs === null ? "" : ` in ${formatDuration(buildTookMs)}`}` : "Build failed";
  }
  // Tests run only when asked, and at the end of each Turn, so their time matters.
  let testStatus: ReactNode = null;
  if (tests.running) testStatus = "Testing…";
  else if (tests.error) testStatus = "The tests didn't run";
  else if (tests.report) {
    testStatus = (
      <>
        Tested at <time dateTime={tests.report.ranAt}>{formatTime(tests.report.ranAt)}</time>: {summariseTests(tests.report)}
      </>
    );
  }

  return (
    <section className="workspace-problems" aria-labelledby={`${id}-heading`}>
      <div className="problems-header">
        <h2 id={`${id}-heading`} className="problems-heading">
          <button
            type="button"
            className="problems-toggle"
            aria-expanded={expanded}
            aria-controls={`${id}-body`}
            onClick={onToggle}
          >
            <span className="chevron" aria-hidden="true">
              {expanded ? "▾" : "▸"}
            </span>
            Problems{" "}
            {(report || build || tests.report) && (
              <span className="problems-summary">{summarise(countProblems(report, build, tests.report))}</span>
            )}
          </button>
        </h2>
        <p className="problems-status" role="status">
          {status}
          {buildStatus && ` · ${buildStatus}`}
          {testStatus && <> · {testStatus}</>}
        </p>
        <button type="button" className="link-button" onClick={tests.run} disabled={tests.running}>
          Run tests
        </button>
      </div>
      <div id={`${id}-body`} className="problems-body" hidden={!expanded}>
        {error && <ErrorMessage error={error} retry={checks.checkNow} />}
        {buildError && !error && <ErrorMessage error={buildError} retry={checks.checkNow} />}
        {tests.error && <ErrorMessage error={tests.error} retry={tests.run} />}
        {(report || build || tests.report) && (
          <ReportProblems report={report} build={build} tests={tests.report} canOpen={canOpen} onOpen={onOpen} />
        )}
      </div>
    </section>
  );
}

function ReportProblems({
  report,
  build,
  tests,
  canOpen,
  onOpen,
}: {
  report: CheckReport | null;
  build: BuildReport | null;
  tests: TestReport | null;
  canOpen(path: string): boolean;
  onOpen: OpenAt;
}) {
  const packages = report?.packages;
  const packageProblems: { severity: Severity; message: string }[] = [
    ...(packages?.state === "failed"
      ? [{ severity: "error" as const, message: `The Packages couldn't be installed: ${packages.error ?? "no reason was given."}` }]
      : []),
    ...(packages?.warnings ?? []).map((message) => ({ severity: "warning" as const, message })),
  ];
  const buildList = build ? buildProblems(build) : [];
  const testList = tests ? testProblems(tests) : [];
  const groups = report ? groupProblems(report.problems) : [];
  const total = report ? problemTotal(report) : 0;

  if (packageProblems.length === 0 && buildList.length === 0 && testList.length === 0 && groups.length === 0 && total === 0) {
    return <p className="problems-empty">No problems.</p>;
  }

  return (
    <>
      {report && total > report.problems.length && (
        <p className="problems-empty">
          Showing the first {report.problems.length} of {total} problems.
        </p>
      )}
      {packageProblems.length > 0 && (
        <ProblemGroup heading="Packages" count={packageProblems.length}>
          {packageProblems.map((problem, index) => (
            <ProblemItem key={index} severity={problem.severity} message={problem.message} />
          ))}
        </ProblemGroup>
      )}
      <PlacedGroup heading="Build" problems={buildList} canOpen={canOpen} onOpen={onOpen} />
      <PlacedGroup heading="Tests" problems={testList} canOpen={canOpen} onOpen={onOpen} />
      {groups.map((group) => (
        <ProblemGroup key={group.path} heading={group.path} count={group.problems.length}>
          {group.problems.map((problem, index) => (
            <ProblemItem
              key={index}
              severity={problem.severity}
              location={problemLocation(problem)}
              message={problem.message}
              // Code 0 is a crash of the Checker itself, not a TypeScript error.
              code={problem.code === 0 ? undefined : `TS${problem.code}`}
              open={
                canOpen(problemPath(problem)) ? () => onOpen(problemPath(problem), problem.line, problem.column) : undefined
              }
            />
          ))}
        </ProblemGroup>
      ))}
    </>
  );
}

/** The Build's or the tests' problems, if there are any, each opening its file at its place. */
function PlacedGroup({
  heading,
  problems,
  canOpen,
  onOpen,
}: {
  heading: string;
  problems: PlacedProblem[];
  canOpen(path: string): boolean;
  onOpen: OpenAt;
}) {
  if (problems.length === 0) return null;
  return (
    <ProblemGroup heading={heading} count={problems.length}>
      {problems.map((problem, index) => {
        const { file, line, column } = problem;
        return (
          <ProblemItem
            key={index}
            severity={problem.severity}
            location={file === null ? undefined : [file, line, column].filter((part) => part !== null).join(":")}
            message={problem.message}
            detail={problem.diff ?? undefined}
            open={file !== null && canOpen(file) ? () => onOpen(file, line, column) : undefined}
          />
        );
      })}
    </ProblemGroup>
  );
}

/** One problem, which opens its file at the problem when `open` is given. `detail` is preformatted, such as a test's diff. */
function ProblemItem({
  severity,
  location,
  message,
  code,
  detail,
  open,
}: {
  severity: Severity;
  location?: string;
  message: string;
  code?: string;
  detail?: string;
  open?: () => void;
}) {
  const details = (
    <>
      <SeverityLabel severity={severity} /> {location && <span className="problem-location">{location}</span>}{" "}
      <span className="problem-message">{message}</span> {code && <span className="problem-code">{code}</span>}
      {detail && <span className="problem-detail">{detail}</span>}
    </>
  );
  return (
    <li>
      {open ? (
        <button type="button" className="problem" onClick={open}>
          {details}
        </button>
      ) : (
        <div className="problem">{details}</div>
      )}
    </li>
  );
}

function ProblemGroup({ heading, count, children }: { heading: string; count: number; children: ReactNode }) {
  return (
    <section className="problem-group">
      <h3 className="problem-group-heading">
        <span className="problem-group-name">{heading}</span> <span className="problem-count">{count}</span>
      </h3>
      <ul className="problem-list">{children}</ul>
    </section>
  );
}

function SeverityLabel({ severity }: { severity: Severity }) {
  return <span className={`severity severity-${severity}`}>{severityLabel[severity]}</span>;
}
