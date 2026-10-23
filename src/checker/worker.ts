// The Checker as the main module of a Dynamic Worker, so a Check can run in
// an isolate of its own. The host passes ts-rust's compiled module in as
// `ts_rust.wasm`, and calls `Checker.check` over RPC once per tsconfig, so no
// two ts-rust instances are alive in one request.
import { WorkerEntrypoint } from "cloudflare:workers";
// Supplied by the host, as a wasm module, when it loads this Worker.
import tsRust from "./ts_rust.wasm";
import { check, type CheckResult } from "./index";

export class Checker extends WorkerEntrypoint {
  check(files: Record<string, string>, projects?: string[]): CheckResult {
    return check(new Map(Object.entries(files)), tsRust, projects ? { projects } : {});
  }
}

export default {
  fetch: () => new Response("Not used", { status: 404 }),
};
