import { fakeStore } from "./fake-store";
import { ReminderList, type Reminders } from "./reminders";
import type { Records } from "./store";

/**
 * A stand-in for the `REMINDERS` binding in tests, which don't get Durable
 * Object bindings: no reminders, kept in memory, and none ever sent. Pass it
 * in the test's `env`, as `{ STORE: fakeStore(), REMINDERS: fakeReminders() } as Env`.
 */
export function fakeReminders(): DurableObjectNamespace<Reminders> {
  // The fake store's instance is its records, kept in memory.
  const list = new ReminderList(fakeStore().getByName("app") as unknown as Records);
  return { getByName: () => list } as unknown as DurableObjectNamespace<Reminders>;
}
