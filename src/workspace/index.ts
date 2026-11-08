import {
  Think,
  Workspace as FileStore,
  type ChatRecoveryOptions,
  type StepContext,
  type ThinkSession,
  type ToolCallContext,
  type ToolCallDecision,
  type ToolCallResultContext,
  type TurnConfig,
  type TurnContext,
} from "@cloudflare/think";
import type { Connection, ConnectionContext } from "agents";
import type { ToolSet } from "ai";
import tsRust from "ts-rust-wasm/ts_rust.wasm";
import {
  agentModel,
  agentTools,
  askedIn,
  fixMessage,
  developerMessage,
  instructions,
  stopAfterQuestion,
  type TurnRequest,
  summarise,
  turnProviderOptions,
  withAgentsMd,
} from "../agent";
import {
  deploymentHost,
  newAppLabel,
  previewHost,
  runnable,
  type AppLogEntry,
  type PreviewExchange,
  type PreviewRequest,
  type SignInDestination,
} from "../apphost";
import type { Build, Builder } from "../builder";
import { takeWasmMemory, trackWasm } from "../builder/wasm-memory";
import { checkInDynamicWorker } from "../checker/isolated";
import { isHidden, normalisePath, storeFiles, type Files } from "../files";
import { Packages, type PackageStatus } from "../packages";
import { registryClient, type Registry } from "../packages/registry";
import type { BuildReport } from "../shared/build-report";
import type { Deployment } from "../shared/deployment";
import type { Secret } from "../shared/secret";
import type { CheckReport, Problem, Severity } from "../shared/check-report";
import { validateWorkspaceName } from "../shared/workspace-name";
import { testFailures, testReportWithin, type TestCounts, type TestFileReport, type TestReport } from "../shared/test-report";
import { bundleTestsInDynamicWorker, isTestFile, testInDynamicWorkers, vitestTypes } from "../tester";
import {
  idleState,
  maxRetries,
  restartedDuringTurn,
  type ConversationState,
  type LastTurn,
  type TurnStage,
} from "../shared/conversation";
import { getTemplate } from "../templates";

export type { CheckReport, TestReport };

/** A Workspace file for the editor: its text, or word that it isn't text. */
export type OpenedFile = { text: string } | { binary: true };

/** What came of a change the Developer asked for. It's refused, as `busy`, while a Turn runs. */
export type DeveloperChange<T = object> = ({ ok: true } & T) | { ok: false; error: string; busy?: true };

/** What came of adding a Package, for the Developer or the Agent. */
export type PackageAdded = DeveloperChange<{ version: string; status: PackageStatus }>;

const checkKey = "check:latest";
const buildKey = "build:latest";
const testKey = "test:latest";
// The app's label, which names its app host and its hostnames (ADR 0012).
const appLabelKey = "app:label";
// The hash of the last Build the app host took, so a cached Build isn't sent again.
const appSentKey = "app:sent";
// The Build waiting to follow the Developer's last save, so a burst of saves makes one Build.
const saveBuildKey = "build:after-save";
const saveBuildDelaySeconds = 1;
const changedKey = "turn:developer-changes";
// The email of the Developer whose list the Workspace is on, so starting the app can name it there.
const developerKey = "developer";
// Whether the app has started from a Template, which happens once (ADR 0018).
const appStartedKey = "app:started";
// Which Turn the files were last copied for, and whether the app had started then, so the Turn can be undone (ADR 0018).
const copyKey = "turn:copy";
// What the Workspace keeps about its app, which undoing the Turn that started the app forgets.
// A new key about the app belongs here too.
const appKeys = [appStartedKey, appLabelKey, appSentKey, checkKey, buildKey, testKey];
// A report is kept in one key-value row, which holds at most 2 MB, so its
// problems are trimmed to a budget well inside that.
const reportBudgetBytes = 1_000_000;
// Keeps a byte order mark, so a file saved back from the editor is unchanged.
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const busy = { ok: false, busy: true, error: "The Agent is working. Wait for its Turn to end." } as const;
// A Turn's model steps, its retries included, so a confused Agent can't run up a large bill.
const turnSteps = 40;
// The only frames a Conversation socket may send: the SDK's handshake for
// joining a reply that's already streaming. The socket only watches; Turns
// start over HTTP, so the platform runs each Turn's lock, Check and retries.
const watchingFrames = new Set(["cf_agent_stream_resume_request", "cf_agent_stream_resume_ack"]);
// The Agent's tools that read the files, and so wait for the others in their step.
const waitingTools = new Set(["check", "build", "test"]);
// The Agent's tools that refuse until it has started the app, so nothing is written without a Template under it (ADR 0018).
const needAppTools = new Set(["write", "edit", "delete", "bash", "add_package", "check", "build", "test"]);
const startAppFirst = "The app hasn't started yet, so this tool can't run. Start it first with start_app.";
// For the Developer, in the page's words.
const notStartedYet = { ok: false, error: "Your app hasn't started yet. Wait for the Agent to start it." } as const;

// Records how far esbuild's memory grows during each Build, for the findings.
// ts-rust runs in its own Dynamic Worker, so only esbuild shows here.
trackWasm(() => "esbuild");

/** Who a Check or a Build is for. */
type RequestedBy = "developer" | "save" | "preview" | "turn" | "agent";

/**
 * A name for this isolate, chosen when it's first needed, because Workers
 * allow no randomness at startup. A new name in the logs means Cloudflare
 * replaced the isolate, as it does when one goes over its memory limit
 * (ADR 0010).
 */
let isolateNameChosen = "";
const isolateName = () => (isolateNameChosen ||= crypto.randomUUID().slice(0, 8));

