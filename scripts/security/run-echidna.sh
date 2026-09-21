#!/usr/bin/env bash
# Property-based fuzzing over the AMM pair invariants. Complements Foundry's own
# invariant runner (contracts/test/ArchitexInvariant.t.sol) with Echidna's
# coverage-guided fuzzer, which explores call sequences differently.
set -euo pipefail
cd "$(dirname "$0")/../.."

mkdir -p reports/security
echidna contracts/test/echidna/EchidnaArchitexPair.sol \
  --contract EchidnaArchitexPair \
  --config echidna.yaml \
  "$@" | tee reports/security/echidna-latest.log
