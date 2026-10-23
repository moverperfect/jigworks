# 05: Edit files with live Checks

**Parent:** [spec](../spec.md), user stories 8, 17 to 19 and 21 (stage 2)

**What to build:** The Developer opens a Workspace and sees its file tree, one editor and a problems list. They open a file, change it and save it. Shortly afterwards a Check runs, and the problems list shows its errors alongside any Package warnings.

**Blocked by:** 04 (Install Packages).

**Status:** resolved

- [x] The Workspace page shows a file tree, one CodeMirror editor and a problems list. The Conversation panel arrives in 06.
- [x] The file tree hides Packages and `/attachments/`.
- [x] Saving writes the file. A Check runs shortly after the last save, and the problems list updates.
- [x] Checks run in a Dynamic Worker, one call per tsconfig, sending only the files a Check reads (ADR 0010). The probe's version is the starting point.
- [x] Each Check first installs Packages if `package.json`'s dependency fields changed since the last install, because Think's tools and bash write files without going through the platform's save.
- [x] The problems list shows Check errors and Package warnings.
- [x] A fresh Workspace made from the Worker Template has a clean Check.
- [x] Every Check's timings are logged.
- [x] The findings document gets the stage 2 verdict, with Check timings from real Workspaces compared against the pass bar.

## Tasks

1. File tree and file API, hiding Packages and `/attachments/`.
2. CodeMirror editor with save.
3. A Check shortly after each save, run in the Checker's Dynamic Worker and shown in the problems list.
4. Log Check timings.
5. Write the stage 2 verdict.

Drafted by an AI agent on Jack's behalf.

## Comments

**2026-10-22, agent:** Built, reviewed and checked locally. Not deployed yet. The stage 2 verdict waits for timings from the deployed platform.

- **Server:**
  - `src/checker/isolated.ts` runs a Check in the Checker's Dynamic Worker, one call per tsconfig. A crash comes back as a problem. The probe now uses it too.
  - The Dynamic Worker's ID follows the bundle and the compatibility date. The bundle's first line records ts-rust's SHA-256 (`scripts/pack-checker.mjs`, moved from `probe/scripts`), so a new ts-rust gets a new isolate.
  - A Check sends the Workspace's files plus the Packages' type declarations and `package.json` files, read from SQLite with a filter.
  - Each Check installs first if the dependency fields changed. It doesn't retry an install that already failed for the same fields, so a Check doesn't wait on npm for something that failed before. Saving `package.json` still retries.
  - The report is kept in the Durable Object's key-value store. Its problems are trimmed to 1 MB, and its `counts` cover every problem, trimmed or not.
  - Each Check logs `{event: "check", workspace, template, durationMs, counts, packages}` to Workers Logs, or `check-failed` with the error. The platform Worker logs it, timing its call to the Workspace, because a deployed Workspace's clock doesn't move during a Check (see the 2026-10-22 deploy comment below).
- **API:**
  - `GET /api/workspaces/:id/files` lists paths.
  - `GET /api/workspaces/:id/files/<path>` returns text. A file that isn't UTF-8 gets 415, and a path that can't be in the Workspace gets 404.
  - `POST` and `GET /api/workspaces/:id/check`. `GET` is `null` before the first Check.
  - The report's types are shared with the client (`src/shared/check-report.ts`).
- **Page** (`client/src`):
  - The file tree, the CodeMirror editor (`editor.ts`) and the problems list (`ProblemsPanel.tsx`), with Package warnings and a failed install listed alongside the errors.
  - Opening the page shows the stored report, then always runs a Check. A Check runs 700 ms after the last save (`checkScheduler.ts`), with one in flight at a time.
  - New problems replace the editor's underlines only if the file has no unsaved changes. Otherwise the old underlines stay and move with the edits.
  - Saves run in order, and opening another file waits for a save in progress.
  - A file keeps CRLF only if every line break in it is CRLF.
- **Beyond the ticket:** `.gitattributes` keeps Templates and the probe's projects LF, so a Windows checkout can't pack CRLF files. `pnpm platform:dev` passes `--local-upstream 127.0.0.1:8787 --upstream-protocol http`, because `wrangler dev` rewrites `Origin` to the upstream's.
- **Tests:** 11 at the HTTP seam in `test/checks.test.ts`, with ts-rust in a real Dynamic Worker. The full suite is 104 tests.
- **Local check:** on a fresh Worker Template Workspace under `wrangler dev`:
  - the Check on opening was clean in 511 ms;
  - after a type error was saved, `TS2322` at `src/index.ts:10:14` showed underlined about 1 s after Save, from a 245 ms Check;
  - a reload's Check took 151 ms;
  - 198 files were sent, most of them `hono`'s declarations.
- **Reviewed:** by three Claude reviewers (standards, spec, lean) and Codex as a second opinion.
  - **Fixed:**
    - the Dynamic Worker ID didn't change with ts-rust;
    - a failed read looked like a missing file;
    - the summary undercounted when problems were trimmed;
    - the report had no size limit;
    - the timings were logged after the report was stored;
    - a Check retried a failed install;
    - problems moved to the wrong place after unsaved edits;
    - a mixed-endings file was saved as all CRLF;
    - the page didn't check on opening;
    - a binary file opened as garbled text;
    - switching file during a save could lose the save's result;
    - the template was missing from the log.
  - **Wording:** "chat panel" became "Conversation panel" in the spec and tickets 05 and 06. ADR 0002 now says CodeMirror's own completions still work.
- **Open:** the Workspace page's bundle is 628 kB (217 kB gzipped), mostly CodeMirror. It loads only on the Workspace page.

**2026-10-22, agent:** Deployed and checked live from Jack's browser. The stage 2 verdict is in `docs/findings.md`: yes.

- **Live Checks** of a fresh Worker Template Workspace: 587 ms for the first after the deploy, about 230 ms warm, and 1.1 s from Save to underline. The pass bar is 3 s.
- **Found:** the page said "Checked in 0 ms". A deployed Worker's clock moves only at I/O, and the call into the Dynamic Worker isn't I/O, so the Workspace's own timings were all 0. Stage 1 had already found this for the probe.
- **Fixed, after that deploy:**
  - the Workspace no longer times or logs Checks;
  - the platform Worker times its call to the Workspace, which is I/O, and logs one `check` event with that time;
  - the page shows how long it waited for a Check it ran. For a stored report it shows only when the Check ran;
  - the report loses `durationMs`, the probe loses its per-tsconfig times, and `initialise` no longer takes the Template, which only the old log used.
- **Fix deployed** and checked live:
  - the page showed "Checked at 11:55:36 AM in 850 ms" for the first Check after the deploy;
  - the platform Worker logged `durationMs` of 202–425 ms for the four Checks after it.