/**
 * One per Workspace, named by its ID: a Think Durable Object holding the
 * Workspace's files, its Packages and its Conversation (ADR 0003). Its RPC
 * methods are async, because Think starts its lifecycle, which resolves the
 * object's name, only for async calls.
 */
export class Workspace extends Think<Env, ConversationState> {
  /**
   * Think's file store. Think fixes the property's name; our own code reaches
   * the files through `files` (ADR 0003).
   */
  override workspace = new FileStore({ sql: this.ctx.storage.sql, name: () => this.name });

  override initialState = idleState;
  // Think truncates old tool output every few messages, which changes the
  // start of the prompt and so loses Anthropic's prompt cache. The model's
  // context is large, and Start fresh shortens a long Conversation.
  override truncationStep = Infinity;

  private readonly files: Files = storeFiles(this.workspace, this.ctx.storage);
  private readonly packages = new Packages(this.ctx.storage);
  // Installs and Package changes run one at a time, in the order they arrive.
  // (Think already has a `queue`.)
  private packageWork: Promise<unknown> = Promise.resolve();
  // Token use across the running Turn's model calls, for its log line.
  private turnUsage: TurnUsage | null = null;
  private builder: Builder | null = null;
  // The model's tool calls that are running, other than check and build, and
  // what's waiting for them to finish (see `otherToolsFinished`).
  private toolsRunning = 0;
  private toolsFinished: (() => void)[] = [];
  // Test runs in the order they read the files, and the latest run kept, so
  // a slow run can't replace the report of one that read the files after it.
  private testRunsStarted = 0;
  private testRunKept = 0;

  /**
   * A Turn or Start fresh can't outlive the isolate it ran in (see
   * `onChatRecovery`). A Turn the old isolate was running still ends with a
   * Check and a Build, and is undone if they find the app broken (ADR 0018),
   * so it keeps its lock until `endRestartedTurn` has done that. A Build
   * calls this object, which can't answer until `onStart` returns, so they
   * run in an alarm of their own.
   */
  override async onStart(): Promise<void> {
    const { turn, startingFresh } = this.state;
    if (turn && !turn.restarted) {
      this.setState({ ...this.state, turn: { ...turn, stage: "checking", restarted: true } });
      await this.schedule(0, "endRestartedTurn", { startedAt: turn.startedAt }, { retry: { maxAttempts: 1 } });
      return;
    }
    if (!turn && !startingFresh) return;
    // Start fresh, or a restart while ending a Turn after a restart, which
    // ends without a Check, so a restart that keeps happening can't loop.
    // Its files may have been put back before the second restart.
    const copy = this.ctx.storage.kv.get<TurnCopy>(copyKey);
    const restored = Boolean(turn && copy?.startedAt === turn.startedAt && copy.undone);
    const stopped: LastTurn = { ...stoppedByRestart(), endedAt: new Date().toISOString(), startedApp: false, noApp: !this.appStarted(), restored };
    if (turn) this.logTurn(turn.startedAt, stopped);
    this.setState({ turn: null, startingFresh: false, lastTurn: turn ? stopped : this.state.lastTurn });
    // The Agent may have changed files before the restart.
    if (turn) await this.updateList();
  }

  /** Ends the Turn a restart stopped (see `onStart`). Only `onStart` schedules it. */
  async endRestartedTurn({ startedAt }: { startedAt: string }): Promise<void> {
    const { turn } = this.state;
    if (turn?.startedAt !== startedAt || !turn.restarted) return;
    await this.endTurn(startedAt, stoppedByRestart(), await this.endOfTurn().catch(() => null));
  }

  /**
   * Keeps what an interrupted reply streamed, but doesn't carry the reply on.
   * The Turn's Check and retries ran in the isolate that stopped, so a reply
   * carried on in a new one would end with no Check and no Turn lock.
   */
  override async onChatRecovery(): Promise<ChatRecoveryOptions> {
    return { persist: true, continue: false };
  }

  /**
   * Drops every frame a Conversation socket sends except the stream-resume
   * handshake. Think would otherwise start a Turn from a chat request, clear
   * the Conversation, or take the Workspace's state from the socket.
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (!watchingFrames.has(frameType(message))) return;
    // Defining this method stops the SDK installing its own, so pass the frame on to it.
    await this.lifecycle.webSocketMessage(ws, message);
  }

  /**
   * Think sends a new socket the Conversation only when nothing is
   * streaming, so a page opened mid-Turn would see the Turn's reply and none
   * of the messages before it.
   */
  override async onConnect(connection: Connection, _ctx: ConnectionContext): Promise<void> {
    if (this.state.turn) connection.send(JSON.stringify({ type: "cf_agent_chat_messages", messages: this.messages, connect: true }));
  }

  override getModel() {
    return agentModel(this.env);
  }

  override getSystemPrompt(): string {
    return instructions;
  }

  override getTools(): ToolSet {
    return agentTools({
      startApp: (template, name) => this.startApp(template, name),
      check: async () => {
        await this.otherToolsFinished();
        return this.check("agent");
      },
      build: async () => {
        await this.otherToolsFinished();
        return this.buildInItsOwnCall("agent");
      },
      test: async (files) => {
        await this.otherToolsFinished();
        return this.runTests("agent", files);
      },
      addPackageForAgent: (name, options) => this.addPackageForAgent(name, options),
      requestPreview: (init) => this.requestPreview(init),
      previewLogs: (limit) => this.previewLogs(limit),
      secretNames: () => this.secretNames(),
      appStarted: () => this.appStarted(),
    });
  }

