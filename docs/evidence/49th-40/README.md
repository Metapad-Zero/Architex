# 49TH-40 bounded Robinhood keeper rehearsal

Fork compatibility evidence only. The public Robinhood route remains closed and four-chain live acceptance remains open. USDG is provisional. This bundle does not establish USDG/USDC parity, an executable currency conversion, a quote-asset refill rail, public Guardian finality or real Robinhood L1 fees.

The branch is stacked on PR #22 at `27678047f248b9fdfcf1ac79d7947540c5e8f799`. It copies the reviewed Robinhood directory from PR #18 at `22adede0b82f59cb7624af788d7ef482b244bb18`; the only adaptation to its route engine is an optional maintenance send callback. Both source heads and the existing launch, Base keeper and transfer approval bundles stay unchanged. New implementation is isolated under `server/equilibrium/robinhood/keeper/`; no payment review or Solana code is integrated.

The keeper vault contract and bytecode are the reviewed PR #22 versions. Its off-chain Robinhood runner is derived from that keeper, with explicit non-parity valuation, a shared bounded send journal and separate token-only maintenance. Configurations are copied at construction. The journal binds the keeper manifest, request identities, signed transactions and cumulative costs; altering bound inputs requires review, not an automatic re-plan.

Run from the repository root with Bun and Anvil installed:

```bash
bun install --frozen-lockfile
EQUILIBRIUM_ROBINHOOD_KEEPER=1 bun test server/equilibrium/robinhood/keeper/__tests__
bun run server/equilibrium/robinhood/keeper/rehearse.ts docs/evidence/49th-40 .equilibrium/49th-40/fresh-run
bun run server/equilibrium/robinhood/keeper/bundle-verify.ts docs/evidence/49th-40
bun run server/equilibrium/keeper/token-refill-bundle-verify.ts docs/evidence/49th-38
bun run typecheck
bun run lint
bun test ./src ./server
bun run build
git diff --check
```

Use a **new private journal directory** for each independent rehearsal. The command stops and awaits its exact Anvil children; it leaves no service running. Private files contain public development keys and signed fixture transactions, are mode 0600, and must not be published. The delivered configs/previews/evidence contain no keys. Ports are Arc `18945`, Robinhood `18946`; there is no HTTP payment service. These differ from the payment and Solana rehearsals.

The public Robinhood RPC retains a short historical window. Default reproduction chooses a fresh retained block and verifies the pinned infrastructure bytecode hashes. To reproduce the recorded Robinhood block exactly, supply an archive-capable RPC through `EQUILIBRIUM_ROBINHOOD_FORK_RPC` and the evidence block through `EQUILIBRIUM_ROBINHOOD_FORK_BLOCK`. A pruned block refuses the rehearsal; it is not silently replaced when explicitly requested. Receipt hashes, timestamps and process IDs naturally differ on a new run. The evidence records the tested source commit and complete file hashes; the artifact commit may be later while source files remain identical.

The harness asserts executable same-quantity buy/sell quotes equal the actual fills in their original assets. USDG receipts are valued at the explicitly labelled fixture rate **0.98 USDC/USDG** with conservative integer rounding. Pool fees enter once through the pool's executable quote. Native valuation is a **5000 USDC/ETH fixture**; Robinhood transactions are charged a **synthetic 10^12 wei L1 allowance**, including in the independent cost reconciliation. These numbers are fixtures, not live trading terms or measured L1 costs. Missing or expired valuation/fee inputs, insufficient inventory, stale quotes and unavailable chains refuse trading.

The test enforces token size, aggregate Arc-plus-Robinhood quote spend, remaining loss allowance, recovery quote reserve, per-send gas cost and cumulative operating cost. Before a cycle opens, operating headroom must cover both legs, halt/close controls and recovery. It tests actual preflight refusal for gas and operating caps, depleted native inventory, depleted canonical inventory and NTT capacity. Token maintenance permits at most 4000 EQL per transfer and 16000 EQL cumulatively; pending claims count and block trading.

The initial refill waits for two source confirmations before authentication and two destination confirmations before completion. The finalized NTT message binds source/destination managers, chain, token, six-decimal precision, amount, sender and keeper recipient. A unique matching finalized redemption and mint must reconcile fixed issuance before maintenance clears. Forged VAAs, VAA replay, request conflicts, executor replay and keeper-leg replay refuse effects. Supply counts canonical tokens outside custody, remote supply and authenticated pending claims, without counting collateral twice.

There are **13 real SIGKILL child-process proofs**: five send/receipt/cost points on each chain's token maintenance, two keeper trade crashes (including signed-before-send), and one recovery crash. The signed transaction is persisted privately before broadcast with its cost reservation. Restart replays the same bytes, observes execution once, waits for finality and resumes accounting. A partial trade halts both vaults and prevents new trades and maintenance; recovery unwinds the purchase market under the remaining loss bound. A pending purchase is never abandoned or treated as available inventory. Control transactions must finalize before a cycle becomes terminal.

`evidence.json` records quotes, fills, finalized blocks, supply, crashes, per-operation execution receipts, actual gas plus the labelled L1 fixture, independent cost checks and separate trading/operating outcomes. Combined keeper cash result counts each cost once. Transferred principal, internal volume and operator-controlled trades are not customer revenue. Pool/treasury profit and external customer activity are not established by this rehearsal.

`manifests.json` hashes the exact keeper/transfer source closure, including reused frozen dependencies. `bundle-digests.json` binds each fixture preview, keyless config and manifest under separate domains; these digests are **fixture identities, not public authorization**. The verifier checks the evidence's source commit, retained approval dependencies, old public artifacts and absence of development keys.

Live prerequisites remain: approved network pair and quote asset; USDG valuation/execution source; separate quote/native replenishment policy; public attestation and finality; archival state access; measured and bounded Robinhood L1 cost; approved custody, budgets and release terms. No public transactions, funding, deployments, new issues or additional agents were performed. Stop with pending claims intact, reconcile the original journal and recover before new admissions. Never delete a reservation or relax caps to pass a test.
