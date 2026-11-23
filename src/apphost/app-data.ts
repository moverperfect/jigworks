// App data (ADR 0015). A Dynamic Worker can't be given a real Durable Object
// namespace, so the app host loads the app through a module of its own. It
// puts a stand-in for each Durable Object binding in `env`, for the app's
// default export and for the classes the bindings name. The stand-in's stubs
// send `fetch` and RPC calls to the app host, through `AppData`, which runs
// each instance as a facet.

/** The name of the module the app host loads in place of the app's own. */
export const appDataModule = "jigworks-app-data.js";

/** The start of every name the platform puts in an app's env, and of its own methods and table in an app's instances, which apps can't use themselves. */
export const platformEnvPrefix = "__jigworks";

/** The env key `AppData` arrives under, which the stand-ins call. */
export const appDataBinding = `${platformEnvPrefix}_app_data`;

/** The method the app host wakes an instance with when its alarm may be due (ADR 0021). `alarm` itself can't be called over RPC. */
export const ringMethod = `${platformEnvPrefix}_ring`;

/** The table in each instance's own database that holds its alarm (ADR 0021). */
export const alarmTable = `${platformEnvPrefix}_alarm`;

/** What an instance answers a wake with: its alarm's time now, or null, and the error `alarm()` threw, if it rang and threw. */
export interface RingAnswer {
  next: number | null;
  error: string | null;
}