  override beforeTurn(ctx: TurnContext): TurnConfig {
    return {
      instructions: withAgentsMd(ctx.system, this.files.read("AGENTS.md")),
      // A retry gets the steps the Turn has left.
      maxSteps: turnSteps - (this.turnUsage?.steps ?? 0),
      // A question ends the Turn: the Developer's answer starts the next.
      stopWhen: stopAfterQuestion,
      providerOptions: turnProviderOptions,
    };
  }

  override beforeToolCall(ctx: ToolCallContext): ToolCallDecision | void {
    // Counted even when refused: `afterToolCall` follows either way.
    if (!waitingTools.has(ctx.toolName)) this.toolsRunning += 1;
    if (needAppTools.has(ctx.toolName) && !this.appStarted()) return { action: "block", reason: startAppFirst };
  }

  override afterToolCall(ctx: ToolCallResultContext): void {
    if (waitingTools.has(ctx.toolName)) return;
    this.toolsRunning -= 1;
    if (this.toolsRunning === 0) for (const resolve of this.toolsFinished.splice(0)) resolve();
  }

  /**
   * Waits for the other tools the model called in the same step, which run
   * alongside `check` and `build`, so those read the files after the
   * others' changes. Bash writes its changes back only when its script ends.
   */
  private async otherToolsFinished(): Promise<void> {
    // Lets the step's other calls start, and so be counted.
    await scheduler.wait(0);
    if (this.toolsRunning === 0) return;
    const finished = new Promise<void>((resolve) => this.toolsFinished.push(resolve));
    // In case a tool never reports back, a Check or a Build still runs.
    await Promise.race([finished, scheduler.wait(60_000)]);
  }

  override onStepEnd(ctx: StepContext): void {
    if (!this.turnUsage) return;
    this.turnUsage.steps += 1;
    this.turnUsage.inputTokens += ctx.usage.inputTokens ?? 0;
    this.turnUsage.outputTokens += ctx.usage.outputTokens ?? 0;
    this.turnUsage.cacheReadTokens += ctx.usage.inputTokenDetails?.cacheReadTokens ?? 0;
    this.turnUsage.cacheWriteTokens += ctx.usage.inputTokenDetails?.cacheWriteTokens ?? 0;
  }

  override configureSession(session: ThinkSession): ThinkSession {
    // Start fresh folds everything after the Developer's first message into
    // one summary, which is an assistant message. The first message stays,
    // so what's sent to the model still starts with a user message.
    return session.onCompaction(async (messages) => {
      const first = messages[1];
      const last = messages.at(-1);
      if (!first || !last) return null;
      return { fromMessageId: first.id, toMessageId: last.id, summary: await summarise(messages, this.resolveModel()) };
    });
  }

  /**
   * Sets up a new Workspace on `developer`'s list. With `app`, it starts the
   * app from that Template under that name; without, the Workspace stays
   * empty until the Agent starts the app (ADR 0018). The caller has
   * checked the Template and the name.
   */
  async initialise(developer: string, app?: { template: string; name: string }): Promise<void> {
    this.ctx.storage.kv.put(developerKey, developer);
    if (!app) return;
    const started = await this.exclusive(() => this.fill(app.template, app.name));
    if (!started.ok) throw new Error(started.error);
  }

  /**
   * Starts the app for the Agent's `start_app` tool: writes the Template's
   * files, installs their Packages, makes the app's label from `name`, and
   * gives the Developer's list the name and the Template. Refused once the
   * app has started. Returns the new AGENTS.md, which the Turn's
   * instructions predate.
   */
  async startApp(template: string, name: string): Promise<DeveloperChange<{ agentsMd: string | null }>> {
    const started = await this.exclusive(() => this.fill(template, name));
    if (!started.ok) return started;
    const developer = this.ctx.storage.kv.get<string>(developerKey);
    if (developer) await this.env.DEVELOPERS.getByName(developer).appStarted(this.name, name.trim(), template);
    return { ok: true, agentsMd: this.files.read("AGENTS.md") };
  }

  /**
   * For a Developer's list made before it kept the times: records whose list
   * the Workspace is on, and says when it was last published and its last
   * Turn ended.
   */
  async joinList(developer: string): Promise<{ publishedAt: string | null; changedAt: string | null }> {
    this.ctx.storage.kv.put(developerKey, developer);
    const label = this.ctx.storage.kv.get<string>(appLabelKey);
    const published = label ? await this.env.APP_HOSTS.getByName(label).published() : null;
    return { publishedAt: published?.publishedAt ?? null, changedAt: this.state.lastTurn?.endedAt ?? null };
  }

  /**
   * Tells the Developer's list that the app changed just now, or was
   * published at `publishedAt`. The change itself has already happened, so
   * a list that can't be told is only logged.
   */
  private async updateList(publishedAt?: string): Promise<void> {
    const developer = this.ctx.storage.kv.get<string>(developerKey);
    if (!developer) return;
    const list = this.env.DEVELOPERS.getByName(developer);
    try {
      await (publishedAt ? list.recordPublish(this.name, publishedAt) : list.recordChange(this.name));
    } catch (error) {
      console.log(JSON.stringify({ event: "list-update-failed", workspace: this.name, error: String(error) }));
    }
  }

  /**
   * Whether the app has started from a Template (ADR 0018). Until then the
   * Workspace has no files; afterwards it may have none again, if the Agent
   * deletes them. A Workspace with files from before Templates were the
   * Agent's to choose is recorded as started the first time it's asked.
   */
  private appStarted(): boolean {
    if (this.ctx.storage.kv.get<boolean>(appStartedKey)) return true;
    if (this.files.list().length === 0) return false;
    this.ctx.storage.kv.put(appStartedKey, true);
    return true;
  }

