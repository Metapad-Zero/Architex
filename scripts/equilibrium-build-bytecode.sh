#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export EQUILIBRIUM_NTT_REMAPPINGS
EQUILIBRIUM_NTT_REMAPPINGS="$(cat scripts/equilibrium-ntt-remappings.txt)"
# Fresh compilation, including compiler metadata. Never strip metadata to match a bundle.
(
  cd lib/ntt/evm
  FOUNDRY_AUTO_DETECT_REMAPPINGS=false FOUNDRY_PROFILE=prod forge build --remappings-env EQUILIBRIUM_NTT_REMAPPINGS --force \
    src/NttManager/NttManager.sol \
    src/Transceiver/WormholeTransceiver/WormholeTransceiver.sol \
    lib/openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol
)
FOUNDRY_PROFILE=equilibrium forge build --force
bun run scripts/equilibrium-bytecode.ts "$@"
