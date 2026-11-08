import { DurableObject } from "cloudflare:workers";

/** A record as the store keeps it: its fields, and the ID the store gave it. */
export type Stored<T> = T & { id: string };

type Fields = { [field: string]: unknown };

/** The key-value storage `Records` keeps its records in: a Durable Object's `ctx.storage.kv`, or a stand-in in tests. */
export type RecordStorage = Pick<SyncKvStorage, "get" | "put" | "delete" | "list">;

const recordKey = (collection: string, id: string) => `records/${encodeURIComponent(collection)}/${id}`;
const lastTimeKey = "last-id-time";

/**
 * Records in named collections. `Store` keeps them in its own SQLite
 * database, through the key-value storage that a Durable Object's SQLite
 * holds; tests keep them in memory (see fake-store.ts).
 */
export class Records {
  constructor(private readonly storage: RecordStorage) {}

  add(collection: string, record: object): Stored<Fields> {
    const stored = { ...record, id: this.newId() };
    this.storage.put(recordKey(collection, stored.id), stored);
    return stored;
  }

  /** The collection's records, oldest first. */
  list(collection: string): Stored<Fields>[] {
    return [...this.storage.list<Stored<Fields>>({ prefix: recordKey(collection, "") })].map(([, record]) => record);
  }

  get(collection: string, id: string): Stored<Fields> | null {
    return this.storage.get<Stored<Fields>>(recordKey(collection, id)) ?? null;
  }

  /** Changes the fields given and keeps the rest. Null if there's no such record. */
  update(collection: string, id: string, changes: object): Stored<Fields> | null {
    const record = this.get(collection, id);
    if (!record) return null;
    const updated = { ...record, ...changes, id };
    this.storage.put(recordKey(collection, id), updated);
    return updated;
  }

  /** Whether there was such a record to remove. */
  remove(collection: string, id: string): boolean {
    return this.storage.delete(recordKey(collection, id));
  }

  // IDs sort in the order records were added, so `list` gives the oldest
  // first: the time in milliseconds, kept rising past the last ID's (the
  // clock doesn't move while a request runs), then random characters, so
  // nobody can guess another record's ID.
  private newId(): string {
    const time = Math.max(Date.now(), (this.storage.get<number>(lastTimeKey) ?? 0) + 1);
    this.storage.put(lastTimeKey, time);
    return `${time.toString(36).padStart(9, "0")}-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  }
}

/** The app's storage: one Durable Object instance, holding every collection. Reach it with `collection`. */
export class Store extends DurableObject {
  private readonly records = new Records(this.ctx.storage.kv);

  add(collection: string, record: object): Stored<Fields> {
    return this.records.add(collection, record);
  }

  list(collection: string): Stored<Fields>[] {
    return this.records.list(collection);
  }

  get(collection: string, id: string): Stored<Fields> | null {
    return this.records.get(collection, id);
  }

  update(collection: string, id: string, changes: object): Stored<Fields> | null {
    return this.records.update(collection, id, changes);
  }

  remove(collection: string, id: string): boolean {
    return this.records.remove(collection, id);
  }
}

/** The store's one instance. Renaming it starts the app's data afresh. */
const instance = "app";

/**
 * One collection of records, typed: `collection<Signup>(c.env.STORE, "signups")`.
 * A record's fields must be values that can be copied, such as strings,
 * numbers, booleans, arrays, plain objects and `Date`s.
 */
export function collection<T extends object>(store: DurableObjectNamespace<Store>, name: string) {
  const stub = store.getByName(instance);
  return {
    /** Keeps a new record, and returns it with its ID. */
    add: async (record: T) => (await stub.add(name, record)) as Stored<T>,
    /** Every record, oldest first. */
    list: async () => (await stub.list(name)) as Stored<T>[],
    /** The record with this ID, or null. */
    get: async (id: string) => (await stub.get(name, id)) as Stored<T> | null,
    /** Changes the fields given and keeps the rest. Returns the record, or null if there's no such record. */
    update: async (id: string, changes: Partial<T>) => (await stub.update(name, id, changes)) as Stored<T> | null,
    /** Removes the record. Returns whether there was one. */
    remove: async (id: string) => (await stub.remove(name, id)) as boolean,
  };
}
