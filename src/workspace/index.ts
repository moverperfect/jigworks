import {
  Think,
  Workspace as FileStore,
  type ChatRecoveryOptions,
  type StepContext,
  type ThinkSession,
  type ToolCallContext,
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
  fixMessage,
  developerMessage,
  instructions,
  summarise,
  turnProviderOptions,
  withAgentsMd,
} from "../agent";
import {
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
import type { CheckReport, Problem, Severity } from "../shared/check-report";
import { idleState, maxRetries, type ConversationState, type LastTurn } from "../shared/conversation";

export type { CheckReport };

/** A Workspace file for the editor: its text, or word that it isn't text. */
export type OpenedFile = { text: string } | { binary: true };

/** What came of a change the Developer asked for. It's refused, as `busy`, while a Turn runs. */
export type DeveloperChange<T = object> = ({ ok: true } & T) | { ok: false; error: string; busy?: true };

/** What came of adding a Package, for the Developer or the Agent. */
export type PackageAdded = DeveloperChange<{ version: string; status: PackageStatus }>;

const checkKey = "check:latest";
const buildKey = "build:latest";
// The app's label, which names its app host and its hostnames (ADR 0012).
const appLabelKey = "app:label";
// The hash of the last Build the app host took, so a cached Build isn't sent again.
const appSentKey = "app:sent";
// The Build waiting to follow the Developer's last save, so a burst of saves makes one Build.
const saveBuildKey = "build:after-save";
const saveBuildDelaySeconds = 1;
const changedKey = "turn:developer-changes";
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
const waitingTools = new Set(["check", "build"]);

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

  private readonly files: Files = storeFiles(this.workspace, this.ctx.storage.sql);
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

  /**
   * A Turn or Start fresh can't outlive the isolate it ran in (see
   * `onChatRecovery`), so a new isolate starts idle, and says how a Turn the
   * old one was running ended.
   */
  override async onStart(): Promise<void> {
    const { turn, startingFresh } = this.state;
    if (!turn && !startingFresh) return;
    const stopped: LastTurn = {
      endedAt: new Date().toISOString(),
      status: "aborted",
      error: "The Workspace restarted during the Turn.",
      checkErrors: null,
      buildErrors: null,
      retries: 0,
      outOfSteps: false,
    };
    this.setState({ turn: null, startingFresh: false, lastTurn: turn ? stopped : this.state.lastTurn });
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
      check: async () => {
        await this.otherToolsFinished();
        return this.check("agent");
      },
      build: async () => {
        await this.otherToolsFinished();
        return this.buildInItsOwnCall("agent");
      },
      addPackageForAgent: (name, options) => this.addPackageForAgent(name, options),
      requestPreview: (init) => this.requestPreview(init),
      previewLogs: (limit) => this.previewLogs(limit),
    });
  }

  override beforeTurn(ctx: TurnContext): TurnConfig {
    return {
      instructions: withAgentsMd(ctx.system, this.files.read("AGENTS.md")),
      // A retry gets the steps the Turn has left.
      maxSteps: turnSteps - (this.turnUsage?.steps ?? 0),
      providerOptions: turnProviderOptions,
    };
  }

  override beforeToolCall(ctx: ToolCallContext): void {
    if (!waitingTools.has(ctx.toolName)) this.toolsRunning += 1;
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

  /** Fills a new Workspace with its Template's files, and installs their Packages. */
  async initialise(files: Record<string, string>, name = ""): Promise<void> {
    if (this.files.list().length > 0) throw new Error(`Workspace ${this.name} already has files`);
    this.ctx.storage.kv.put(appLabelKey, newAppLabel(name));
    for (const [path, text] of Object.entries(files)) await this.files.write(path, text);
    await this.installPackages();
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
      const snapshot = new Map([...this.files.snapshot(), ...this.packages.declarations()]);
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
   * Where the Preview answers, and whether it has a Build to run. A Workspace
   * whose successful Build predates its app host builds once more, from the
   * cache, to send it there.
   */
  async preview(): Promise<{ url: string; ready: boolean }> {
    let ready = await this.previewReady();
    if (!ready && (await this.latestBuild())?.ok) {
      await this.buildInItsOwnCall("preview");
      ready = await this.previewReady();
    }
    return { url: `https://${previewHost(this.appLabel(), this.env.APPS_DOMAIN)}/`, ready };
  }

  private async previewReady(): Promise<boolean> {
    return (await this.env.APP_HOSTS.getByName(this.appLabel()).previewHash()) !== null;
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
    return this.env.APP_HOSTS.getByName(this.appLabel()).requestPreview(init);
  }

  /** Deletes the app's app host, before the Workspace itself is deleted (ADR 0009). */
  async removeApp(): Promise<void> {
    const label = this.ctx.storage.kv.get<string>(appLabelKey);
    if (label) await this.env.APP_HOSTS.getByName(label).remove(this.name);
  }

  /** The Preview's newest server logs and front-end errors, for the Agent's `preview_logs` tool. */
  async previewLogs(limit?: number): Promise<AppLogEntry[]> {
    return this.env.APP_HOSTS.getByName(this.appLabel()).logs("preview", limit);
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
      await this.files.write(normalised, text);
      this.noteDeveloperChange(normalised);
      if (normalised === "package.json") await this.install();
      return { ok: true };
    });
    if (result.ok) await this.buildSoon();
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

  /** Installs what `package.json` lists, unless that's already installed. */
  async installPackages(): Promise<PackageStatus> {
    return this.exclusive(() => this.install());
  }

  /** What's installed, and how the last install went. */
  async packageStatus(): Promise<PackageStatus> {
    return this.packages.status();
  }

  /** Adds a Package for the Developer, unless a Turn is running. The next Turn is told `package.json` changed. */
  async addPackage(name: string, options: AddOptions = {}): Promise<PackageAdded> {
    return this.addPackageFor("developer", name, options);
  }

  /** Adds a Package for the Agent's `add_package` tool, during its Turn. */
  async addPackageForAgent(name: string, options: AddOptions): Promise<PackageAdded> {
    return this.addPackageFor("agent", name, options);
  }

  /** Adds a Package at the newest version that's at least a day old, saves `package.json`, and installs. */
  private addPackageFor(by: "developer" | "agent", name: string, options: AddOptions): Promise<PackageAdded> {
    return this.exclusive(async () => {
      if (by === "developer" && this.state.turn) return busy;
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
  async startTurn(text: string): Promise<DeveloperChange> {
    // In line with Package work, so a save or an add that arrived first lands
    // before the lock, and the Turn is told about it.
    return this.exclusive(async () => {
      if (this.state.turn || this.state.startingFresh) return busy;
      const startedAt = new Date().toISOString();
      this.setState({ ...this.state, turn: { startedAt } });
      // The Turn runs in an alarm of its own, which ends when the Turn does,
      // so its logs reach Workers Logs. Run in the background of this call
      // instead, they never did.
      await this.schedule(0, "driveTurn", { text, startedAt }, { retry: { maxAttempts: 1 } });
      return { ok: true };
    });
  }

  /**
   * Runs the Turn `startTurn` scheduled, unless a restart has ended it since
   * (see `onStart`), so an alarm retried after a restart doesn't send the
   * Developer's message twice. Only `startTurn` schedules it.
   */
  async driveTurn({ text, startedAt }: { text: string; startedAt: string }): Promise<void> {
    if (this.state.turn?.startedAt === startedAt) await this.runDeveloperTurn(text);
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
  private async runDeveloperTurn(text: string): Promise<void> {
    const started = Date.now();
    const usage: TurnUsage = (this.turnUsage = { steps: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    let lastTurn: LastTurn = {
      endedAt: "",
      status: "error",
      error: null,
      checkErrors: null,
      buildErrors: null,
      retries: 0,
      outOfSteps: false,
    };
    try {
      const changed = this.ctx.storage.kv.get<string[]>(changedKey) ?? [];
      this.ctx.storage.kv.delete(changedKey);
      let result = await this.saveMessages([developerMessage(text, changed)]);
      let ended = await this.endOfTurn();
      while (
        result.status === "completed" &&
        (ended.check.counts.error > 0 || !ended.build.ok) &&
        lastTurn.retries < maxRetries &&
        usage.steps < turnSteps
      ) {
        lastTurn.retries += 1;
        result = await this.saveMessages([fixMessage(ended.check, ended.build, lastTurn.retries)]);
        ended = await this.endOfTurn();
      }
      lastTurn = {
        ...lastTurn,
        status: result.status,
        error: result.error ?? null,
        checkErrors: ended.check.counts.error,
        buildErrors: ended.build.errors.length,
        outOfSteps: usage.steps >= turnSteps,
      };
    } catch (error) {
      lastTurn.error = error instanceof Error ? error.message : String(error);
      // The Agent may have changed files before the failure, and every Turn
      // ends with a Check and a Build.
      const ended = await this.endOfTurn().catch(() => null);
      lastTurn.checkErrors = ended?.check.counts.error ?? null;
      lastTurn.buildErrors = ended?.build.errors.length ?? null;
    } finally {
      this.turnUsage = null;
      lastTurn.endedAt = new Date().toISOString();
      // The clock moves only at I/O, so this leaves out the last Check.
      console.log(JSON.stringify({ event: "turn", workspace: this.name, durationMs: Date.now() - started, ...lastTurn, ...usage }));
      this.setState({ ...this.state, turn: null, lastTurn });
    }
  }

  /** A Turn's Check, then its Build, which goes ahead whatever the Check found. */
  private async endOfTurn(): Promise<{ check: CheckReport; build: BuildReport }> {
    const check = await this.check("turn");
    return { check, build: await this.buildInItsOwnCall("turn") };
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

function countBySeverity(problems: Problem[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { error: 0, warning: 0, suggestion: 0, message: 0 };
  for (const problem of problems) counts[problem.severity] += 1;
  return counts;
}
