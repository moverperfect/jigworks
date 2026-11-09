// The Builder as the main module of a Dynamic Worker, so Builds run in an
// isolate of their own, as Checks and the tests' bundling do (ADR 0010).
// esbuild never gives memory back, and a large app's Build put the
// Workspace's Durable Object over its memory limit (#87). The host passes
// esbuild's compiled module in as `esbuild.wasm`, where worker-bundler
// imports it from, and sends the files as a stream (see `bundledStream`).
import { WorkerEntrypoint } from "cloudflare:workers";
import { snapshotFrom } from "./bundling";
import { build, type MadeBuild } from "./index";
import { takeWasmMemory, trackWasm } from "./wasm-memory";

trackWasm(() => "esbuild");

export class Builder extends WorkerEntrypoint {
  /** Builds the files the stream carries. The host has already hashed them all, type declarations included. */
  async build(files: ReadableStream<Uint8Array>, hash: string): Promise<MadeBuild> {
    const started = Date.now();
    const snapshot = await snapshotFrom(files);
    const receivingMs = Date.now() - started;
    return { result: await build(snapshot, hash), wasmMemoryBytes: takeWasmMemory(), receivingMs };
  }
}

export default {
  fetch: () => new Response("Not used", { status: 404 }),
};
