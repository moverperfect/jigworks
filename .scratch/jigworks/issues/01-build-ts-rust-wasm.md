# 01: Build ts-rust's WebAssembly module

**Parent:** [spec](../spec.md), user stories 1 and 2 (stage 0)

**What to build:** A repeatable build of ts-rust's WebAssembly module from a pinned commit, so that every measurement in the experiment uses a known checker. When this is done, the module and the script that made it are in the repo. The module type-checks a small project when run under Node on the laptop.

**Blocked by:** None (can start immediately). Jack must first give the Linux build machine 8 GB of memory and 8 CPUs.

**Status:** resolved

- [x] The build runs on a Linux build machine with at least 8 GB and 8 CPUs.
- [x] Nothing is installed system-wide. rustup with the `wasm32-wasip1` target, Node 22, and binaryen 132 or later all go in the home directory.
- [x] The script builds ts-rust commit `5879a56` with the release settings in ts-rust's wasm README. It fails if the checked-out commit is different.
- [x] The module is in the repo with a note of its commit, size and build date.
- [x] Run under Node on the laptop against a tiny project with one deliberate type error, the module reports exactly that error.
- [x] The script works again from a clean checkout on the build machine.

## Tasks

1. Give the build machine 8 GB of memory and 8 CPUs (Jack).
2. Install the toolchain in the build machine's home directory.
3. Write the build script, pinned to `5879a56`.
4. Build, copy the module back with `scp`, and record its commit and size.

Drafted by an AI agent on Jack's behalf.

## Comments

**2026-10-13, agent:** Done. The module is in `vendor/ts-rust-wasm` (SHA-256 `86e5547f…`). The script and the smoke test are in `tools/ts-rust-wasm`.

- A build takes about 2 min 40 s on the build machine at 8 GB and 8 CPUs. Peak memory never needed swap.
- The module is 5,103,370 bytes (2.18 MB gzip), not the 4.2 MB in ts-rust's README. Those figures date from 2026-10-03, 2,210 commits before our pin. See `tools/ts-rust-wasm/README.md`.
- Builds are reproducible. Three builds from scratch gave the same hash, including one in a different directory and one with an empty crate cache.
- **Bug found and fixed.** On a host's very first build, ts-rust's build script left the host's home path in the module 32 times, because it only maps out crate folders that exist when it starts. `build.sh` now fetches crates first, and fails if the module holds any path under `$HOME`.
- The smoke test runs under Node 22 on the laptop. It reports exactly the one deliberate TS2322 error, in about 1 s.
