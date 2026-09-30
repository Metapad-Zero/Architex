## Deployed Arc/Base supply audit

`bun run equilibrium:audit <approved-manifest.json>` performs read-only RPC calls and emits JSON. Exit 0 means the specified two-chain quiescent snapshot and configuration pass; exit 1 means evidence is missing or inconsistent. It does not sign, broadcast, settle payments, open adapters or approve a release.

Copy `docs/equilibrium-audit-template.json` and fill it from the approved deployment record. Empty addresses and hashes intentionally fail before any RPC call. No EQUILIBRIUM deployment exists in this repository yet. Use exact six-decimal issuance atoms, named owner/pauser addresses, token runtime hash, proxy runtime hashes and implementation runtime hashes. Build hashes from the approved compiler artifacts with immutable values and deployment receipts; do not blindly copy an unknown RPC's code into the trusted manifest. Pin the manifest alongside the approved commit.

The mode chooses the pinned Arc/Base mainnet or testnet IDs, Wormhole IDs and core addresses in `src/lib/equilibriumNetwork.ts`. An endpoint cannot turn a testnet report into a mainnet report by changing its URL. The current pilot checks one Wormhole transceiver, threshold one, consistency level zero and the same named owner/pauser on manager and transceiver. Other approved configurations need an explicit verifier change.

For each network, the verifier requires a fresh finalized block and pins code, EIP-1967 implementation slots, contract calls and supply reads to that height. It checks the block hash again after reads. There is no fallback to latest. Missing historical state or finalized support fails. It compares token decimals, fixed issuance/spoke cap, mint authority, manager token/mode/chain, owners/pausers, pause state, enabled transceiver, threshold, peers, core and consistency setting. Every started read is collected before the audit returns.

Canonical supply outside custody plus Base representations must equal issuance in a quiescent snapshot. If remote supply exceeds custody, the snapshot fails as unbacked. If custody exceeds remote supply, the audit fails rather than label the difference an authenticated pending claim: a delayed debit, return, surplus deposit or a differently timed snapshot requires separate evidence. It never mints or repairs balances.

The JSON identifies block numbers/hashes, observation times, configuration checks and accounting gaps. `routeTested` and `paidLaunchOpen` always remain false. Matching RPC responses are evidence from the chosen providers, not independent Guardian verification. This audit does not prove a public round trip, pool liquidity/executable quotes, refill, x402 settlement, keeper limits, or Solana/Robinhood supply. Quiesce client traffic and the keeper during an acceptance audit, with the contracts in their approved unpaused configuration, and retain separate finalized transfer/payment/pool evidence. No global four-chain completion follows from its `verified` field.

Reproduce failure and test checks:

```bash
bun test server/equilibrium/__tests__/audit.test.ts
bun run equilibrium:audit docs/equilibrium-audit-template.json
```

The second command deliberately exits 1 while the deployment fields are empty. Supply configured deployment addresses only after the approved deployment exists; fabricated values are not a testnet proof.
