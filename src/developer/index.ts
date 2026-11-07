import { DurableObject } from "cloudflare:workers";
import { newAppName } from "../shared/workspace-name";

/** What the start page shows for one Workspace. A type, not an interface, so it can type a row of the list's table. */
export type WorkspaceRecord = {
  id: string;
  name: string;
  /** The Template the app started from, or null until the Agent starts it (ADR 0018). */
  template: string | null;
  createdAt: string;
  /** When a Turn, or the Developer's own save, last changed the app. */
  changedAt: string;
  /** When the app was last published, or null if it never has been. */
  publishedAt: string | null;
};

// The list's schema version, in the key-value store. Version 2 added the times.
const schemaKey = "schema";
// False until every Workspace on a list made before version 2 has given it their times.
const backfilledKey = "schema:backfilled";

/**
 * One per Developer, named by their email: the list of their Workspaces
 * (ADR 0004). The Workspaces' files and Conversations live in their own
 * Durable Objects.
 */
export class Developer extends DurableObject<Env> {
  private backfilling: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // A Workspace with no Template yet keeps "" in its `template` column.
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, template TEXT NOT NULL, created_at TEXT NOT NULL)",
    );
    this.migrate();
  }

  /**
   * Adds the times to a list made before it kept them, each app starting as
   * changed when it was made. Reading the list fills in the rest (see
   * `backfill`).
   */
  migrate(): void {
    const { sql, kv } = this.ctx.storage;
    if (kv.get<number>(schemaKey) === 2) return;
    this.ctx.storage.transactionSync(() => {
      sql.exec("ALTER TABLE workspaces ADD COLUMN changed_at TEXT NOT NULL DEFAULT ''");
      sql.exec("ALTER TABLE workspaces ADD COLUMN published_at TEXT");
      sql.exec("UPDATE workspaces SET changed_at = created_at");
      kv.put(schemaKey, 2);
      kv.put(backfilledKey, sql.exec("SELECT 1 FROM workspaces LIMIT 1").toArray().length === 0);
    });
  }

  /**
   * Asks each Workspace on a list made before it kept the times when it was
   * last published and its last Turn ended. Each one also learns whose list
   * it's on, which a Workspace made before it recorded its Developer doesn't
   * know, so it keeps the times up to date from then on. A Workspace that
   * can't answer is asked again the next time the list is read.
   */
  private async backfill(): Promise<void> {
    const { sql, kv } = this.ctx.storage;
    const email = this.ctx.id.name;
    if (!email) return;
    const ids = sql.exec<{ id: string }>("SELECT id FROM workspaces").toArray();
    const answers = await Promise.all(
      ids.map(({ id }) =>
        this.env.WORKSPACES.getByName(id)
          .joinList(email)
          .then((times) => ({ id, ...times }), () => null),
      ),
    );
    for (const answer of answers) {
      // A publish or a change recorded meanwhile is newer than the answer.
      if (answer) {
        sql.exec(
          "UPDATE workspaces SET published_at = coalesce(published_at, ?), changed_at = max(changed_at, coalesce(?, '')) WHERE id = ?",
          answer.publishedAt,
          answer.changedAt,
          answer.id,
        );
      }
    }
    if (answers.every(Boolean)) kv.put(backfilledKey, true);
  }

  /** Most recently changed first. */
  async list(): Promise<WorkspaceRecord[]> {
    if (this.ctx.storage.kv.get<boolean>(backfilledKey) === false) {
      await (this.backfilling ??= this.backfill().finally(() => (this.backfilling = null)));
    }
    return this.select("ORDER BY changed_at DESC, rowid DESC");
  }

  get(id: string): WorkspaceRecord | null {
    return this.select("WHERE id = ?", id)[0] ?? null;
  }

  /** Adds a new Workspace, which counts as changed when it was made. */
  add(record: Omit<WorkspaceRecord, "changedAt" | "publishedAt">): WorkspaceRecord {
    this.ctx.storage.sql.exec(
      "INSERT INTO workspaces (id, name, template, created_at, changed_at) VALUES (?, ?, ?, ?, ?)",
      record.id,
      record.name,
      record.template ?? "",
      record.createdAt,
      record.createdAt,
    );
    return { ...record, changedAt: record.createdAt, publishedAt: null };
  }

  /** Gives the list the name and the Template the Agent chose when it started the app. */
  appStarted(id: string, name: string, template: string): void {
    this.ctx.storage.sql.exec("UPDATE workspaces SET name = ?, template = ? WHERE id = ?", name, template, id);
  }

  /** Lists a Workspace as it was before its app started, after undoing the Turn that started it (ADR 0018). */
  appForgotten(id: string): void {
    this.ctx.storage.sql.exec("UPDATE workspaces SET name = ?, template = '' WHERE id = ?", newAppName, id);
  }

  /** Renames a Workspace, to a name the caller has checked. Returns it as it is now, or null if there's no such Workspace. */
  rename(id: string, name: string): WorkspaceRecord | null {
    this.ctx.storage.sql.exec("UPDATE workspaces SET name = ? WHERE id = ?", name, id);
    return this.get(id);
  }

  /** Records that a Turn, or the Developer's own save, changed the app just now. */
  recordChange(id: string): void {
    this.ctx.storage.sql.exec("UPDATE workspaces SET changed_at = ? WHERE id = ?", new Date().toISOString(), id);
  }

  /** Records that the app was published at `publishedAt`. */
  recordPublish(id: string, publishedAt: string): void {
    this.ctx.storage.sql.exec("UPDATE workspaces SET published_at = ? WHERE id = ?", publishedAt, id);
  }

  remove(id: string): boolean {
    return this.ctx.storage.sql.exec("DELETE FROM workspaces WHERE id = ?", id).rowsWritten > 0;
  }

  private select(clause: string, ...bindings: string[]): WorkspaceRecord[] {
    return this.ctx.storage.sql
      .exec<WorkspaceRecord & { template: string }>(
        `SELECT id, name, template, created_at AS createdAt, changed_at AS changedAt, published_at AS publishedAt FROM workspaces ${clause}`,
        ...bindings,
      )
      .toArray()
      .map((record) => ({ ...record, template: record.template || null }));
  }
}
