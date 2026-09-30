## Route and market matrix — 2026-09-30

Candidate: Wormhole NTT, Arc canonical locking hub and burning spokes. EVM `v2.0.0+evm`, commit `c636cc15b07969e4b44de7e466c999c07e7387a9`, is pinned recursively in `lib/ntt`. SVM candidate `v3.0.0+solana`, commit `1a2a92ef7f289972b2d00dd1d58077d139fe68d7`, is recorded but no SVM deployment/build is included. Official [network support](https://docs.wormhole.com/products/token-transfers/native-token-transfers/reference/supported-networks/) documents the four mainnets; it does not prove a token route.

Exact RPCs/core addresses/hashes are in `src/lib/equilibriumNetwork.ts` and `public/equilibrium-infrastructure.json`. All new EQUILIBRIUM token, mint, manager, transceiver and pool addresses remain absent.

| Chain | Native / Wormhole IDs | Existing-token market | Evidence and gate |
| --- | --- | --- | --- |
| Arc | main 5042 / 71; test 5042002 / 71 | Architex factory main `0x3648cc1323b4729e472cffdC570C6096565b0923`; test `0x6362f5a0fc007ab7d1e61f99d3f4eb04360d060a` | IDs/core/factory read publicly. Actual Architex code accepts both token types in fork harness. Public deployment/round trip/pool untested. |
| Base | main 8453 / 30; Sepolia 84532 / 10004 | Uniswap v3 factory main `0x33128a8fC17869897dcE68Ed026d694621f6FDfD`; Sepolia `0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24` | IDs/bytecode read; actual Sepolia factory fork created pool, liquidity and swap with existing six-decimal spoke. Public transfer/pool untested. |
| Solana | main genesis prefix `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` / 1; devnet `EtWTRABZaYq6iMfeYKouRu166VU2xqa1` / 1 | PumpSwap `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` | Genesis/executable core and market observed on both clusters. No SVM manager, transfer or pool test. Wormhole Testnet uses devnet. |
| Robinhood | main 4663 / 72; real testnet 46630 / NTT ID undocumented | Main v3 factory `0x1f7d7550b1b028f7571e69a784071f0205fd2efa`; test venue unpinned | Actual mainnet factory fork accepted pool/liquidity/swap. Finalized historical bytecode reads unavailable. Test ID observed; supported Guardian/NTT route and official test venue missing. |

[Arc connection](https://docs.arc.io/arc/references/connect-to-arc), [Robinhood connection](https://docs.robinhood.com/chain/connecting/), [Solana clusters](https://solana.com/docs/references/clusters), [Base v3 deployments](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-base-deployments), [Robinhood v3 deployments](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-chain-deployments).

### Authority, decimals and finality

Canonical six-decimal ERC20 has fixed issuance with no later mint/burn/admin route. Zero-supply spoke's one-time binder hands mint authority to a deployed NTT manager; manager owns credit mint/burn. Hub custody backs remote supply plus pending claims. Taxes/rebasing are disallowed. Six decimals fit NTT's maximum eight-decimal wire precision without truncation. SVM needs a six-decimal SPL mint with manager PDA mint authority and an approved freeze/upgrade policy.

Manager/transceiver owners control upgrades, peers, threshold, rate limits and pause powers. Proposed threshold is one authenticated Wormhole transceiver, relying on Guardian verification, not one Guardian. Configuration/admin custody require approval. Sources: [architecture](https://docs.wormhole.com/products/token-transfers/native-token-transfers/concepts/architecture/), [EVM guide](https://docs.wormhole.com/products/token-transfers/native-token-transfers/guides/deploy-to-evm/), [SVM guide](https://docs.wormhole.com/products/token-transfers/native-token-transfers/guides/deploy-to-solana/), [access control](https://docs.wormhole.com/products/token-transfers/native-token-transfers/configuration/access-control/).

Use documented consistency level 0 and finalized source/destination evidence. Published chain finality estimates are not an SLA; observe actual attestations/receipts. RPC finalized reads alone do not prove a Guardian transfer. See [consistency](https://docs.wormhole.com/reference/consistency-levels/) and [core addresses](https://docs.wormhole.com/reference/contract-addresses/).

`NttRehearsal.t.sol` uses actual pinned NttManager/WormholeTransceiver and Sepolia core bytecode, with a **local one-key Guardian set substituted on a read-only fork**. It models Arc/Base peers and tests round-trip decimals/backing, signature/peer/replay rejection, unauthorized mint, pause/resume, outbound/inbound rates and delayed completion. Local finality/signatures do not prove public Arc/Base routes. `VenueCompatibility.t.sol` separately tests actual Base Sepolia and Robinhood mainnet v3 factories with a fixture mint authority: pool compatibility only.

### Venues and executable quotes

Architex's AMM factory accepts an existing asset without its launchpad creating another token; reserve quotes use fee-inclusive bigint AMM arithmetic. Uniswap v3 requires pinned pair/fee/initial tick and QuoterV2 simulation including concentrated liquidity, impact, fees and gas. Fork tests use the 0.30% tier; constant-product calculations do not substitute for v3 executable quotes.

PumpSwap create_pool accepts existing mints. Pin index/creator/base/quote because another index can create another pool. Validate SPL authorities/extensions, disabled instructions, effective/virtual reserves and current fee config. No executable SVM adapter is included. Ordinary Pump coin creation creates a new mint. [Official PumpSwap instructions](https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_SWAP_README.md). Argus/Bankr/Pons existing-token compatibility remains unverified; gateway adapters stay closed.

### Separate quote inventory

| Inventory | Candidate refill | Missing evidence |
| --- | --- | --- |
| Arc ↔ Base USDC | Circle CCTP domains 26 ↔ 6. Test TokenMessengerV2 `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`, MessageTransmitterV2 `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275`; main `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`, `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64`. | Durable burn/attestation/mint job, fee/finality quote and public refill test. No refill sent. |
| Solana | Pre-position approved quote mint/gas; evaluate SVM CCTP separately. | Exact SVM CCTP version/program and PumpSwap quote liquidity unpinned; closed. |
| Robinhood | Pre-position approved quote asset plus ETH gas. | No compatible USDC refill proven. EQL NTT does not move quote funds. |

[Circle contracts/domains](https://developers.circle.com/cctp/references/contract-addresses) and [USDC addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses): Arc `0x3600000000000000000000000000000000000000`, Base main `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, Base Sepolia `0x036CbD53842c5426634e7929541eC2318f3dCF7e`. Arc native USDC gas has eighteen-decimal units; ERC20 USDC has six. Never mix atoms. Fees/losses reduce whole-treasury wealth; inventory movements and keeper volume are not profit or external paid demand.
