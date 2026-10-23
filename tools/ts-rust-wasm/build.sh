#!/usr/bin/env bash
# Builds ts-rust's WebAssembly module (the npm/wasm package, ts-rust-wasm) from
# a pinned commit, ready to copy into vendor/ts-rust-wasm. Runs on a Linux
# build machine with at least 8 GB of memory.
#
# usage: build.sh [work-dir]   (default ~/ts-rust-build)
# output: <work-dir>/out/ts-rust-wasm/
#
# The toolchain goes into $HOME only: rustup and Rust in ~/.cargo and
# ~/.rustup (no PATH change in shell profiles), Node and binaryen in
# ~/.local/opt. Nothing is installed system-wide.
set -euo pipefail

TS_RUST_COMMIT=5879a56abc3dc16cf708743c302b1a1ab4f56da7
# ts-rust's wasm README gives its 4.2 MB size for Rust 1.98.1.
RUST_VERSION=1.98.1
BINARYEN_VERSION=133
NODE_VERSION=22.23.3
NODE_SHA256=df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de

work="${1:-$HOME/ts-rust-build}"
opt="$HOME/.local/opt"
src="$work/ts-rust"
out="$work/out/ts-rust-wasm"
mkdir -p "$work" "$opt"

log() { printf '\n== %s\n' "$*"; }

# --- Toolchain ---------------------------------------------------------------

if [[ ! -x "$HOME/.cargo/bin/rustup" ]]; then
  log "Installing rustup"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs |
    sh -s -- -y --no-modify-path --profile minimal --default-toolchain none
fi
export PATH="$HOME/.cargo/bin:$PATH"
log "Rust $RUST_VERSION with wasm32-wasip1"
rustup toolchain install "$RUST_VERSION" --profile minimal --target wasm32-wasip1
export RUSTUP_TOOLCHAIN="$RUST_VERSION"

node_dir="$opt/node-v$NODE_VERSION-linux-x64"
if [[ ! -x "$node_dir/bin/node" ]]; then
  log "Installing Node $NODE_VERSION"
  tarball="$work/node-v$NODE_VERSION-linux-x64.tar.xz"
  curl -sSfL -o "$tarball" "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz"
  echo "$NODE_SHA256  $tarball" | sha256sum -c -
  tar -xJf "$tarball" -C "$opt"
  rm "$tarball"
fi
export PATH="$node_dir/bin:$PATH"

binaryen_dir="$opt/binaryen-version_$BINARYEN_VERSION"
if [[ ! -x "$binaryen_dir/bin/wasm-opt" ]]; then
  log "Installing binaryen $BINARYEN_VERSION"
  name="binaryen-version_$BINARYEN_VERSION-x86_64-linux.tar.gz"
  base="https://github.com/WebAssembly/binaryen/releases/download/version_$BINARYEN_VERSION"
  (
    cd "$work"
    curl -sSfL -o "$name" "$base/$name"
    curl -sSfL -o "$name.sha256" "$base/$name.sha256"
    sha256sum -c "$name.sha256"
    tar -xzf "$name" -C "$opt"
    rm "$name" "$name.sha256"
  )
fi
export PATH="$binaryen_dir/bin:$PATH"

rustc --version
node --version
wasm-opt --version

# --- Source --------------------------------------------------------------------

log "ts-rust at $TS_RUST_COMMIT"
if [[ ! -d "$src/.git" ]]; then
  git init -q "$src"
  git -C "$src" remote add origin https://github.com/pingdotgg/ts-rust.git
fi
git -C "$src" fetch -q --depth 1 origin "$TS_RUST_COMMIT"
git -C "$src" checkout -q --detach FETCH_HEAD
head="$(git -C "$src" rev-parse HEAD)"
if [[ "$head" != "$TS_RUST_COMMIT" ]]; then
  echo "error: checked out $head, expected $TS_RUST_COMMIT" >&2
  exit 1
fi
if [[ -n "$(git -C "$src" status --porcelain --untracked-files=no)" ]]; then
  echo "error: $src has local changes" >&2
  exit 1
fi

# --- Build ---------------------------------------------------------------------

rm -rf "$out"
mkdir -p "$out"
# ts-rust's build.sh maps the cargo registry's paths out of the module, but
# only the registry folders that exist when it starts. Fetching first stops a
# host's first build from keeping its home path in the panic locations.
log "Fetching crates"
(cd "$src" && cargo fetch --locked --target wasm32-wasip1)
log "Building (fat LTO; this takes a while)"
started="$(date +%s)"
# Cargo looks for the workspace from the current directory. CI=1 skips
# ts-rust's capped cargo runner. It sets MemorySwapMax=0, and the fat-LTO step
# needs the build machine's swap as a fallback.
(cd "$src" && CI=1 scripts/wasm/build.sh "$out/ts_rust.wasm")
seconds=$(($(date +%s) - started))
if grep -qaF "$HOME/" "$out/ts_rust.wasm"; then
  echo "error: the module holds a path under $HOME" >&2
  exit 1
fi

# --- Package -------------------------------------------------------------------

log "Packaging"
pkg="$src/npm/wasm"
node -p "JSON.parse(require('fs').readFileSync('$pkg/package.json', 'utf8')).files.join('\n')" |
  while IFS= read -r file; do
    [[ "$file" == ts_rust.wasm ]] && continue
    mkdir -p "$out/$(dirname "$file")"
    cp "$pkg/$file" "$out/$file"
  done
cp "$pkg/package.json" "$pkg/README.md" "$out/"
cp "$src/LICENSE" "$src/NOTICE.md" "$out/"
cp -r "$src/licenses" "$out/"

wasm="$out/ts_rust.wasm"
raw="$(wc -c <"$wasm" | tr -d ' ')"
gzip_size="$(gzip -9 -c "$wasm" | wc -c | tr -d ' ')"
sha="$(sha256sum "$wasm" | cut -d ' ' -f 1)"
cat >"$out/BUILD.md" <<EOF
# ts-rust-wasm build

Built by \`tools/ts-rust-wasm/build.sh\` on $(hostname), $(date -u +%Y-%m-%dT%H:%M:%SZ).

| | |
|---|---|
| ts-rust commit | \`$TS_RUST_COMMIT\` |
| Rust | $(rustc --version) |
| binaryen | $(wasm-opt --version) |
| Node | $(node --version) |
| \`ts_rust.wasm\` | $raw bytes ($gzip_size gzip -9) |
| SHA-256 | \`$sha\` |
| Build time | $((seconds / 60)) min $((seconds % 60)) s |
EOF
cat "$out/BUILD.md"
log "Done: $out"
