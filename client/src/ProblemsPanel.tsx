import { useId, type ReactNode } from "react";
import type { BuildReport } from "../../src/shared/build-report.ts";
import type { CheckReport, Severity } from "../../src/shared/check-report.ts";
import { ErrorMessage } from "./ErrorMessage";
import {
  buildProblems,
  countProblems,
  groupProblems,
  problemLocation,
  problemPath,
  problemTotal,
  summarise,
} from "./problems";
import type { Checks } from "./useChecks";

const severityLabel: Record<Severity, string> = {
  error: "Error",
  warning: "Warning",
  suggestion: "Suggestion",
  message: "Message",
};

const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: "medium" });
const dateTimeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function formatRanAt(iso: string): string {
  const date = new Date(iso);
  return date.toDateString() === new Date().toDateString() ? timeFormat.format(date) : dateTimeFormat.format(date);
}

const formatDuration = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

/** Opens a file at a line and column, both from 1. */
type OpenAt = (path: string, line: number | null, column: number | null) => void;

/** The problems list: the Package warnings, the Build's errors and warnings, then the latest Check's problems by file. */
export function ProblemsPanel({
  checks,
  expanded,
  onToggle,
  canOpen,
  onOpen,
}: {
  checks: Checks;
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
        Checked at <time dateTime={report.ranAt}>{formatRanAt(report.ranAt)}</time>
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
            {(report || build) && <span className="problems-summary">{summarise(countProblems(report, build))}</span>}
          </button>
        </h2>
        <p className="problems-status" role="status">
          {status}
          {buildStatus && ` · ${buildStatus}`}
        </p>
      </div>
      <div id={`${id}-body`} className="problems-body" hidden={!expanded}>
        {error && <ErrorMessage error={error} retry={checks.checkNow} />}
        {buildError && !error && <ErrorMessage error={buildError} retry={checks.checkNow} />}
        {(report || build) && <ReportProblems report={report} build={build} canOpen={canOpen} onOpen={onOpen} />}
      </div>
    </section>
  );
}

function ReportProblems({
  report,
  build,
  canOpen,
  onOpen,
}: {
  report: CheckReport | null;
  build: BuildReport | null;
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
  const groups = report ? groupProblems(report.problems) : [];
  const total = report ? problemTotal(report) : 0;

  if (packageProblems.length === 0 && buildList.length === 0 && groups.length === 0 && total === 0) {
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
      {buildList.length > 0 && (
        <ProblemGroup heading="Build" count={buildList.length}>
          {buildList.map((problem, index) => {
            const { file, line, column } = problem;
            return (
              <ProblemItem
                key={index}
                severity={problem.severity}
                location={file === null ? undefined : `${file}:${line}:${column}`}
                message={problem.message}
                open={file !== null && canOpen(file) ? () => onOpen(file, line, column) : undefined}
              />
            );
          })}
        </ProblemGroup>
      )}
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

/** One problem, which opens its file at the problem when `open` is given. */
function ProblemItem({
  severity,
  location,
  message,
  code,
  open,
}: {
  severity: Severity;
  location?: string;
  message: string;
  code?: string;
  open?: () => void;
}) {
  const details = (
    <>
      <SeverityLabel severity={severity} /> {location && <span className="problem-location">{location}</span>}{" "}
      <span className="problem-message">{message}</span> {code && <span className="problem-code">{code}</span>}
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