/** The module that wraps the app's `mainModule`, giving it its `durableObjects` bindings. */
export function appDataWrapper(mainModule: string, durableObjects: Record<string, string>): string {
  const classes = [...new Set(Object.values(durableObjects))];
  // Everything here is declared inside a function, and the classes are exported
  // under the app's names, so no class name can clash with the module's own.
  return `import * as app from ${JSON.stringify(`./${mainModule}`)};

const { withBindings, classes } = ((bindings, appData, ringMethod, alarmTable) => {
  // A stable 64-character hex ID for a name, as idFromName gives.
  function hexOf(text) {
    let hex = "";
    for (let seed = 1; seed <= 8; seed++) {
      let hash = 0x811c9dc5 ^ seed;
      for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
      hex += (hash >>> 0).toString(16).padStart(8, "0");
    }
    return hex;
  }

  class Id {
    #hex;
    constructor(hex, name) {
      this.#hex = hex;
      this.name = name;
    }
    toString() {
      return this.#hex;
    }
    equals(other) {
      return String(other) === this.#hex;
    }
  }

  function stub(data, binding, id) {
    const call = (method, args) => data.callFacet(binding, String(id), id.name ?? null, method, args);
    return new Proxy(
      {},
      {
        get(_, key) {
          if (key === "id") return id;
          if (key === "name") return id.name;
          if (typeof key === "symbol" || key === "then") return undefined;
          if (key === "fetch") return (input, init) => call("fetch", [new Request(input, init)]);
          return (...args) => call(key, args);
        },
      },
    );
  }

  function namespace(data, binding) {
    return {
      newUniqueId: () => new Id([...crypto.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, "0")).join("")),
      idFromName: (name) => new Id(hexOf(String(name)), String(name)),
      idFromString(id) {
        if (!/^[0-9a-f]{64}$/.test(id)) throw new TypeError("Invalid Durable Object ID: " + id);
        return new Id(id);
      },
      get: (id) => stub(data, binding, id),
      getByName(name) {
        return stub(data, binding, this.idFromName(name));
      },
    };
  }

  function withBindings(env) {
    const { [appData]: data, ...rest } = env;
    for (const binding of bindings) rest[binding] = namespace(data, binding);
    return rest;
  }

  // An instance's alarm (ADR 0021). Facets can't set alarms of their own, so
  // the app host keeps a row that wakes the instance, and the instance's own
  // database holds the alarm itself, which commits with the call's other
  // writes, or is lost with them.
  function alarms(ctx, data, hasAlarm) {
    // Should props ever not reach the instance, only setAlarm fails.
    const { binding, id, name } = ctx.props ?? {};
    const sql = ctx.storage.sql;
    // setAlarm, getAlarm and deleteAlarm run one at a time, in the order they
    // were called, so calls made without await keep their order, as on Cloudflare.
    let queue = Promise.resolve();
    const inTurn = (step) => {
      const run = queue.then(step);
      queue = run.catch(() => {});
      return run;
    };
    // The time a setAlarm is telling the app host, which a wake reports so its row stays.
    let telling = null;
    const stored = () =>
      sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", alarmTable).toArray().length === 0
        ? null
        : (sql.exec("SELECT at FROM " + alarmTable).toArray()[0]?.at ?? null);
    const clear = () => {
      if (stored() !== null) sql.exec("DELETE FROM " + alarmTable);
    };
    const methods = {
      async setAlarm(time) {
        const at = time instanceof Date ? time.getTime() : time;
        if (typeof at !== "number" || !Number.isFinite(at)) throw new TypeError("setAlarm() takes a time in milliseconds since the epoch, or a Date.");
        // Cloudflare's own message.
        if (!hasAlarm) throw new Error("Your Durable Object class must have an alarm() handler in order to call setAlarm()");
        return inTurn(async () => {
          // The app host first: if it can't be told, nothing is written.
          telling = at;
          try {
            await data.setAlarm(binding, id, name, at);
          } finally {
            telling = null;
          }
          sql.exec("CREATE TABLE IF NOT EXISTS " + alarmTable + " (at INTEGER NOT NULL)");
          sql.exec("DELETE FROM " + alarmTable);
          sql.exec("INSERT INTO " + alarmTable + " (at) VALUES (?)", at);
        });
      },
      getAlarm: () => inTurn(stored),
      deleteAlarm: () => inTurn(clear),
    };
    for (const [key, value] of Object.entries(methods)) Object.defineProperty(ctx.storage, key, { value, configurable: true, writable: true });

    return {
      // Rings alarm() only if the instance's own alarm is due: a wake for a
      // call that failed or a deleted alarm finds none.
      async ring(alarm) {
        let error = null;
        const at = stored();
        if (at !== null && at <= Date.now()) {
          // getAlarm() reads null while alarm() runs, unless it sets the next.
          clear();
          // Retries come with #146.
          try {
            await alarm({ retryCount: 0, isRetry: false });
          } catch (thrown) {
            error = thrown instanceof Error ? thrown.name + ": " + thrown.message : String(thrown);
          }
        }
        const times = [stored(), telling].filter((time) => time !== null);
        return { next: times.length === 0 ? null : Math.min(...times), error };
      },
    };
  }

  const classes = {};
  for (const name of ${JSON.stringify(classes)}) {
    const hasAlarm = typeof app[name].prototype.alarm === "function";
    classes[name] = class extends app[name] {
      #alarms;
      constructor(ctx, env) {
        const kept = alarms(ctx, env[appData], hasAlarm);
        super(ctx, withBindings(env));
        this.#alarms = kept;
      }
      [ringMethod]() {
        return this.#alarms.ring((info) => this.alarm(info));
      }
    };
  }
  return { withBindings, classes };
})(${JSON.stringify(Object.keys(durableObjects))}, ${JSON.stringify(appDataBinding)}, ${JSON.stringify(ringMethod)}, ${JSON.stringify(alarmTable)});

// The platform only ever sends the app requests.
export default typeof app.default === "function"
  ? class extends app.default {
      constructor(ctx, env) {
        super(ctx, withBindings(env));
      }
    }
  : { fetch: (request, env, ctx) => app.default.fetch(request, withBindings(env), ctx) };
${classes.map((name, index) => `const class${index} = classes[${JSON.stringify(name)}];\nexport { class${index} as ${name} };`).join("\n")}
`;
}
