#!/usr/bin/env bash
# Free dry run of the launchpad v1.4 rehearsal (docs/launchpad/V14-REHEARSAL.md) on a local anvil fork of Arc Testnet.
# It needs no key and sends nothing to any live chain: anvil copies Arc Testnet's state (Uniswap v4, rUSDC, the burner)
# at its latest block, the burner is impersonated there, every transaction stays on the fork, and anvil is stopped at
# the end, whatever happens.
#
#   scripts/v14-rehearsal-fork.sh           # Run A on rUSDC, end to end
#   RUN=b scripts/v14-rehearsal-fork.sh     # Run B: deploys on Arc's USDC and drives until the first USDC transfer,
#                                           # which a fork cannot execute (Arc's USDC is a precompile)
#
# The fork runs on chain id 31337 (so nothing signed for it could ever be valid on Arc Testnet), with Prague rules
# (Arc Testnet's) and a block every 0.5 s (Arc's pace, so the 20-block snipe windows last about 10 s, as live).
#
# Environment: PORT (default: the first free port from 18545), WORK (default: a new temporary directory; it keeps the
# deployment record, progress, broadcast and logs), ACTOR (default: the burner), FOUNDRY (default ~/.foundry/bin), and
# anything scripts/v14-rehearsal.ts reads.
set -euo pipefail
cd "$(dirname "$0")/.."

FOUNDRY=${FOUNDRY:-$HOME/.foundry/bin}
BURNER=0x7212fA4Fe663d063A7a83dA0467d592ed3A51D46
RUSDC=0x309297011592BA9a157204e57EB0AF2175D8ceed
RUN=${RUN:-a}
WORK=${WORK:-$(mktemp -d -t v14-fork)}
mkdir -p "$WORK"
PORT=${PORT:-}
if [ -z "$PORT" ]; then
  for p in $(seq 18545 18645); do
    if ! lsof -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then PORT=$p; break; fi
  done
fi
RPC=http://127.0.0.1:$PORT
ACTOR=${ACTOR:-$BURNER}
echo "work dir $WORK; anvil on $RPC"

"$FOUNDRY/anvil" --fork-url https://rpc.testnet.arc.io --port "$PORT" --chain-id 31337 --hardfork prague --block-time 0.5 \
  --compute-units-per-second 200 --retries 10 --fork-retry-backoff 1000 --timeout 60000 >"$WORK/anvil.log" 2>&1 &
ANVIL=$!
stop() {
  kill "$ANVIL" 2>/dev/null || true
  wait "$ANVIL" 2>/dev/null || true
  echo "anvil stopped"
}
trap stop EXIT INT TERM

for _ in $(seq 1 60); do
  "$FOUNDRY/cast" chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break
  sleep 1
done
[ "$("$FOUNDRY/cast" chain-id --rpc-url "$RPC")" = 31337 ] || { echo "anvil did not start (see $WORK/anvil.log)"; exit 1; }
echo "forked Arc Testnet; fork head $("$FOUNDRY/cast" block-number --rpc-url "$RPC")"

# The burner deploys and drives, as it will live, without a key: anvil sends as it.
"$FOUNDRY/cast" rpc anvil_impersonateAccount "$ACTOR" --rpc-url "$RPC" >/dev/null
"$FOUNDRY/cast" rpc anvil_setBalance "$ACTOR" 0x56bc75e2d63100000 --rpc-url "$RPC" >/dev/null # 100 USDC of gas

if [ "$RUN" = b ]; then
  DEPLOY_ENV=(LAUNCH_FEE=0)
  OUT=$WORK/arc-fork-v14-realusdc.json
  RECORD_FLAGS=(--real-usdc)
else
  DEPLOY_ENV=(USDC=$RUSDC LAUNCH_FEE=1000000)
  OUT=$WORK/arc-fork-v14-rehearsal.json
  RECORD_FLAGS=()
fi

env "${DEPLOY_ENV[@]}" FEE_TO="$BURNER" FEE_TO_SETTER="$BURNER" FOUNDRY_PROFILE=v14 FOUNDRY_BROADCAST="$WORK/broadcast" \
  "$FOUNDRY/forge" script contracts-v14/script/DeployLaunchpadV14.s.sol:DeployLaunchpadV14 \
  --rpc-url "$RPC" --broadcast --slow --unlocked --sender "$ACTOR" 2>&1 | tee "$WORK/deploy.log" | tail -8

FOUNDRY_BROADCAST="$WORK/broadcast" RPC_URL="$RPC" bun run scripts/v14-rehearsal-record.ts "$OUT" ${RECORD_FLAGS[@]+"${RECORD_FLAGS[@]}"}
SIGNER=anvil ACTOR="$ACTOR" RPC_URL="$RPC" DEPLOYMENT="$OUT" bun run scripts/v14-rehearsal.ts 2>&1 | tee "$WORK/drive.log"
