The app keeps its records in `STORE`, a Durable Object whose code is in `src/server/store.ts`. Use it for anything the app remembers, rather than a Durable Object of your own.

- **A collection** holds one kind of record. Declare the record's type, then reach the collection by name: `const signups = collection<Signup>(c.env.STORE, "signups");`.
- **Its methods** all return promises:
  - `add(record)` keeps a new record and returns it with its `id`;
  - `list()` returns every record, oldest first;
  - `get(id)` returns one, or `null`;
  - `update(id, changes)` changes the fields given, keeps the rest, and returns the record, or `null` if there's no such record;
  - `remove(id)` removes one, and returns whether there was one.
- **Fields** must be values that can be copied: strings, numbers, booleans, arrays, plain objects and `Date`s. Not functions or class instances.
- **Filter and sort** the list in code, such as `(await signups.list()).filter((s) => s.coming)`. The store suits the few thousand records of an app like a sign-up sheet.
- **Changing several records at once,** so nothing can happen in between (such as taking the last place on a list), is a method on `Store` that works on `this.records` directly: its calls run one at a time, so nothing interleaves.
- **Renaming** a collection starts it empty. So does renaming the `STORE` binding, or the instance name in `store.ts`.
- **Tests** don't get the `STORE` binding. `fakeStore()`, from `src/server/fake-store.ts`, is an empty store kept in memory: give it to `collection`, as `src/server/store.test.ts` does, or pass it in a route's test, as `app.request(path, init, { STORE: fakeStore() } as Env)`.
