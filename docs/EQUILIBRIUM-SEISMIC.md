## EQUILIBRIUM on a Seismic hub: local prototype, route matrix and placement

Status on 2026-10-01: **local prototype only.** Angus set the architecture: "we use seismic to connect everything, including arc". Seismic is the coordination hub for Arc, Base, Solana and Robinhood Chain. This document records how that can be built, what has been verified and the exact missing dependencies. Nothing was deployed, signed for or broadcast to a public network.

Reproduce:

- `cd seismic && sforge build && sforge test` (9 tests)
- `cd seismic && bun install && bun run prototype` writes `output/equilibrium/seismic-prototype.json`
- The route evidence is `output/equilibrium/seismic-route-evidence.json`

### Pinned toolchain

| Tool | Version | Binary sha256 |
| --- | --- | --- |
| sforge / sanvil / scast | `1.3.5-v0.4.1`, commit `15c65c8e7a87671ad7340d78001f3c68a597246f` (sfoundryup attestation verified) | sforge `366c91c1…`, sanvil `51f6048b…` |
| ssolc | `0.8.31-develop.2026.9.16+commit.98e187b6` (pre-release, per its own warning) | `95b70a53…` |
| seismic-viem / viem | `3.0.1` / `2.38.0` | (npm) |

The shielded state is native `suint256`, set with the documented explicit cast `suint256(value)`. There is no `sCast`, no imported shielded library and no custom circuit. ssolc's via-IR pipeline requires an `unsafe_via_ir` opt-in, so the contract avoids it.

**Client/node mismatch found.** With sanvil v0.4.1 (and the 2026-09-23 nightly), seismic-viem 3.0.1 sends encrypted 0x4A writes correctly. Its signed reads fail when decrypting the node's reply (`Cipher job failed`). seismic-viem 2.0.1's request is rejected by the node (`AES-AEAD decryption failed`). The toolchain shipped on 2026-09-28/29, two months after the latest client (2026-07-31). The prototype therefore proves balances by exact withdrawals instead of signed reads. A signed-read-capable client version is an open dependency.

### Trust model: what is enforced by hardware and what by proof

- **Calldata confidentiality.** Calldata is encrypted with ECDH and AES-GCM to the node's TEE key. It is bound to chain, nonce, recent block and expiry through AEAD associated data. This is cryptography, but the key lives in the node, so confidentiality is only as strong as the node's TEE.
- **Shielded storage, signed reads, and integrity of execution on shielded state.** All three rest on Intel TDX enclaves and their attestation, plus correct node software. **No part of it is proof-based**: there is no zero-knowledge or validity proof that a shielded update was computed correctly, so observers cannot verify shielded state themselves.
- **Local evidence is weaker still.** sanvil is not a TEE:
  - `eth_getStorageAt` on the shielded reserve slot returned the real value (`0x1dd411fc0` = 8,007,000,000 atoms).
  - `debug_traceTransaction` on an encrypted buy showed the plaintext amount.

  The prototype therefore proves calldata encryption and the contract logic. It does **not** prove storage confidentiality.
