#!/usr/bin/env bash
# Builds the pinned Wormhole NTT SVM programs that scripts/solana/rehearse.ts drives.
#
# The pin is lib/ntt-svm at 1a2a92ef7f289972b2d00dd1d58077d139fe68d7 (tag v3.0.0+solana), whose
# Anchor.toml declares solana 1.18.26. Platform-tools v1.41 is the toolchain that ships with that
# release, and is requested explicitly: the newer default (v1.43, rustc 1.79) fails to compile the
# ahash version this commit's Cargo.lock pins, because that version gates on the `stdsimd` feature
# rustc removed in 1.78. Asking for the matching toolchain keeps the lockfile exactly as pinned.
#
# Building only; nothing here deploys, funds or broadcasts.
set -euo pipefail

SVM="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../lib/ntt-svm/solana" && pwd)"
PIN=1a2a92ef7f289972b2d00dd1d58077d139fe68d7

if [ ! -f "$SVM/Anchor.toml" ]; then
  echo "lib/ntt-svm is empty. Run: git submodule update --init --recursive" >&2
  exit 1
fi

actual="$(git -C "$SVM" rev-parse HEAD)"
if [ "$actual" != "$PIN" ]; then
  echo "lib/ntt-svm is at $actual, expected the pin $PIN." >&2
  exit 1
fi

# rustup's shim, not a package manager's cargo: cargo-build-sbf dispatches to the `solana`
# toolchain with a `+toolchain` directive that only the shim understands.
export PATH="$HOME/.cargo/bin:$PATH"

cd "$SVM"
BPF_OUT_DIR="$SVM/target/deploy" cargo build-sbf --features mainnet --tools-version v1.41

for program in example_native_token_transfers ntt_transceiver; do
  path="$SVM/target/deploy/$program.so"
  [ -f "$path" ] || { echo "Build produced no $program.so" >&2; exit 1; }
  printf '%s  %s\n' "$(shasum -a 256 "$path" | cut -d' ' -f1)" "$program.so"
done
