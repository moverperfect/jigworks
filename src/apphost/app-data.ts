// App data (ADR 0006). A Dynamic Worker can't be given a real Durable Object
// namespace, so the app host loads the app through a module of its own. It
// puts a stand-in for each Durable Object binding in `env`, for the app's
// default export and for the classes the bindings name. The stand-in's stubs
// send `fetch` and RPC calls to the app host, through `AppData`, which runs
// each instance as a facet.

/** The name of the module the app host loads in place of the app's own. */
export const appDataModule = "jigworks-app-data.js";

/** The env key `AppData` arrives under, which the stand-ins call. */
export const appDataBinding = "__jigworks_app_data";

/** The module that wraps the app's `mainModule`, giving it its `durableObjects` bindings. */
export function appDataWrapper(mainModule: string, durableObjects: Record<string, string>): string {
  const classes = [...new Set(Object.values(durableObjects))];
  return `import * as app from ${JSON.stringify(`./${mainModule}`)};

const bindings = ${JSON.stringify(Object.keys(durableObjects))};

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
  return new Proxy(
    {},
    {
      get(_, key) {
        if (key === "id") return id;
        if (key === "name") return id.name;
        if (typeof key === "symbol" || key === "then") return undefined;
        if (key === "fetch") return (input, init) => data.fetchFacet(binding, String(id), new Request(input, init));
        return (...args) => data.callFacet(binding, String(id), key, args);
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

const wrapped = new WeakMap();
function withBindings(env) {
  if (!env || !env[${JSON.stringify(appDataBinding)}]) return env;
  let result = wrapped.get(env);
  if (!result) {
    const { [${JSON.stringify(appDataBinding)}]: data, ...rest } = env;
    for (const binding of bindings) rest[binding] = namespace(data, binding);
    wrapped.set(env, (result = rest));
  }
  return result;
}

export * from ${JSON.stringify(`./${mainModule}`)};

const main = app.default;
const handlers = ["fetch", "scheduled", "queue", "email", "tail", "trace"];
export default typeof main === "function"
  ? class extends main {
      constructor(ctx, env) {
        super(ctx, withBindings(env));
      }
    }
  : Object.fromEntries(
      handlers
        .filter((handler) => typeof main?.[handler] === "function")
        .map((handler) => [handler, (event, env, ctx) => main[handler](event, withBindings(env), ctx)]),
    );
${classes
  .map(
    (name) => `
export class ${name} extends app.${name} {
  constructor(ctx, env) {
    super(ctx, withBindings(env));
  }
}`,
  )
  .join("\n")}
`;
}
