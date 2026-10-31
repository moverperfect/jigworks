// The Test bundler as the main module of a Dynamic Worker (ADR 0017): it
// bundles a Workspace's tests with esbuild in an isolate of its own, so
// esbuild's memory, which it never gives back, stays out of the Workspace's
// Durable Object (ADR 0010). The host passes esbuild's compiled module in as
// `esbuild.wasm`, where worker-bundler imports it from.
import { WorkerEntrypoint } from "cloudflare:workers";
import { bundleTests, type TestBundleResult } from "../builder/tests";

export class TestBundler extends WorkerEntrypoint {
  bundle(files: Record<string, string>, testFiles: string[], virtualModules: Record<string, string>): Promise<TestBundleResult> {
    return bundleTests(new Map(Object.entries(files)), testFiles, virtualModules);
  }
}

export default {
  fetch: () => new Response("Not used", { status: 404 }),
};