  /** Only from inside `exclusive`. */
  private async fill(templateId: string, name: string): Promise<DeveloperChange> {
    if (this.appStarted()) return { ok: false, error: "The app has already started." };
    const template = getTemplate(templateId);
    if (!template) return { ok: false, error: `There's no Template called ${templateId}.` };
    const invalid = validateWorkspaceName(name);
    if (invalid) return { ok: false, error: invalid };
    // Any label made before now, as for the Preview's address, belongs to no app yet, so it's replaced.
    this.ctx.storage.kv.put(appLabelKey, newAppLabel(name.trim()));
    for (const [path, text] of Object.entries(template.files)) await this.files.write(path, text);
    this.ctx.storage.kv.put(appStartedKey, true);
    await this.install();
    return { ok: true };
  }

  /** The Workspace's files as bytes for the zip export, without hidden paths or Packages. */
  async exportFiles(): Promise<Record<string, Uint8Array>> {
    return Object.fromEntries(this.files.bytes());
  }

  /** Every Workspace file's path, for the file tree. */
  async listFiles(): Promise<string[]> {
    return this.files.list();
  }

  /** One Workspace file for the editor, or null if there's no such file. The path must already be normalised. */
  async readFile(path: string): Promise<OpenedFile | null> {
    const bytes = this.files.readBytes(path);
    if (!bytes) return null;
    try {
      return { text: strictUtf8.decode(bytes) };
    } catch {
      return { binary: true };
    }
  }

  /**
   * Type-checks the Workspace in a Dynamic Worker (ADR 0010), after
   * installing Packages if `package.json` changed since the last install:
   * Think's tools write files without going through `writeFile`. Every
   * Check goes to Workers Logs, with what asked for it. A deployed Worker's
   * clock doesn't move during a Check, so only a Developer's Check is timed,
   * by the platform Worker (stage 2 in docs/findings.md).
   */
  async check(by: RequestedBy = "developer"): Promise<CheckReport> {
    return this.exclusive(async () => {
      const ranAt = new Date().toISOString();
      const packages = await this.install({ retryFailed: false });
      // The platform's `vitest` comes last, so a Package can't stand in for it (ADR 0017).
      const snapshot = new Map([...this.files.snapshot(), ...this.packages.declarations(), ...vitestTypes()]);
      const { problems, projects } = await checkInDynamicWorker(this.env.LOADER, tsRust, snapshot);
      const report: CheckReport = {
        ranAt,
        projects,
        problems: withinBudget(problems),
        counts: countBySeverity(problems),
        packages,
      };
      this.ctx.storage.kv.put(checkKey, report);
      console.log(JSON.stringify({ event: "check", workspace: this.name, by, isolate: isolateName(), counts: report.counts, packages: packages.state }));
      return report;
    });
  }

  /** The latest Check's report, or null before the first. */
  async latestCheck(): Promise<CheckReport | null> {
    return this.ctx.storage.kv.get<CheckReport>(checkKey) ?? null;
  }

  /**
   * Builds the Workspace's code with its Packages, after installing them if
   * `package.json` changed since the last install. A recent Build of the same
   * inputs is reused. A Check's errors don't stop a Build, and a successful
   * Build goes to the app host as the Preview. Every Build goes
   * to Workers Logs with esbuild's memory, the isolate it ran in, and the
   * Packages its output still imports; its CPU and wall time are in its
   * call's trace. The Workspace's own Builds call it through its stub (see
   * `buildInItsOwnCall`), so each has a trace of its own.
   */
  async build(by: RequestedBy = "developer"): Promise<BuildReport> {
    return this.exclusive(async () => {
      const ranAt = new Date().toISOString();
      await this.install({ retryFailed: false });
      const snapshot = new Map([...this.files.snapshot(), ...this.packages.snapshot()]);
      // Loaded on the first Build, so esbuild starts only in Workspaces that build.
      this.builder ??= (await import("../builder")).inProcessBuilder();
      const result = await this.builder.build(snapshot);
      const report: BuildReport = {
        ranAt,
        ok: result.ok,
        hash: result.hash,
        cached: result.cached,
        errors: result.ok ? [] : result.errors,
        warnings: result.warnings,
      };
      this.ctx.storage.kv.put(buildKey, report);
      if (result.ok) await this.sendToAppHost(result);
      console.log(
        JSON.stringify({
          event: "build",
          workspace: this.name,
          by,
          isolate: isolateName(),
          ok: report.ok,
          cached: report.cached,
          errors: report.errors.length,
          warnings: report.warnings.length,
          missingPackages: result.ok ? [] : result.missingPackages,
          tailwindFailure: result.ok ? null : (result.tailwindFailure ?? null),
          tailwindCandidates: result.ok ? (result.tailwindCandidates ?? null) : null,
          files: snapshot.size,
          wasmMemoryBytes: takeWasmMemory(),
        }),
      );
      return report;
    });
  }

  /** The latest Build's report, or null before the first. */
  async latestBuild(): Promise<BuildReport | null> {
    return this.ctx.storage.kv.get<BuildReport>(buildKey) ?? null;
  }

