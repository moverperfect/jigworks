# Checks run in a Dynamic Worker

We first planned to run ts-rust inside the Workspace's Durable Object. The probe showed that doesn't hold up (`docs/findings.md`, stage 1). Each ts-rust run takes 58–73 MB of linear memory, and esbuild takes 12–43 MB that it never gives back. So a Check after a Build goes over the isolate's 128 MB limit, and so does a Check with two tsconfigs, such as the React Template's. Cloudflare reports no error when that happens. It quietly replaces the isolate after the request, which would throw away everything the Workspace's object holds in memory, the Agent's state included.

So the Workspace's Durable Object runs each Check in a Dynamic Worker. It loads the Checker with ts-rust's compiled module, and makes one call per tsconfig. Each call sends only the files a Check reads: the Workspace's own files, and the Packages' type declarations and `package.json` files. In the probe, the Durable Object's isolate stayed the same through 15 interleaved Builds, Checks and runs of both Templates, and a React Check took about 350 ms end to end.

## Consequences

- Every Check copies its files into another isolate: 197 files for the Worker Template and 237 for the React Template.
- If the Dynamic Worker's isolate is replaced after a heavy Check, only that Check's next call pays the cost of starting a new one. The Workspace's object is unaffected.
- The Checker exists twice in the platform's code: as a module the Durable Object can call, and as a bundled Dynamic Worker built from the same source.
- **Builds run in a Dynamic Worker too, since #87.** They first stayed in the Durable Object (Q46), where they fitted the Templates. A large app's Build, 122 Packages and 46.6 MB of Package text, reset the Durable Object every time, before esbuild had done much (`docs/findings.md`, "Builds of a large app"). The Builder is a Dynamic Worker reused by ID, as the Test bundler is (ADR 0017):
  - **Nothing is held whole.** The Durable Object reads each file only as it's needed: to hash it, then to send it. The hash is the same as before, made a megabyte at a time, so a Build's hash and output don't change for the same files.
  - **The files go as a stream,** one JSON line per file, because a call's arguments can carry at most 32 MiB and that app's files came to 36.6 MB. Type declarations, source maps and Markdown in the Packages stay behind. The tests' bundling sends its files the same way.
  - **A Build of the same files is reused** from the Durable Object's last four, without sending anything.
  - **A Builder that fails,** going over its memory limit or taking more than 60 seconds, gives a failed Build that isn't kept, so the next Build tries again in a new isolate. One that goes over its memory limit is tried once more first, in a new isolate, and if that fails too, the Build says the app has grown too big to build here (#99).
  - **esbuild's memory now grows in the Builder's isolate,** shared by every Workspace's Builds there. A Build that goes over the limit also fails any other Workspace's Build running in that isolate at the time. An app whose Build needs more than an isolate's 128 MB can't be built at all.