- **Network properties (from Seismic's docs, not verified here).** Summit consensus, documented 1-block finality.

### Per-chain route matrix (Seismic as hub)

Source: LayerZero's deployment metadata API (`metadata.layerzero-api.com/v1/metadata/deployments`), retrieved 2026-10-01. Each endpoint was then read on chain.

| Chain | Native ID | LZ V2 EID (test / main) | EndpointV2 (testnet) | On-chain check | Listed DVNs (testnet) |
| --- | --- | --- | --- | --- | --- |
| **Seismic** (hub) | 5124 testnet | 40456 / **none** | `0x2072a32df77bae5713853d666f26ba5e47e54717` | **No code** at the endpoint, SendUln302 `0x638b…6927`, ReceiveUln302 `0x340b…f25c`, executor `0xb63c…c8ae` or DVN `0xfee8…b081` on `testnet-1.seismictest.net` at block 57,462,519 | LayerZero Labs only |
| Arc | 5042002 / 5042 | 40434 / 30417 | `0x6c7ab2202c98c4227c5c46f1417d81144da716ff` | Code present; `eid()` = 40434 | LayerZero Labs |
| Base | 84532 / 8453 | 40245 / 30184 | `0x6edce65403992e310a62460808c4b910d972f10f` | Code present; `eid()` = 40245 | LayerZero Labs, Nethermind, Horizen, BitGo, … |
| Solana | devnet / mainnet | 40168 / 30168 | program `76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6` | Executable on devnet | LayerZero Labs, Paxos, Anchorage, P2P, … |
| Robinhood | 46630 / 4663 | 40451 / 30416 | `0x3acaaf60502791d199a5a5f0b173d78229ebfe32` | Code present; `eid()` = 40451 | Paxos, LayerZero Labs, Nethermind, Horizen |

**Verdict.**
- LayerZero is live on all four spokes, testnet and mainnet.
- For Seismic, LayerZero publishes a **testnet listing with no deployed contracts on the documented RPC**, and **no mainnet listing at all**. An earlier reading of the docs index found no Seismic entry; the API listing exists but is not backed by code.
- No route to or from Seismic exists today. Partnership announcements were not taken as evidence.
- Per instruction, Axelar, Wormhole and custom relayers were not substituted.

Each column of the route, stated separately:

| Concern | How it would work | Status |
| --- | --- | --- |
| Messaging and authentication | An LZ OApp on Seismic, with `peers[eid]` set to each spoke's OApp. The receive library verifies DVN attestations against the configured required/optional DVNs and confirmation counts. The hub's `lzReceive` then checks the endpoint caller, the registered peer and the GUID derived from the origin. | Hub checks are built and tested locally. DVN/executor config cannot be set on Seismic until an endpoint exists, and only the LayerZero Labs DVN is listed (a single-DVN trust assumption unless more are added). |
| Asset transport and custody | The canonical asset moves as an OFT: a lockbox (OFTAdapter) on the issuance chain and burn/mint OFTs elsewhere. Quote deposits (USDC/USDG) are separate assets with their own custody. | Not built. Needs the Seismic endpoint, and a decision on whether quote deposits are held on the spokes (credited by message, as in this prototype) or bridged. |
| Finality | Source confirmations are set per pathway in ULN config. Seismic documents 1-block finality. | Unconfigured. Must be pinned per pathway before any route opens. |
| Replay protection | LZ nonce and GUID per pathway, plus the hub's `consumedGuid` and `consumedDeposit(srcEid, depositId)`. | Hub side tested: duplicate, re-keyed and post-restart replays are all refused. |
| Recovery | LZ stores undelivered payload hashes, so a failed `lzReceive` can be retried; the hub keeps outbound records and retries them once to success. | Hub side tested with an unavailable destination. LZ-side retry, clear and skip are untested (no endpoint). |
| Payload exposure | LZ payloads are public in the source's `PacketSent` and in the executor's delivery calldata. Executors do not send 0x4A transactions. | Deposit and withdrawal amounts are public. Only spending inside the hub is shielded. |
| Liquidity deployment after graduation | Separate step: a pool on a chosen venue, funded from the graduated reserve. | Out of scope; not built. |

### Canonical issuance and custody placement

Seismic owns **curve execution and cross-chain coordination**. **Canonical fixed issuance and its custody stay on Arc** (an OFT lockbox there), and Seismic holds the curve's allocation as a representation, like any spoke.

Reasons:
- **Verifiable conservation.** Conservation of one asset's supply must stay publicly verifiable. On Seismic, holdings are shielded, so a canonical ledger there could only be verified by trusting the TEE. On Arc it can be checked by anyone.
- **Existing evidence.** The existing Arc-side evidence (fixed issuance, x402 payment, hub custody, multi-spoke reconciliation in PR #26) carries over unchanged.
- **Dependencies.** Placing issuance on Seismic would make every chain depend on the missing Seismic endpoint for issuance, not only for the curve.

The alternatives, each a separate explicit change:
- **Issuance and custody on Seismic.** The canonical token is a native OFT on Seismic and Arc becomes a burn/mint spoke. Total supply can stay public while balances are shielded. Conservation then depends on TEE trust. Requires an approved contract change.
- **Mintable issuance on the curve.** The curve mints as it sells instead of selling a fixed allocation. Requires a minter role on the canonical token and changes the conservation identity from "fixed issuance" to "issuance equals curve sales". The existing fixed-supply model and its evidence would no longer apply. **The prototype does not do this**: it sells from a fixed allocation and never mints.

### Supply conservation (one asset)

With issuance on Arc and Seismic as a spoke:

`issuance (Arc, fixed) = canonical outside the lockbox + Σ representations (Base, Solana, Robinhood, Seismic hub) + in flight`

Arc lockbox custody `= Σ representations + in flight`.

Inside the Seismic representation:

`hub allocation = unsold (shielded) + sold and held by buyers (shielded) + pending outbound (public) + sent out (public, now a representation elsewhere)`

The hub exposes this as one public bit, `conserved(curveId)`: sold = held + pending + withdrawn, sold ≤ allocation, and every credited quote atom is held or in the reserve. That bit is only as trustworthy as the TEE.

Quote-asset conservation is separate. Credited deposits are public sums per asset; spending is shielded. **Quote inventory is not revenue.**

### The prototype

`seismic/src/SeismicCurveHub.sol` and `seismic/src/LocalTestEndpoint.sol`:

- **Curve:** virtual constant product. `out = floor((Y0 - S) * q / (X0 + R + q))`, with public `X0 = 30,000 USDC` and `Y0 = 1,073,000,000` tokens. The 800,000,000-token allocation graduates at 85,000 USDC. Rounding is floor, against the buyer. The reserve `R`, sold supply `S`, quote balances and token balances are `suint256`.
- **Credits:** only through `lzReceive`, and only when all of these hold: the caller is the endpoint; the sender is the registered peer for its source EID; the GUID equals the LZ V2 derivation; and the GUID and `(srcEid, depositId)` have not been consumed. Amounts are normalised to six-decimal atoms, and sub-atom dust is refused. Each credit names its own recipient and asset. No caller-supplied amount can create a balance.
- **Buys:** `buy(curveId, suint256 quoteIn, suint256 minOut, uint256 deadline)` takes an encrypted 0x4A call. It checks the deadline, an open curve, the balance, minimum output and the allocation cap.
- **Graduation:** happens once, keyed by `curveId` (a hash of asset, quote asset and parameters, never a domain ID), and closes the curve.
- **Withdrawals:** the amount is public. The outbound record is written before sending; an unavailable destination leaves it pending and accounted, and `retry` sends it once.
- **`LocalTestEndpoint` is not LayerZero.** One relayer key stands in for DVNs and executor. It authenticates nothing on any source chain and proves no public route.

### Results (sanvil, real 0x4A transactions)

| Case | Result |
| --- | --- |
| Deposits from Arc, Base, Solana and Robinhood (Robinhood delivered out of order, one in 18-decimal units) | All credited, 128,000 USDC in total. Reordering converges, and normalisation is exact. |
| Same packet again; same deposit under a new packet; another chain's peer; an unregistered domain; a forged GUID; sub-atom dust; a direct call by a non-endpoint | `Replayed`, `Replayed`, `UnknownPeer`, `UnknownPeer`, `GuidMismatch`, `BadMessage`, `NotEndpoint`. Credited total unchanged. |
| Encrypted buy | Receipt type `0x4a`; 148 bytes of ciphertext against 132 of plaintext. Neither the amount word nor any plaintext span appears in the input. |
| Same function as a normal type-2 transaction | The observer decodes `quoteIn = 2,000,000,000` from the input. The contract cannot prevent this (documented footgun). |
| Repeated buys of 0.007 to 3,000 USDC | Gas identical at **192,944** for every size, including the first write to an empty slot. |
| Slippage (minimum one atom above exact output), expiry, overspend | All reverted on chain, with gas 38,371 / 23,520 / 29,314. **Which check failed is public.** |
| Buy past the allocation | `SoldOut`. |
| Graduation | One buy of 69,000 USDC takes the reserve to 85,007 USDC and graduates once (gas 197,171: the graduation branch is visible, by design). The next buy reverts. |
| Unavailable destination | The withdrawal is queued with 98,466,441,066,744 atoms pending and still accounted. Retry is refused while the destination is down, sent once when it is back, then refused again as `AlreadySent`. |
| sanvil restarted from dumped state; relayer restarted with an empty journal | All 5 earlier deliveries were redelivered and all refused as `Replayed`. Credited total unchanged. Alice withdrew exactly her curve output after the restart, and one atom more was refused. |
| `conserved(curveId)` | True at every checkpoint. |
| sforge (9 tests) | Credit/normalise, forged/replay refusals, reordering, no caller-minted balance, curve and rounding, slippage and deadline, graduation once, pending-claim retry, operator-only quote, and quote-based reconstruction. |

### What an observer learns

| Observable | Public? | What it reveals |
| --- | --- | --- |
| Spoke deposit (source chain transfer and the LZ payload) | Yes, both sides | Depositor, amount, time, recipient on Seismic |
| `Credited` log | Yes | GUID, source EID, deposit ID, recipient (the amount is in the delivery calldata) |
| Encrypted buy calldata | No | Only that the buyer called the hub, and the tx size |
| `Bought` log | Yes | Curve and buyer, no amounts |
| Gas of a successful buy | Yes, constant | Nothing about the amount |
| Gas and status of a failed buy | Yes | Which check failed (slippage, expiry or balance) |
| Graduation | Yes | Curve ID, block, and that the threshold was crossed in that tx |
| Withdrawal (`WithdrawalQueued`, `PacketSent`) | Yes | Amount, destination, recipient |
| Executable quote | Operator only | Exact reserve and sold supply (sforge test: two probes recover the reserve within 1 USDC) |
| Shielded storage | No on a TEE node; **yes on sanvil** | — |

**The deterministic curve can be reconstructed from public history.** Two buyers each deposited publicly, spent their whole deposit in one buy and withdrew everything publicly. From those four public numbers alone the observer recovered the shielded reserve before the first buy as **8,007,000,000 atoms (error 0.004 atoms)** and the sold supply to within 73 atoms. Shielded storage therefore does not make trades private when deposit and withdrawal patterns are public, and **it does not by itself make the curve MEV-free**. Encrypted input cannot hide a deposit that is already public on a spoke, and validators inside the TEE still order transactions.

If unlinkability or MEV resistance is a product requirement, ordering protection is a separate design. Uniform-price batches per interval would separate individual trades from price movement. It should come with the guidance that deposits and buys must be decoupled in time and amount, and with no public quote. This is a proposal; it is not implemented.

**Cast and gas review** (ssolc warnings in `output/equilibrium/ssolc-warnings.txt`):
- **Declassifications (4).** The three `bool(...)` require conditions leak one bit only on revert. `conserved()` is the fourth.
- **Getters.** The `myQuoteBalance`/`myTokenBalance` getters return only the caller's own value. `quote()` is operator-only.
- **Shielding casts of public values.** Credited amounts were already public, and `suint256(c.virtualToken)` and the other curve parameters are public constants.
- **Branch on shielded data (graduation).** Intentional; the transition is public.
- **Overflow/division warnings.** Could only revert on values beyond the configured curve ranges.
- **Arithmetic.** MUL and DIV are constant gas, and no shielded loops or exponents are used.

### Reusable Architex components

| Component (PR #26 head `cce54ef`) | Use on a Seismic hub |
| --- | --- |
| x402/EIP-3009 payment (`server/equilibrium/payment.ts`, `service.ts`) | Unchanged for launch fees on Arc. |
| Durable job runner, journal, lanes and queued claims (`runner.ts`, `store.ts`, `types.ts`) | Seismic becomes one lane. `QueuedClaim` maps to an LZ message that is verified but not yet executed. |
| Executor idempotency `hash(job, step)` and residual/refund ledger (`multispoke/adapter.ts`) | Pattern reused for OApp sends keyed by job step. The refund ledger stays on Arc. |
| Supply observation and reconciliation (`multispoke` `supply()`) | Extended with the Seismic representation's public balance plus the hub's `conserved` bit. |
| Arc fixed issuance and hub custody | Kept: becomes the OFT lockbox side under the recommended placement. |

### Exact missing dependencies

1. **Seismic EndpointV2 and its libraries.** Deployed EndpointV2, SendUln302/ReceiveUln302 and executor on the Seismic network we target, with code on chain. Today the listed testnet addresses are empty and there is no mainnet listing. Owner: LayerZero/Seismic.
2. **DVN set and confirmations.** DVN set and confirmation counts for each Seismic↔spoke pathway. Only the LayerZero Labs DVN is listed for Seismic testnet.
3. **Signed-read client.** A seismic-viem release whose signed reads interoperate with the current node (fails with 3.0.1 vs sanvil v0.4.1 and the 2026-09-23 nightly).
4. **TEE-node evidence.** Shielded slots unreadable and debug traces unavailable, checked against a real TEE node (sanvil exposes both). Read-only checks against testnet are possible without funds; a funded testnet run needs approval.
5. **Owner decision.** Confirm canonical issuance stays on Arc (recommended), or approve one of the two alternatives above.
6. **Owner decision on privacy.** Whether batch/ordering protection is a product requirement.

### What this does not prove

- Any LayerZero route, DVN attestation or OFT transfer.
- TEE confidentiality: storage and trace privacy were not demonstrated, and sanvil lacks both.
- Signed reads.
- Public Seismic testnet behaviour.
- Post-graduation liquidity.
- A production-grade curve (no fees, single curve per quote asset).

Unchanged: existing deployment and spending limits, public routes closed, and the separate independent reviews of #20, #25, the queued Solana branch and #26.