  /**
   * Runs the Workspace's tests, or only those in `only`, each test file in a
   * Dynamic Worker of its own (ADR 0017), after installing Packages if
   * `package.json` changed. The tests are bundled as a Build is. A run of
   * every test file is kept as the latest, for the problems list. Every run
   * goes to Workers Logs, with what asked for it.
   */
  async runTests(by: RequestedBy = "developer", only?: string[]): Promise<TestReport> {
    const ranAt = new Date().toISOString();
    // The files are read in line with saves, and the tests run after.
    const { run, testFiles, bundle } = await this.exclusive(async () => {
      const run = ++this.testRunsStarted;
      await this.install({ retryFailed: false });
      const testFiles = this.files
        .list()
        .filter((path) => isTestFile(path) && (!only || only.includes(path)))
        .sort();
      if (testFiles.length === 0) return { run, testFiles, bundle: null };
      const snapshot = new Map([...this.files.snapshot(), ...this.packages.snapshot()]);
      return { run, testFiles, bundle: await bundleTestsInDynamicWorker(this.env.LOADER, snapshot, testFiles) };
    });
    const files = bundle?.ok ? await testInDynamicWorkers(this.env.LOADER, bundle, testFiles) : [];
    const report: TestReport = { ranAt, files, bundleErrors: bundle && !bundle.ok ? bundle.errors : [], counts: countTests(files) };
    if (!only && run > this.testRunKept) {
      this.testRunKept = run;
      this.ctx.storage.kv.put(testKey, testReportWithin(report, reportBudgetBytes));
    }
    console.log(
      JSON.stringify({
        event: "test",
        workspace: this.name,
        by,
        isolate: isolateName(),
        files: testFiles.length,
        only: only !== undefined,
        counts: report.counts,
        failures: testFailures(report),
      }),
    );
    return report;
  }

  /** The latest run of every test file, or null before the first. */
  async latestTests(): Promise<TestReport | null> {
    return this.ctx.storage.kv.get<TestReport>(testKey) ?? null;
  }

  private appHost() {
    return this.env.APP_HOSTS.getByName(this.appLabel());
  }

  /** The app's label, which names its app host and hostnames. Workspaces made before ticket 08 get one now. */
  appLabel(): string {
    let label = this.ctx.storage.kv.get<string>(appLabelKey);
    if (!label) {
      label = newAppLabel("");
      this.ctx.storage.kv.put(appLabelKey, label);
    }
    return label;
  }

  /**
   * Where the Preview answers, and the hash of the Build it runs (the latest
   * successful one), or null before there's one to run. A Workspace
   * whose successful Build predates its app host builds once more, from the
   * cache, to send it there.
   */
  async preview(): Promise<{ url: string; ready: boolean; hash: string | null }> {
    let hash = await this.appHost().previewHash();
    if (hash === null && (await this.latestBuild())?.ok) {
      await this.buildInItsOwnCall("preview");
      hash = await this.appHost().previewHash();
    }
    return { url: `https://${previewHost(this.appLabel(), this.env.APPS_DOMAIN)}/`, ready: hash !== null, hash };
  }

  /** A single-use link that signs the Developer in to the Preview and shows `to` (ADR 0013). The caller checks ownership first. */
  async previewSignIn(destination: SignInDestination, to: string): Promise<string> {
    const label = this.appLabel();
    const url = await this.env.APP_HOSTS.getByName(label).mintSignIn(this.name, label, destination, to);
    if (url === null) throw new Error("The app's label belongs to another Workspace.");
    return url;
  }

  /** Sends the Preview a request for the Agent's `request_preview` tool. */
  async requestPreview(init: PreviewRequest): Promise<PreviewExchange> {
    return this.appHost().requestPreview(init);
  }

  /** Where the Deployment answers, and what it runs. */
  async deployment(): Promise<Deployment> {
    const label = this.appLabel();
    const published = await this.env.APP_HOSTS.getByName(label).published();
    return { publishedAt: null, hash: null, ...published, ...this.deploymentAt(label) };
  }

  /**
   * Publishes the Build the Preview runs as the Deployment, in place of the
   * one whose Build is `replaces`, or none. Refused while a Turn runs, when the
   * Agent may be changing the Preview.
   */
  async publish(replaces: string | null): Promise<DeveloperChange<{ deployment: Deployment }>> {
    if (this.state.turn) return busy;
    // As for the Preview, a successful Build from before the app host goes
    // there first. It builds through the Workspace's stub, which waits for
    // the lock, so it comes before the lock is taken.
    await this.preview();
    // In line with Turns starting (see `startTurn`), so a Turn that started
    // meanwhile is seen.
    const result = await this.exclusive(async () => {
      if (this.state.turn) return null;
      return this.appHost().publish(this.name, replaces);
    });
    if (!result) return busy;
    const label = this.appLabel();
    if (!result.ok) {
      const error =
        result.reason === "changed"
          ? "Your app was published from somewhere else since this page looked. Check what's live now before publishing again."
          : "Your app hasn't been built yet, so there's nothing to publish.";
      return { ok: false, error };
    }
    console.log(JSON.stringify({ event: "publish", workspace: this.name, hash: result.published.hash }));
    await this.updateList(result.published.publishedAt);
    return { ok: true, deployment: { ...result.published, ...this.deploymentAt(label) } };
  }

  /** Where the Deployment answers, and who it's open to. */
  private deploymentAt(label: string): Pick<Deployment, "url" | "openToEveryone"> {
    return {
      url: `https://${deploymentHost(label, this.env.APPS_DOMAIN)}/`,
      openToEveryone: this.env.DEPLOYMENTS_OPEN_TO_EVERYONE === true,
    };
  }

  /** The names of the secrets the Developer gave the Workspace (ADR 0016). */
  async secretNames(): Promise<Secret[]> {
    return this.appHost().secretNames();
  }

  /**
   * Adds or replaces a secret, which reaches the app's env at once. Refused
   * before the app has started, whose label would change (see `fill`).
   */
  async setSecret(name: string, value: unknown): Promise<DeveloperChange> {
    if (!this.appStarted()) return notStartedYet;
    const label = this.appLabel();
    return this.env.APP_HOSTS.getByName(label).setSecret(this.name, label, name, value);
  }

  /** Removes a secret from the app's env at once. */
  async removeSecret(name: string): Promise<void> {
    await this.appHost().removeSecret(this.name, name);
  }

