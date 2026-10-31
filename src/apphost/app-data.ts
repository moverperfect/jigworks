// App data (ADR 0015). A Dynamic Worker can't be given a real Durable Object
// namespace, so the app host loads the app through a module of its own. It
// puts a stand-in for each Durable Object binding in `env`, for the app's
// default export and for the classes the bindings name. The stand-in's stubs
// send `fetch` and RPC calls to the app host, through `AppData`, which runs
// each instance as a facet.

/** The name of the module the app host loads in place of the app's own. */
export const appDataModule = "jigworks-app-data.js";

/** The start of every name the platform puts in an app's env, which apps can't use themselves. */
export const platformEnvPrefix = "__jigworks";

/** The env key `AppData` arrives under, which the stand-ins call. */
export const appDataBinding = `${platformEnvPrefix}_app_data`;

/** The module that wraps the app's `mainModule`, giving it its `durableObjects` bindings. */
export function appDataWrapper(mainModule: string, durableObjects: Record<string, string>): string {
  const classes = [...new Set(Object.values(durableObjects))];
  // Everything here is declared inside a function, and the classes are exported
  // under the app's names, so no class name can clash with the module's own.
  return `import * as app from ${JSON.stringify(`./${mainModule}`)};

const { withBindings, classes } = ((bindings, appData) => {
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

  const classes = {};
  for (const name of ${JSON.stringify(classes)}) {
    classes[name] = class extends app[name] {
      constructor(ctx, env) {
        super(ctx, withBindings(env));
      }
    };
  }
  return { withBindings, classes };
})(${JSON.stringify(Object.keys(durableObjects))}, ${JSON.stringify(appDataBinding)});

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
