# Architex

> Built with Arc Studio - money-powered apps in minutes

This is the **project memory** - what Arc Studio remembers about building this app. It helps future agents (or humans) understand and extend the project.

---

## What This App Does

Architex is a constant-product AMM (Uniswap V2 semantics) deployed on Arc Testnet. USDC is the native gas token on Arc and is used as one side of four liquidity pools. Users can:
- Add and remove liquidity across five token pairs (USDC/WETH, USDC/WBTC, USDC/ARC, USDC/EURC, WETH/WBTC)
- Swap tokens along single-hop and multi-hop paths
- Use ERC-20 permit for gasless LP approval before removing liquidity
- Query aggregated pool state, position summaries, and balances via the Lens contract
- Mint test tokens from each TestToken's faucet() function for testing

## Tech Stack

- Frontend: React 18, Vite, TypeScript, Tailwind CSS
- Web3: wagmi v2, viem v2, ConnectKit
- Contracts: Solidity 0.8.28 + Foundry + OpenZeppelin 5.1. Sources in `contracts/`, unit tests in `contracts/test/*.t.sol`. Build with `forge build`, test with `forge test`.
- Wallet: injected (MetaMask, etc.)
- Chain: Arc Testnet (Chain ID: 5042002)
- Token: USDC (6 decimals, Address: 0x3600000000000000000000000000000000000000)
- Toasts: Sonner

## Deployed Contracts — Arc Testnet (chain 5042002)

