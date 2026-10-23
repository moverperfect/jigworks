# ts-rust's WebAssembly module

Nobody publishes ts-rust's WebAssembly module, so we build it ourselves (ADR 0002) on a Linux build machine with at least 8 GB and 8 CPUs. The result goes in `vendor/ts-rust-wasm`, with a `BUILD.md` recording the commit, the toolchain, the size and the hash.

The pinned ts-rust commit and the toolchain versions are at the top of `build.sh`. Rebuild only when we decide to move the pin.

At commit `5879a56` the module is 5.1 MB (2.2 MB gzip), not the 4.2 MB that ts-rust's own README gives. ts-rust last updated those figures on 2026-10-03 (`d2d819a`), and 2,210 commits came between then and our pin, including a split of the compiler into several crates. The README is probably just out of date (inferred), and the Worker size limit is 64 MiB, so it doesn't matter.

## Rebuild

The build machine needs at least 8 GB of memory for the fat-LTO step. On a Linux machine, from the repo root:

```sh
bash tools/ts-rust-wasm/build.sh
rm -rf vendor/ts-rust-wasm
cp -r ~/ts-rust-build/out/ts-rust-wasm vendor/ts-rust-wasm
node tools/ts-rust-wasm/smoke-test.mjs
```

To build on another Linux host, run `build.sh` there and copy `~/ts-rust-build/out/ts-rust-wasm` back.

`build.sh` installs rustup, Rust, Node and binaryen into the build machine's home directory the first time, and nothing system-wide. It refuses to build if the checkout isn't exactly the pinned commit.
