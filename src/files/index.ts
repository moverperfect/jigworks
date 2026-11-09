import type { Workspace as FileStore } from "@cloudflare/think";
import { fromBase64 } from "../shared/base64";

/**
 * A Workspace's files: paths relative to the Workspace root, such as
 * `src/index.ts`. Our own interface in front of Cloudflare's file store
 * (ADR 0003), so moving to another store changes this module only. Reads are
 * synchronous, because the Checker and the Builder read synchronously. Writes
 * go through the store, so its directory rows and change events stay right for
 * Think's tools.
 */
export interface Files {
  /** Every Workspace file's path, sorted. Hidden paths are left out. */
  list(): string[];
  read(path: string): string | null;
  /** One file's bytes, for a file that may not be text. */
  readBytes(path: string): Uint8Array | null;
  /** Every Workspace file as text at this moment. Hidden paths are left out. */
  snapshot(): Map<string, string>;
  /** Every Workspace file as bytes, for files that may not be text. Hidden paths are left out. */
  bytes(): Map<string, Uint8Array>;
  /** Every Workspace file as text, or as bytes if it isn't UTF-8 text, as an image isn't. Hidden paths are left out. */
  contents(): Map<string, string | Uint8Array>;
  write(path: string, text: string): Promise<void>;
  /** Copies every Workspace file and directory aside, replacing the last copy. */
  copyAside(): void;
  /** Puts the files and directories back as they were copied, all at once. */
  restoreCopy(): void;
}

/** The largest file a Workspace or a Package keeps: one SQLite row holds at most 2 MB (ADR 0004). */
export const maxFileBytes = 1_900_000;

/**
 * Where the Workspace's files sit in the store. `@cloudflare/computer`, which
 * replaces the current store, uses `/workspace`.
 */
const root = "/";
const table = "cf_workspace_default";
// The copy `copyAside` makes of the store's rows, so `restoreCopy` puts them back as they were.
const copyTable = "workspace_copy";
// The store's rows that are Workspace files and directories: not its root, and not hidden (see `isHidden`).
// GLOB matches case, as `isHidden` does, so `Attachments/` stays a Workspace folder; LIKE wouldn't.
const workspaceRows = "path != '/' AND path != '/attachments' AND path NOT GLOB '/attachments/*'";

/**
 * Paths the Developer never sees, and that the zip export and the Check skip:
 * Think keeps Conversation attachments under `attachments/` in the same store.
 */
export function isHidden(path: string): boolean {
  return path === "attachments" || path.startsWith("attachments/");
}

/** Rejects paths that could escape the Workspace or aren't plain relative paths. */
export function normalisePath(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter((part) => part !== "" && part !== ".");
  if (parts.length === 0 || parts.some((part) => part === "..")) throw new Error(`Not a Workspace path: ${path}`);
  return parts.join("/");
}

const toStore = (path: string) => `${root}${normalisePath(path)}`;
const fromStore = (path: string) => path.slice(root.length);

type Row = { path: string; content: string | null; content_encoding: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytesOf = (row: Row) => (row.content_encoding === "base64" ? fromBase64(row.content ?? "") : encoder.encode(row.content ?? ""));
const textOf = (row: Row) =>
  row.content_encoding === "base64" ? decoder.decode(bytesOf(row)) : (row.content ?? "");

/**
 * A file's text, or its bytes if they aren't UTF-8 text. The editor and the
 * Build's assets keep a byte order mark, so a file saved back or served is
 * unchanged; the Build's code and config drop it, as `snapshot` does, so JSON
 * config still parses.
 */
export function textOrBytes(bytes: Uint8Array, { keepBom = false } = {}): string | Uint8Array {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: keepBom }).decode(bytes);
  } catch {
    return bytes;
  }
}

/**
 * Files kept in `@cloudflare/shell`'s store, the one Think uses. Reads query
 * its table directly. It stores text as UTF-8, and as base64 when Think's bash
 * writes a file back.
 */
export function storeFiles(store: FileStore, storage: DurableObjectStorage): Files {
  const { sql } = storage;
  const select = <T extends { path: string }>(columns: string, where = "", ...bindings: string[]): T[] => {
    try {
      return sql
        .exec<T>(`SELECT ${columns} FROM ${table} WHERE type = 'file' ${where} ORDER BY path`, ...bindings)
        .toArray()
        .filter((row) => !isHidden(fromStore(row.path)));
    } catch (error) {
      // The store creates its table on first use.
      if (String(error).includes("no such table")) return [];
      throw error;
    }
  };
  const rows = (where = "", ...bindings: string[]) => select<Row>("path, content, content_encoding", where, ...bindings);

  const exists = (name: string) => sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray().length > 0;

  return {
    list: () => select<{ path: string }>("path").map((row) => fromStore(row.path)),
    readBytes: (path) => {
      const [row] = rows("AND path = ?", toStore(path));
      return row ? bytesOf(row) : null;
    },
    read: (path) => {
      const [row] = rows("AND path = ?", toStore(path));
      return row ? textOf(row) : null;
    },
    snapshot: () => new Map(rows().map((row) => [fromStore(row.path), textOf(row)])),
    bytes: () => new Map(rows().map((row) => [fromStore(row.path), bytesOf(row)])),
    // Think's bash writes back every file it changed as base64, text included.
    contents: () =>
      new Map(
        rows().map((row) => {
          const path = fromStore(row.path);
          const content = row.content_encoding === "base64" ? textOrBytes(bytesOf(row), { keepBom: path.startsWith("public/") }) : (row.content ?? "");
          return [path, content];
        }),
      ),
    write: (path, content) => store.writeFile(toStore(path), content),
    copyAside: () => {
      sql.exec(`DROP TABLE IF EXISTS ${copyTable}`);
      // The store creates its table on first use, so before then there's nothing to copy.
      if (exists(table)) sql.exec(`CREATE TABLE ${copyTable} AS SELECT * FROM ${table} WHERE ${workspaceRows}`);
    },
    restoreCopy: () => {
      if (!exists(table)) return;
      // In one transaction, so a restart can't leave the files half put back.
      storage.transactionSync(() => {
        sql.exec(`DELETE FROM ${table} WHERE ${workspaceRows}`);
        if (exists(copyTable)) sql.exec(`INSERT INTO ${table} SELECT * FROM ${copyTable}`);
      });
    },
  };
}
