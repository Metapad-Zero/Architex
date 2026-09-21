#!/usr/bin/env bash
# Symbolic execution over the highest-value contracts: the AMM pair (holds all pool funds)
# and the launchpad (holds all curve funds). Slow — minutes per contract — so this is a
# manual/periodic check, not a per-commit CI gate. See docs for the CI-gated tools.
set -euo pipefail
cd "$(dirname "$0")/../.."

SOLC_VERSION="0.8.28"
SOLCX_DIR="$HOME/.solcx"
FOUNDRY_SOLC="$HOME/Library/Application Support/svm/${SOLC_VERSION}/solc-${SOLC_VERSION}"

mkdir -p "$SOLCX_DIR" reports/security
if [ ! -f "$SOLCX_DIR/solc-v${SOLC_VERSION}" ] && [ -f "$FOUNDRY_SOLC" ]; then
  cp "$FOUNDRY_SOLC" "$SOLCX_DIR/solc-v${SOLC_VERSION}"
  chmod +x "$SOLCX_DIR/solc-v${SOLC_VERSION}"
fi

SETTINGS_JSON="$(mktemp)"
cat > "$SETTINGS_JSON" << 'EOF'
{
  "remappings": ["@openzeppelin/contracts/=node_modules/@openzeppelin/contracts/", "forge-std/=lib/forge-std/src/"],
  "viaIR": true,
  "optimizer": {"enabled": true, "runs": 200}
}
EOF
trap 'rm -f "$SETTINGS_JSON"' EXIT

TARGETS=(
  "contracts/ArchitexPair.sol"
  "contracts/ArchitexRouter.sol"
  "contracts/launchpad/ArchitexLaunchpad.sol"
)

for target in "${TARGETS[@]}"; do
  name="$(basename "$target" .sol)"
  echo "== mythril: $target =="
  myth analyze "$target" \
    --solv "$SOLC_VERSION" \
    --solc-json "$SETTINGS_JSON" \
    --execution-timeout "${MYTHRIL_TIMEOUT:-600}" \
    -o markdown > "reports/security/mythril-${name}.md" 2> "reports/security/mythril-${name}.err" || true
  echo "  -> reports/security/mythril-${name}.md"
done