| Contract | Address | Explorer |
|---|---|---|
| ArchitexFactory | `0x6362f5a0fc007ab7d1e61f99d3f4eb04360d060a` | [link](https://explorer.testnet.arc.io/address/0x6362f5a0fc007ab7d1e61f99d3f4eb04360d060a) |
| ArchitexRouter | `0xcb417bbb2c3ce02296229ca89b639bb3af2538e2` | [link](https://explorer.testnet.arc.io/address/0xcb417bbb2c3ce02296229ca89b639bb3af2538e2) |
| ArchitexLens | `0x8ee79a8a702e7f8dd433b940d11b327e5153094b` | [link](https://explorer.testnet.arc.io/address/0x8ee79a8a702e7f8dd433b940d11b327e5153094b) |
| TestToken WETH | `0xf2bb050eb30a9cd4bd5df986c626765ae57d21e4` | [link](https://explorer.testnet.arc.io/address/0xf2bb050eb30a9cd4bd5df986c626765ae57d21e4) |
| TestToken WBTC | `0x34136a662681df7aacbf2aad5c35258db8f1a113` | [link](https://explorer.testnet.arc.io/address/0x34136a662681df7aacbf2aad5c35258db8f1a113) |
| TestToken ARC | `0x004925d26559de8823106e3cbf47ed870788d0d5` | [link](https://explorer.testnet.arc.io/address/0x004925d26559de8823106e3cbf47ed870788d0d5) |
| TestToken EURC | `0x07748023f41001efd73d7907d74f8222a76b2dc2` | [link](https://explorer.testnet.arc.io/address/0x07748023f41001efd73d7907d74f8222a76b2dc2) |

## Deployed Pairs — Arc Testnet

| Pool | Pair Address | Seeded |
|---|---|---|
| USDC/WETH | `0xe269973e59cc31d899020527ee46dd96ea2d0d48` | needs seeding |
| WBTC/USDC | `0x752f3018f709642cdb33102c2e1f199f251a5d7a` | needs seeding |
| ARC/USDC | `0x25bdec5b312aa3b4365dbc48eaea2081ffb8d420` | needs seeding |
| EURC/USDC | `0x0ab4b2f723d8f64776f2cb9786c4b419be2cb370` | needs seeding |
| WBTC/WETH | `0x02af642cd63f193aa75aee3de11999af01247093` | seeded (0.1 WBTC / 2.4 WETH) |

USDC pools need seeding by external wallet (0x7212fA4Fe663d063A7a83dA0467d592ed3A51D46) using `router.addLiquidity`.

## Key Files

### Frontend
- `src/App.tsx` — thin composition root; hash-router between SwapSheet and PoolsView
- `src/chain.ts` — active chain config derived from VITE_ARC_NETWORK (testnet default); exposes `activeChain`, `txExplorerUrl`, `addressExplorerUrl`
- `src/config.ts` — wagmi createConfig; injects burner connector in dev when VITE_DEV_BURNER_KEY is set
- `src/lib/amm.ts` — local bigint AMM math (getAmountOut/In, findBestRoute, priceImpactBps, liquidityMinted, removeAmounts, sqrt); mirrors contract math exactly
- `src/lib/abi.ts` — typed inline ABIs for factory, pair, router, lens, router (parseAbi)
- `src/lib/deployment.ts` — loads arc-testnet.json or arc-mainnet.json based on VITE_ARC_NETWORK; exports `deployment`, `isDeployed`
- `src/lib/tokens.ts` — `buildTokenRegistry`, `Token`, `tokenMonogram`; merges deployment tokens with on-chain meta
- `src/lib/format.ts` — `formatAmount`, `parseAmount`, `formatPct`, `shortAddress`
- `src/hooks/useSwap.ts` — swap state machine: token select, amount input, live quote via `findBestRoute`, approve + swapExactTokensForTokens / swapTokensForExactTokens
- `src/hooks/useLiquidity.ts` — add/remove liquidity with EIP-2612 permit (`signTypedData` + `removeLiquidityWithPermit`)
- `src/hooks/usePairs.ts` — live pair data via Lens `pairs(0, n)` with polling
- `src/hooks/useQuote.ts` — debounced quote from live pair data
- `src/hooks/usePositions.ts` — user LP positions via Lens `positions`
- `src/hooks/useBalances.ts` — multi-token balances via Lens `balances`
- `src/hooks/useAllowances.ts` — multi-token allowances via Lens `allowances`
- `src/hooks/useTokens.ts` — full token registry combining deployment list + on-chain Lens tokenMeta
- `src/hooks/useSettings.ts` — slippage bps + deadline (persisted in localStorage)
- `src/hooks/useHashRoute.ts` — window.location.hash router (swap | pools views)
- `src/components/SwapSheet.tsx` — swap UI: token selects, amount field, receipt lines, approve + swap button
- `src/components/PoolsView.tsx` — pools table: 5 pairs with reserves, TVL, user positions; Add Liquidity sheet
- `src/components/AddLiquidityForm.tsx` — add liquidity form with optimal amount calculation
- `src/components/AppShell.tsx` — masthead ("Architex" + Testnet chip), nav tabs, wallet button
- `src/components/ReceiptLines.tsx` — Rate / Price impact / Fee 0.30% / Minimum received / Route receipt rows
- `src/components/AmountField.tsx` — token amount input with MAX button and USD estimate
- `src/components/TokenSelect.tsx` — token picker popover with search
- `src/components/PoolRow.tsx` — single pool row: pair symbol, reserves, TVL, LP position
- `src/components/PositionRow.tsx` — user LP position row with remove-liquidity action
- `src/components/WalletButton.tsx` — ConnectKit trigger + connected state display
- `src/components/TxStatus.tsx` — pending/success/error toast wrapper
- `src/components/FaucetPanel.tsx` — per-token faucet() button for testnet test tokens
- `src/components/SettingsPopover.tsx` — slippage + deadline settings popover
- `src/components/GhostButton.tsx`, `PrimaryButton.tsx`, `Skeleton.tsx`, `Icons.tsx` — shared primitives
- `src/deployments/arc-testnet.json` — live testnet addresses (canonical frontend copy)
- `src/deployments/arc-mainnet.json` — mainnet stub (all zero addresses; not yet deployed)
- `src/dev/burnerConnector.ts` — dev-only wagmi connector backed by a private-key account (VITE_DEV_BURNER_KEY); testnet-only guard; never active in production builds
- `src/lib/__tests__/amm.test.ts` — bun:test unit tests for all AMM math functions
- `src/lib/__tests__/format.test.ts` — bun:test unit tests for amount parsing and formatting

### Contracts
- `contracts/ArchitexFactory.sol` — CREATE2 pair factory; setFeeTo/setFeeToSetter admin
- `contracts/ArchitexPair.sol` — LP ERC-20 + ERC-20Permit; constant-product core; reentrancy lock; UQ112x112 TWAP
- `contracts/ArchitexRouter.sol` — addLiquidity, removeLiquidity, removeLiquidityWithPermit (permit front-run guard), swapExactTokensForTokens, swapTokensForExactTokens
- `contracts/ArchitexLens.sol` — pairs(start, count), pairsByAddress, positions, balances, allowances, tokenMeta
- `contracts/TestToken.sol` — mintable/faucet ERC-20 for testnet (owner-only mint, open faucet)
- `contracts/SeedPools.sol` — constructor-based seeder: created all 5 pairs, seeded WETH/WBTC pool
- `contracts/interfaces/` — IArchitexFactory, IArchitexPair, IArchitexRouter, IArchitexLens, ITestToken, IArchitexCallee
- `contracts/test/ArchitexFactory.t.sol` — factory unit tests
- `contracts/test/ArchitexPair.t.sol` — pair unit tests (64 total across suite)
- `contracts/test/ArchitexRouter.t.sol` — router unit tests
- `contracts/test/ArchitexLens.t.sol` — lens unit tests
- `contracts/test/ArchitexInvariant.t.sol` — invariant (random mint/burn/swap, K non-decreasing)
- `contracts/script/DeployArchitex.s.sol` — Foundry broadcast script for redeployment (set FEE_TO_SETTER env var)
- `deployments/arc-testnet.json` — all deployed addresses, token list, pair list, deploy tx hashes
- `deployments/abi/` — ArchitexFactory.json, ArchitexPair.json, ArchitexRouter.json, ArchitexLens.json, TestToken.json

### Scripts & Docs
- `scripts/seed-usdc-pools.ts` — seeds the four USDC pools from a funded EOA; run with `bun run scripts/seed-usdc-pools.ts` after setting PRIVATE_KEY env var (excluded from typecheck in this sandbox due to SCP SDK version mismatch)
- `docs/MAINNET-DEPLOY.md` — mainnet deployment checklist and steps

## To Run

```bash
bun install
bun run dev
```

```bash
# Contracts
forge build
forge test
```
