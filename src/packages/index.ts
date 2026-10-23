import type { PackageStatus } from "../shared/check-report";
import { registryClient, type Registry } from "./registry";
import { manifestFields, newestVersion, noVersionMessage, resolve, type Manifest } from "./resolve";
import { downloadPackage } from "./tarball";

export type { PackageStatus };

/** The `package.json` that adds a Package, or why it can't be added. */
export type AddResult =
  | { ok: true; name: string; version: string; packageJson: string }
  | { ok: false; error: string };

interface InstallRecord {
  /** The dependency fields the installed Packages were resolved from. */
  fingerprint: string;
  outcome: "installed" | "failed";
  warnings: string[];
  error: string | null;
}

// Kept in the Durable Object's own key-value storage, which is part of its
// SQLite database (not Workers KV, which ADR 0004 rules out).
const recordKey = "packages:install";
const packageName = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/**
 * A Workspace's Packages, kept in its Durable Object's own SQLite, one row per
 * file (ADR 0004). An install resolves `package.json` once per change to its
 * dependency fields, and downloads only the Packages whose version changed.
 * Packages are never Workspace files.
 */
export class Packages {
  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS workspace_packages (name TEXT PRIMARY KEY, version TEXT NOT NULL)`);
    storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS workspace_package_files (name TEXT NOT NULL, path TEXT NOT NULL, content TEXT NOT NULL, PRIMARY KEY (name, path))`,
    );
  }

  /** What's installed, and how the last install went. */
  status(): PackageStatus {
    const record = this.storage.kv.get<InstallRecord>(recordKey);
    return {
      state: record?.outcome ?? "none",
      packages: this.storage.sql
        .exec<{ name: string; version: string }>("SELECT name, version FROM workspace_packages ORDER BY name")
        .toArray(),
      warnings: record?.warnings ?? [],
      error: record?.error ?? null,
    };
  }

  /** Every Package file, at `node_modules/<name>/<path>`, for the Builder. */
  snapshot(): Map<string, string> {
    return this.select("");
  }

  /** Only the files a Check reads: type declarations and each Package's package.json. */
  declarations(): Map<string, string> {
    return this.select(
      "WHERE path LIKE '%.d.ts' OR path LIKE '%.d.mts' OR path LIKE '%.d.cts' OR path = 'package.json' OR path LIKE '%/package.json'",
    );
  }

  private select(where: string): Map<string, string> {
    return new Map(
      this.storage.sql
        .exec<{ name: string; path: string; content: string }>(`SELECT name, path, content FROM workspace_package_files ${where}`)
        .toArray()
        .map(({ name, path, content }) => [`node_modules/${name}/${path}`, content]),
    );
  }

  /**
   * Installs what `packageJson` lists, unless that's already installed. A
   * failure is recorded, not thrown. With `retryFailed` false, a failed
   * install of the same dependency fields isn't tried again (a Check doesn't
   * wait on npm for something that failed before).
   */
  async install(
    packageJson: string,
    { registry = registryClient(), retryFailed = true }: { registry?: Registry; retryFailed?: boolean } = {},
  ): Promise<PackageStatus> {
    const manifest = parseManifest(packageJson);
    if (typeof manifest === "string") {
      this.storage.kv.put<InstallRecord>(recordKey, { fingerprint: "", outcome: "failed", warnings: [], error: manifest });
      return this.status();
    }
    const fingerprint = JSON.stringify(manifestFields.map((field) => Object.entries(manifest[field] ?? {}).sort()));
    const previous = this.storage.kv.get<InstallRecord>(recordKey);
    if (previous?.fingerprint === fingerprint && (previous.outcome === "installed" || !retryFailed)) return this.status();

    try {
      const { versions, warnings } = await resolve(manifest, registry);
      const installed = new Map(this.status().packages.map((p) => [p.name, p.version]));
      const wanted = [...versions.values()].filter((v) => installed.get(v.name) !== v.version);
      // Workers queue connections beyond six, so every download can start at once.
      const downloads = await Promise.all(
        wanted.map(async (version) => ({ version, download: await downloadPackage(version.dist.tarball, version.dist) })),
      );
      for (const { version, download } of downloads) {
        for (const { path, reason } of download.skipped) {
          if (reason === "too-large") warnings.push(`${version.name}@${version.version}: ${path} is too large to keep.`);
        }
      }

      this.storage.transactionSync(() => {
        for (const [name, version] of installed) {
          if (versions.get(name)?.version === version) continue;
          this.storage.sql.exec("DELETE FROM workspace_package_files WHERE name = ?", name);
          this.storage.sql.exec("DELETE FROM workspace_packages WHERE name = ?", name);
        }
        for (const { version, download } of downloads) {
          this.storage.sql.exec("INSERT INTO workspace_packages (name, version) VALUES (?, ?)", version.name, version.version);
          for (const [path, content] of download.files) {
            this.storage.sql.exec(
              "INSERT INTO workspace_package_files (name, path, content) VALUES (?, ?, ?)",
              version.name,
              path,
              content,
            );
          }
        }
        this.storage.kv.put<InstallRecord>(recordKey, { fingerprint, outcome: "installed", warnings, error: null });
      });
    } catch (error) {
      this.storage.kv.put<InstallRecord>(recordKey, {
        fingerprint,
        outcome: "failed",
        warnings: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return this.status();
  }

  /**
   * Works out the `package.json` that adds `name` at the newest version
   * that's at least a day old and matches `range`. `@types/` Packages go in
   * devDependencies unless `dev` says otherwise. Installing is the caller's
   * next step, once it has saved the file.
   */
  async add(
    packageJson: string,
    name: string,
    { range = "", dev, registry = registryClient() }: { range?: string; dev?: boolean; registry?: Registry } = {},
  ): Promise<AddResult> {
    if (!packageName.test(name)) return { ok: false, error: `${name} isn't a valid Package name.` };
    const manifest = parseManifest(packageJson);
    if (typeof manifest === "string") return { ok: false, error: manifest };
    const document = await registry.document(name);
    if (!document) return { ok: false, error: `${name} isn't in the npm registry.` };
    const version = await newestVersion(document, range, registry);
    if (!version) return { ok: false, error: noVersionMessage(document, range) };

    const field = (dev ?? name.startsWith("@types/")) ? "devDependencies" : "dependencies";
    for (const other of manifestFields) if (other !== field) delete manifest[other]?.[name];
    const entries = Object.entries({ ...manifest[field], [name]: version }).sort(([a], [b]) => a.localeCompare(b));
    manifest[field] = Object.fromEntries(entries);
    return { ok: true, name, version, packageJson: `${JSON.stringify(manifest, null, 2)}\n` };
  }
}

/** The parsed package.json, or why it can't be used. */
function parseManifest(packageJson: string): (Manifest & Record<string, unknown>) | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJson);
  } catch {
    return "package.json isn't valid JSON.";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "package.json isn't a JSON object.";
  for (const field of manifestFields) {
    const value = (parsed as Record<string, unknown>)[field];
    const isMap =
      value === undefined ||
      (value !== null && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((v) => typeof v === "string"));
    if (!isMap) return `package.json's ${field} must map Package names to versions.`;
  }
  return parsed as Manifest & Record<string, unknown>;
}
