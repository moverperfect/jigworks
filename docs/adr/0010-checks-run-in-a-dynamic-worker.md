# Checks run in a Dynamic Worker

We first planned to run ts-rust inside the Workspace's Durable Object. The probe showed that doesn't hold up (`docs/findings.md`, stage 1). Each ts-rust run takes 58–73 MB of linear memory, and esbuild takes 12–43 MB that it never gives back. So a Check after a Build goes over the isolate's 128 MB limit, and so does a Check with two tsconfigs, such as the React Template's. Cloudflare reports no error when that happens. It quietly replaces the isolate after the request, which would throw away everything the Workspace's object holds in memory, the Agent's state included.

So the Workspace's Durable Object runs each Check in a Dynamic Worker. It loads the Checker with ts-rust's compiled module, and makes one call per tsconfig. Each call sends only the files a Check reads: the Workspace's own files, and the Packages' type declarations and `package.json` files. In the probe, the Durable Object's isolate stayed the same through 15 interleaved Builds, Checks and runs of both Templates, and a React Check took about 350 ms end to end.

## Consequences

- Every Check copies its files into another isolate: 197 files for the Worker Template and 237 for the React Template.
- If the Dynamic Worker's isolate is replaced after a heavy Check, only that Check's next call pays the cost of starting a new one. The Workspace's object is unaffected.
- Builds stay in the Workspace's Durable Object for now (Q46). esbuild alone fits, but its memory grows with each Build. If memory runs short once the Agent shares the isolate, the Build moves to a Dynamic Worker the same way.
- The Checker exists twice in the platform's code: as a module the Durable Object can call, and as a bundled Dynamic Worker built from the same source.
