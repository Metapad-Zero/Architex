# Architex

A constant-product AMM DEX for [Arc](https://arc.network), Circle's USDC-native chain. Swap ERC-20 tokens, add and remove liquidity, and track positions — quotes are computed locally from pool reserves, so the interface never waits on the network to answer a keystroke.

Built with Arc Studio (contracts, audit, testnet deployment) and a hand-designed frontend.

## Contracts

| Contract | Role |
|---|---|
| `ArchitexFactory` | Creates and indexes pairs (CREATE2), owns the protocol-fee switch |
| `ArchitexPair` | x·y=k pool; the LP token itself (ERC-20 + EIP-2612 permit); 0.30% fee |
| `ArchitexRouter` | Add/remove liquidity, exact-in / exact-out swaps, multi-hop, slippage + deadline |
| `ArchitexLens` | Read-only batch views so the app loads a screen in one `eth_call` |
| `TestToken` | Testnet-only ERC-20 with an open faucet |

Interfaces in `contracts/interfaces/` are the ABI source of truth; the spec is `docs/CONTRACTS-SPEC.md`. Deployed addresses live in `src/deployments/arc-testnet.json` (and `arc-mainnet.json` once deployed — see `docs/MAINNET-DEPLOY.md`).

## Run

```bash
bun install
bun run dev            # http://localhost:5173
bun run typecheck && bun run lint && bun test && bun run build
```

`VITE_ARC_NETWORK=testnet` (default) or `mainnet` selects the chain and deployment file.

**Phone wallets** connect through **WalletConnect on Reown's relay** (`src/lib/walletConnect.ts`): the "WalletConnect" row in the connect sheet opens Reown's QR modal (themed to match; deep links on mobile). The connector and its ~280 KB (gzip) provider/modal chunks load only when that row is used, or at startup for a browser whose last connection was WalletConnect, so the initial bundle is unaffected. The Reown project id is a public identifier with a default in source; override it with `VITE_REOWN_PROJECT_ID`, and add every production domain to the project's allowlist at dashboard.reown.com. Reown's email/social logins are deliberately not used: they only transact on chains served by Reown's Blockchain API, which does not include Arc.

No wallet extension? The connect sheet offers a **browser wallet** with **browser sign-in** (`src/lib/keystore.ts`, `src/lib/localWallet.ts`):

- **Passkey wallet (default).** "Create a browser wallet" registers a passkey (Touch ID, Face ID or a security key) and derives the wallet key from the passkey's WebAuthn PRF output (HKDF-SHA-256 → secp256k1). The key is never stored — only a public hint (address + credential id) — and is re-derived for each signature. **"Sign in with passkey"** opens the browser's own passkey chooser and brings the same wallet back in any browser where the passkey syncs, even after site data is cleared. The derivation constants are frozen and pinned by a test vector.
- **Imported key / password wallet.** An imported key is stored only as AES-256-GCM ciphertext wrapped by a passkey (PRF) or a password; where passkeys are unavailable a new wallet is wrapped by a **password** (PBKDF2-SHA-256, 600k iterations). Password forms carry the `username` / `new-password` / `current-password` semantics browsers need to save and fill the wallet password.

Every signature opens a confirm sheet (`src/components/UnlockSheet.tsx`) that shows the decoded request — swap amounts, approval allowance, pool deposit — and asks for the passkey or password for that one use; nothing signs silently. Back-up and forget flows live in the connect sheet (`src/lib/localWalletConnector.ts` is the wagmi connector). In dev builds, `VITE_DEV_BURNER_KEY=0x…` plus `VITE_DEV_BURNER_PASSWORD=…` in `.env.local` seed that wallet (password-protected like any other) for automated checks. Seed the four USDC pools from any funded key with `BURNER_KEY=0x… USDC_PER_POOL=4 bun run scripts/seed-usdc-pools.ts`.

Contracts: `bun run contracts:build`, `bun run contracts:test` (Foundry).

## What the app does

- **Swap** with quotes computed locally from pool reserves (no network round-trip per keystroke), exact-in or exact-out, single- or multi-hop through USDC, slippage and deadline settings, price impact with "share of the pool" context, an approve→swap step hint, and plain-language failure reasons.
- **Shareable state**: `#swap?in=WBTC&out=WETH&amount=0.01` opens the sheet pre-filled; the last pair is remembered. `⌘K`/`Ctrl+K` opens the token picker; `Enter` in an amount field fires the primary action.
- **Pools** with a detail view per pair: reserves, price, LP supply, your share, and a real price-history line drawn from the pair's on-chain `Sync` events (explorer logs API, RPC fallback), with crosshair/keyboard readout and a table view. Add and remove liquidity inline (removal is a single transaction via EIP-2612 permit).
- **Wallet**: a native connect sheet listing EIP-6963 wallets; connected view with address, balance, explorer link and disconnect. No third-party wallet UI kit.
- **Recent**: a ledger of this browser's confirmed transactions under the sheet.
- **Dark variant** follows the system preference: the same sheet printed in negative.
- Fast by construction: 65 KB gzipped main bundle, wagmi/viem in a cached vendor chunk, Pools lazy-loaded; zero automated WCAG 2.2 violations.

## Design

The app is a bank form on white paper, not a trading terminal: black tabular numerals on a ruled sheet, one yellow button that moves money. Product truth is in `PRODUCT.md`; the direction contract is in `.impeccable/surfaces/`; tokens are documented in `DESIGN.md`.

## Donate

If you found this to be useful, consider donating by sending magic internet monies to:

```text
sol: 79TNuyFNZWhDeFF1RUNA5Xk9Pccvb7xPYqLukBxCeWbb
evm: 0xa2c0abd1a1fcb5aee12f80651ae7f646371a66ed
```
