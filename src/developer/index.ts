import { DurableObject } from "cloudflare:workers";

/** What the start page shows for one Workspace. */
export interface WorkspaceRecord {
  id: string;
  name: string;
  /** The Template the app started from, or null until the Agent starts it (ADR 0018). */
  template: string | null;
  createdAt: string;
}

/**
 * One per Developer, named by their email: the list of their Workspaces
 * (ADR 0004). The Workspaces' files and Conversations live in their own
 * Durable Objects.
 */
export class Developer extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // A Workspace with no Template yet keeps "" in its `template` column.
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, template TEXT NOT NULL, created_at TEXT NOT NULL)",
    );
  }

  /** Newest first. */
  list(): WorkspaceRecord[] {
    return this.select("ORDER BY created_at DESC, rowid DESC");
  }

  get(id: string): WorkspaceRecord | null {
    return this.select("WHERE id = ?", id)[0] ?? null;
  }

  add(record: WorkspaceRecord): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO workspaces (id, name, template, created_at) VALUES (?, ?, ?, ?)",
      record.id,
      record.name,
      record.template ?? "",
      record.createdAt,
    );
  }

  /** Gives the list the name and the Template the Agent chose when it started the app. */
  appStarted(id: string, name: string, template: string): void {
    this.ctx.storage.sql.exec("UPDATE workspaces SET name = ?, template = ? WHERE id = ?", name, template, id);
  }

  remove(id: string): boolean {
    return this.ctx.storage.sql.exec("DELETE FROM workspaces WHERE id = ?", id).rowsWritten > 0;
  }

  private select(clause: string, ...bindings: string[]): WorkspaceRecord[] {
    return this.ctx.storage.sql
      .exec<{ id: string; name: string; template: string; created_at: string }>(
        `SELECT id, name, template, created_at FROM workspaces ${clause}`,
        ...bindings,
      )
      .toArray()
      .map(({ id, name, template, created_at }) => ({ id, name, template: template || null, createdAt: created_at }));
  }
}