  /** Deletes the app's app host, before the Workspace itself is deleted (ADR 0009). Undoing the Turn that started the app removes it too (see `forgetApp`). */
  async removeApp(): Promise<void> {
    const label = this.ctx.storage.kv.get<string>(appLabelKey);
    if (label) await this.env.APP_HOSTS.getByName(label).remove(this.name);
  }

  /** The Preview's newest server logs and front-end errors, for the Agent's `preview_logs` tool. */
  async previewLogs(limit?: number): Promise<AppLogEntry[]> {
    return this.appHost().logs("preview", limit);
  }

  /**
   * Gives the app host a successful Build, which the Preview then runs. In
   * the unlikely case that another Workspace already holds this app's label,
   * the Workspace picks a new one, up to three times: a Build that can't
   * reach its Preview would leave the Developer looking at an old one.
   */
  private async sendToAppHost(build: Build): Promise<void> {
    if (this.ctx.storage.kv.get<string>(appSentKey) === build.hash) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      const label = this.appLabel();
      const { accepted } = await this.env.APP_HOSTS.getByName(label).receiveBuild(this.name, label, runnable(build));
      if (accepted) {
        this.ctx.storage.kv.put(appSentKey, build.hash);
        return;
      }
      this.ctx.storage.kv.put(appLabelKey, newAppLabel(label.replace(/-[a-z0-9]{8}$/, "")));
    }
    throw new Error("Couldn't find a free label for the Workspace's app.");
  }

  /**
   * A Build for the Turn or the Agent, through the Workspace's own stub, so
   * the Build is a call of its own with its own CPU and wall time in
   * Cloudflare's trace. The clock here barely moves across the call (live,
   * 156 ms for a Build the trace put at 1,036 ms), so it isn't timed here.
   * Work after the call is counted in the Build's trace too.
   */
  private buildInItsOwnCall(by: Exclude<RequestedBy, "developer">): Promise<BuildReport> {
    return this.env.WORKSPACES.get(this.ctx.id).build(by);
  }

  /**
   * Saves a file for the Developer, unless a Turn is running. Saving
   * `package.json` installs or removes Packages to match, in turn with any
   * Package being added. The next Turn is told which files changed.
   */
  async writeFile(path: string, text: string): Promise<DeveloperChange> {
    const normalised = normalisePath(path);
    if (isHidden(normalised)) throw new Error(`${normalised} isn't a Workspace file`);
    // In line with Turns starting (see `startTurn`), so a save is checked
    // against the lock when its time comes, and lands either before the Turn,
    // which is told about it, or not at all.
    const result = await this.exclusive(async (): Promise<DeveloperChange> => {
      if (this.state.turn) return busy;
      // A file of the Developer's would leave no room for a Template (ADR 0018).
      if (!this.appStarted()) return notStartedYet;
      await this.files.write(normalised, text);
      this.noteDeveloperChange(normalised);
      if (normalised === "package.json") await this.install();
      return { ok: true };
    });
    if (result.ok) await Promise.all([this.buildSoon(), this.updateList()]);
    return result;
  }

  /**
   * Builds shortly after the Developer's last save, on the server, so the
   * Preview follows every save even when the page has closed.
   */
  private async buildSoon(): Promise<void> {
    const waiting = this.ctx.storage.kv.get<string>(saveBuildKey);
    if (waiting) await this.cancelSchedule(waiting);
    const { id } = await this.schedule(saveBuildDelaySeconds, "buildAfterSave", undefined, { retry: { maxAttempts: 1 } });
    this.ctx.storage.kv.put(saveBuildKey, id);
  }

  /** Runs the Build `buildSoon` scheduled. Only `buildSoon` schedules it. */
  async buildAfterSave(): Promise<void> {
    this.ctx.storage.kv.delete(saveBuildKey);
    await this.buildInItsOwnCall("save");
  }

  /** What's installed, and how the last install went. */
  async packageStatus(): Promise<PackageStatus> {
    return this.packages.status();
  }

  /** Adds a Package for the Developer, unless a Turn is running. The next Turn is told `package.json` changed. */
  async addPackage(name: string, options: AddOptions = {}): Promise<PackageAdded> {
    const result = await this.addPackageFor("developer", name, options);
    if (result.ok) await this.updateList();
    return result;
  }

  /** Adds a Package for the Agent's `add_package` tool, during its Turn. */
  async addPackageForAgent(name: string, options: AddOptions): Promise<PackageAdded> {
    return this.addPackageFor("agent", name, options);
  }

  /** Adds a Package at the newest version that's at least a day old, saves `package.json`, and installs. */
  private addPackageFor(by: "developer" | "agent", name: string, options: AddOptions): Promise<PackageAdded> {
    return this.exclusive(async () => {
      if (by === "developer" && this.state.turn) return busy;
      if (by === "developer" && !this.appStarted()) return notStartedYet;
      const registry = registryClient();
      const result = await this.packages.add(this.files.read("package.json") ?? "{}", name, { ...options, registry });
      if (!result.ok) return result;
      await this.files.write("package.json", result.packageJson);
      if (by === "developer") this.noteDeveloperChange("package.json");
      return { ok: true, version: result.version, status: await this.install({ registry }) };
    });
  }

  /** Every Package file, at `node_modules/<name>/<path>`. */
  async packageFiles(): Promise<Record<string, string>> {
    return Object.fromEntries(this.packages.snapshot());
  }

  /**
   * Starts a Turn for the Developer's message, unless one is running. The
   * Turn carries on after this returns; Conversation sockets follow it.
   */
  async startTurn(request: TurnRequest): Promise<DeveloperChange> {
    // In line with Package work, so a save or an add that arrived first lands
    // before the lock, and the Turn is told about it.
    return this.exclusive(async () => {
      if (this.state.turn || this.state.startingFresh) return busy;
      const startedAt = new Date().toISOString();
      // In case the Turn leaves the app broken and has to be undone.
      this.files.copyAside();
      this.ctx.storage.kv.put<TurnCopy>(copyKey, { startedAt, appStarted: this.appStarted() });
      this.setState({ ...this.state, turn: { startedAt, stage: "working" } });
      // The Turn runs in an alarm of its own, which ends when the Turn does,
      // so its logs reach Workers Logs. Run in the background of this call
      // instead, they never did.
      await this.schedule(0, "driveTurn", { request, startedAt }, { retry: { maxAttempts: 1 } });
      return { ok: true };
    });
  }

  /**
   * Runs the Turn `startTurn` scheduled, unless a restart has stopped it since
   * (see `onStart`), so an alarm retried after a restart doesn't send the
   * Developer's message twice. Only `startTurn` schedules it.
   */
  async driveTurn({ request, startedAt }: { request: TurnRequest; startedAt: string }): Promise<void> {
    const { turn } = this.state;
    if (turn?.startedAt === startedAt && !turn.restarted) await this.runDeveloperTurn(request, startedAt);
  }

  /** Folds the Conversation into a summary, unless a Turn is running. */
  async startFresh(): Promise<DeveloperChange> {
    if (this.state.turn || this.state.startingFresh) return busy;
    this.setState({ ...this.state, startingFresh: true });
    try {
      await this.session.compact();
      this.broadcast(JSON.stringify({ type: "cf_agent_chat_messages", messages: this.messages }));
      return { ok: true };
    } finally {
      this.setState({ ...this.state, startingFresh: false });
    }
  }

  /**
   * One Turn: the Developer's message, then a Check, then up to three more
   * tries while the Check has errors and the Turn has steps left. Each try is
   * a Think turn of its own.
   */
  private async runDeveloperTurn(request: TurnRequest, startedAt: string): Promise<void> {
    const started = Date.now();
    const usage: TurnUsage = (this.turnUsage = { steps: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const lastTurn = newLastTurn();
    let ended: CheckAndBuild | null = null;
    try {
      const changed = this.ctx.storage.kv.get<string[]>(changedKey) ?? [];
      this.ctx.storage.kv.delete(changedKey);
      // The last Turn's files may have been put back, which the Agent can't otherwise know.
      const undone = this.state.lastTurn?.restored === true;
      let result = await this.saveMessages([developerMessage(request, changed, startedAt, undone)]);
      ended = await this.endOfTurn();
      while (
        ended &&
        // A Turn that ends with a question gets its Check and Build, but no retries (ADR 0018).
        !askedIn(this.messages.at(-1)) &&
        result.status === "completed" &&
        broken(ended) &&
        lastTurn.retries < maxRetries &&
        usage.steps < turnSteps
      ) {
        lastTurn.retries += 1;
        this.setStage("working");
        result = await this.saveMessages([fixMessage(ended.check, ended.build, lastTurn.retries)]);
        ended = await this.endOfTurn();
      }
      lastTurn.status = result.status;
      lastTurn.error = result.error ?? null;
      lastTurn.outOfSteps = usage.steps >= turnSteps;
    } catch (error) {
      lastTurn.error = error instanceof Error ? error.message : String(error);
      // The Agent may have changed files before the failure, and every Turn
      // ends with a Check and a Build.
      ended = await this.endOfTurn().catch(() => null);
    } finally {
      this.turnUsage = null;
      await this.endTurn(startedAt, lastTurn, ended, { durationMs: Date.now() - started, ...usage });
    }
  }

  /**
   * Ends a Turn after its last Check and Build: undoes it if they left the
   * app broken (ADR 0018), runs the tests once, and lifts the Turn lock.
   * `log` goes into the Turn's log line. The clock moves only at I/O, so a
   * duration in it leaves out the last Check.
   */
  private async endTurn(startedAt: string, lastTurn: LastTurn, ended: CheckAndBuild | null, log: TurnLog = {}): Promise<void> {
    // Only this Turn's copy: a Turn that was running when undoing was deployed has none.
    const turnCopy = () => {
      const copy = this.ctx.storage.kv.get<TurnCopy>(copyKey);
      return copy?.startedAt === startedAt ? copy : null;
    };
    const copy = turnCopy();
    const hadStarted = copy ? copy.appStarted : this.appStarted();
    try {
      lastTurn.checkErrors = ended?.check.counts.error ?? null;
      lastTurn.buildErrors = ended?.build.errors.length ?? null;
      // A Turn the Workspace restarted during may have been undone already.
      if (copy && !copy.undone && ended && broken(ended)) ended = await this.undo(copy);
      // Once, after the last Check and Build: failing tests don't ask for a
      // retry, and tests that can't run don't fail the Turn.
      const tests = ended && (await this.runTests("turn").catch(() => null));
      lastTurn.testFailures = tests ? testFailures(tests) : null;
    } catch (error) {
      lastTurn.error ??= error instanceof Error ? error.message : String(error);
    } finally {
      lastTurn.restored = turnCopy()?.undone === true;
      lastTurn.endedAt = new Date().toISOString();
      const startedNow = this.appStarted();
      lastTurn.startedApp = !hadStarted && startedNow;
      lastTurn.noApp = !startedNow;
      lastTurn.asked = askedIn(this.messages.at(-1));
      this.logTurn(startedAt, lastTurn, log);
      this.setState({ ...this.state, turn: null, lastTurn });
      await this.updateList();
    }
  }

  /** Logs a Turn's `turn` line as it ends, for Workers Logs and for `scripts/tail-events.py` to read from `wrangler tail`. */
  private logTurn(startedAt: string, lastTurn: LastTurn, log?: TurnLog): void {
    console.log(JSON.stringify({ event: "turn", workspace: this.name, startedAt, ...lastTurn, ...log }));
  }

  /**
   * Puts the files back as they were copied when the Turn started, installs
   * the Packages their `package.json` lists, and checks and builds them, so
   * the reports match the files (ADR 0018). Returns that Check and Build, or
   * null when the app hadn't started: undoing the Turn that started it
   * leaves nothing to check or build.
   */
  private async undo(copy: TurnCopy): Promise<CheckAndBuild | null> {
    await this.exclusive(async () => {
      const label = this.ctx.storage.kv.get<string>(appLabelKey);
      // With no await between them, these writes are kept together, so once
      // the files are back, a restart or a failure still finds the Turn undone.
      this.files.restoreCopy();
      this.ctx.storage.kv.put<TurnCopy>(copyKey, { ...copy, undone: true });
      if (!copy.appStarted) for (const key of appKeys) this.ctx.storage.kv.delete(key);
      // deferred: a restart before this line leaves the old app host unreached and the list naming the old app, until a later start renames it; fix if undoing starts shows up in the restart logs.
      if (!copy.appStarted && label) await this.forgetApp(label);
      await this.install();
    });
    return this.endOfTurn();
  }

  /**
   * After undoing the Turn that started the app, which a later Turn starts
   * afresh under a new name and address (see `fill`): removes the app host
   * that had `label`, with the Template's Build its Preview ran, since
   * nothing will reach it again, and lists the Workspace as before its app
   * started. The Workspace itself is already as it was.
   */
  private async forgetApp(label: string): Promise<void> {
    await this.env.APP_HOSTS.getByName(label).remove(this.name);
    const developer = this.ctx.storage.kv.get<string>(developerKey);
    if (developer) await this.env.DEVELOPERS.getByName(developer).appForgotten(this.name);
  }

  /**
   * A Turn's Check, then its Build, which goes ahead whatever the Check
   * found, or null when the app hasn't started and there's nothing to check
   * (ADR 0018). The Turn's tests come once, after the last.
   */
  private async endOfTurn(): Promise<CheckAndBuild | null> {
    if (!this.appStarted()) return null;
    // The tests that follow the last of these run at this stage too.
    this.setStage("checking");
    const check = await this.check("turn");
    return { check, build: await this.buildInItsOwnCall("turn") };
  }

  /** Tells Conversation sockets what the running Turn is doing. */
  private setStage(stage: TurnStage): void {
    const { turn } = this.state;
    if (turn && turn.stage !== stage) this.setState({ ...this.state, turn: { ...turn, stage } });
  }

  private noteDeveloperChange(path: string): void {
    const changed = new Set(this.ctx.storage.kv.get<string[]>(changedKey) ?? []);
    changed.add(path);
    this.ctx.storage.kv.put(changedKey, [...changed].sort());
  }

  /** Only from inside `exclusive`. */
  private install(options: { registry?: Registry; retryFailed?: boolean } = {}): Promise<PackageStatus> {
    return this.packages.install(this.files.read("package.json") ?? "{}", options);
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.packageWork.then(work, work);
    this.packageWork = run.catch(() => undefined);
    return run;
  }
}

/** How to choose the version of a Package being added. */
type AddOptions = { range?: string; dev?: boolean };

/** A socket frame's `type`, or "" for a frame that isn't a JSON object. */
function frameType(message: string | ArrayBuffer): string {
  if (typeof message !== "string") return "";
  try {
    const { type } = JSON.parse(message) as { type?: unknown };
    return typeof type === "string" ? type : "";
  } catch {
    return "";
  }
}

/** A Turn's last Check and Build. */
type CheckAndBuild = { check: CheckReport; build: BuildReport };

/** Whether a Turn's last Check and Build leave the app broken. Failing tests don't (ADR 0018). */
const broken = ({ check, build }: CheckAndBuild) => check.counts.error > 0 || !build.ok;

/** The files' copy for a Turn (see `startTurn`). */
interface TurnCopy {
  startedAt: string;
  /** Whether the app had started when the files were copied. */
  appStarted: boolean;
  /** Set once the files have been put back. */
  undone?: boolean;
}

/** What a Turn's log line adds to its outcome. */
type TurnLog = Partial<TurnUsage> & { durationMs?: number };

/** A Turn's outcome when the Workspace restarted during it. */
function stoppedByRestart(): LastTurn {
  return { ...newLastTurn(), status: "aborted", error: restartedDuringTurn };
}

/** A Turn's outcome before it has one. */
function newLastTurn(): LastTurn {
  return {
    endedAt: "",
    status: "error",
    error: null,
    checkErrors: null,
    buildErrors: null,
    testFailures: null,
    retries: 0,
    outOfSteps: false,
    restored: false,
  };
}

interface TurnUsage {
  steps: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** The first problems, as many as fit in the report's budget. */
function withinBudget(problems: Problem[]): Problem[] {
  const kept: Problem[] = [];
  let bytes = 0;
  for (const problem of problems) {
    bytes += JSON.stringify(problem).length;
    if (bytes > reportBudgetBytes) break;
    kept.push(problem);
  }
  return kept;
}

function countTests(files: TestFileReport[]): TestCounts {
  const counts: TestCounts = { passed: 0, failed: 0, skipped: 0, todo: 0 };
  for (const file of files) for (const test of file.tests) counts[test.state] += 1;
  return counts;
}

function countBySeverity(problems: Problem[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { error: 0, warning: 0, suggestion: 0, message: 0 };
  for (const problem of problems) counts[problem.severity] += 1;
  return counts;
}
