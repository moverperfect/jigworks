// Records how far each WebAssembly module's linear memory grew. Linear memory
// never shrinks, so an instance's size when it's replaced, or at the end of a
// step, is its peak. It doesn't cover the JavaScript heap, which workerd
// doesn't expose.
//
// It must not keep old instances alive: a Check runs ts-rust once per
// tsconfig, with a new instance each time, and holding the previous one
// would put both instances' memory in the isolate at once. So it holds only
// the newest instance per module, reads the previous one's size as it lets it
// go, and keeps nothing but weak references between steps.

const newest = new Map<string, WebAssembly.Instance>();
const between = new Map<string, WeakRef<WebAssembly.Instance>>();
const peaks = new Map<string, number>();
let labelOf: (module: WebAssembly.Module) => string = () => "unknown";
let installed = false;

function record(module: WebAssembly.Module, instance: WebAssembly.Instance) {
  const label = labelOf(module);
  const previous = newest.get(label);
  if (previous) peaks.set(label, Math.max(peaks.get(label) ?? 0, memoryOf(previous)));
  newest.set(label, instance);
}

/** Starts recording. `label` names a module, for example "ts-rust". */
export function trackWasm(label: (module: WebAssembly.Module) => string): void {
  labelOf = label;
  if (installed) return;
  installed = true;

  const OriginalInstance = WebAssembly.Instance;
  const Instance = function (module: WebAssembly.Module, imports?: WebAssembly.Imports) {
    const instance = new OriginalInstance(module, imports);
    record(module, instance);
    return instance;
  } as unknown as typeof WebAssembly.Instance;
  Instance.prototype = OriginalInstance.prototype;
  (WebAssembly as { Instance: unknown }).Instance = Instance;

  const originalInstantiate = WebAssembly.instantiate.bind(WebAssembly);
  (WebAssembly as { instantiate: unknown }).instantiate = async (source: unknown, imports?: WebAssembly.Imports) => {
    const result = (await originalInstantiate(source as WebAssembly.Module, imports)) as
      | WebAssembly.Instance
      | { module: WebAssembly.Module; instance: WebAssembly.Instance };
    if (result instanceof OriginalInstance) record(source as WebAssembly.Module, result);
    else record(result.module, result.instance);
    return result;
  };
}

/**
 * Peak bytes of linear memory per module during the step that just ended.
 * A module with no new instance in the step reports its live instance's
 * size, if one is still alive (esbuild keeps one for the isolate's lifetime).
 */
export function takeWasmMemory(): Record<string, number> {
  for (const [label, instance] of newest) {
    peaks.set(label, Math.max(peaks.get(label) ?? 0, memoryOf(instance)));
    between.set(label, new WeakRef(instance));
  }
  for (const [label, ref] of between) {
    const instance = ref.deref();
    if (instance && !peaks.has(label)) peaks.set(label, memoryOf(instance));
  }
  const sizes = Object.fromEntries(peaks);
  newest.clear();
  peaks.clear();
  return sizes;
}

function memoryOf(instance: WebAssembly.Instance): number {
  let bytes = 0;
  for (const value of Object.values(instance.exports)) {
    if (value instanceof WebAssembly.Memory) bytes += value.buffer.byteLength;
  }
  return bytes;
}
