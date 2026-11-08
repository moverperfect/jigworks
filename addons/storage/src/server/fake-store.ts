import { Records, type RecordStorage, type Store } from "./store";

/**
 * A stand-in for the `STORE` binding in tests, which don't get Durable Object
 * bindings: an empty store, kept in memory. Pass it in the test's `env`, as
 * `{ STORE: fakeStore() } as Env`.
 */
export function fakeStore(): DurableObjectNamespace<Store> {
  // Values are copied in and out, as Durable Object storage and calls copy them.
  const values = new Map<string, unknown>();
  const storage: RecordStorage = {
    get: <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
    put: (key, value) => void values.set(key, structuredClone(value)),
    delete: (key) => values.delete(key),
    list: <T>({ prefix = "" } = {}) =>
      [...values.keys()]
        .filter((key) => key.startsWith(prefix))
        .sort()
        .map((key): [string, T] => [key, structuredClone(values.get(key)) as T]),
  };
  const records = new Records(storage);
  return { getByName: () => records } as unknown as DurableObjectNamespace<Store>;
}
