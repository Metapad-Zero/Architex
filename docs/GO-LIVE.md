# Architex go-live checklist

State on 2026-09-19. **You** = needs the owner (keys, funds, accounts, decisions). **Claude** = can be
done by the agent on request. Order matters: each block depends on the one before it.

## 0. Decisions — made 2026-09-19

- [x] **Mainnet today.** The contracts are a Uniswap-V2 design with 63 passing tests and Arc Studio's
      automated review, but **no third-party audit**: the app says so (Beta chip + a footer sentence on
      mainnet). Start with liquidity you can afford to lose.
- [x] **Domain: `architex.fun`** — bought on Vercel (registrar Vercel, account `water-bear86`).
      Permanent: passkey wallets are derived per hostname and the Reown allowlist is per domain.
- [x] **Launch tokens: what Arc has.** Verified on-chain on mainnet: USDC
      `0x3600000000000000000000000000000000000000` and EURC `0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1`
      (both 6 decimals), so the first pool is **USDC / EURC**. USYC
      (`0x8a5D989Bbb96929F689B0200f435f53dA42bF490`) is excluded: it is a permissioned token (transfers
      gated by an entitlements contract; supply on Arc is 0), so an AMM pair can never hold it.
      Everything else will be our own tokens, launched on bonding curves; a token reaches the DEX when
      its curve graduates by creating an Architex pair and depositing the liquidity (not built yet).
- [x] **Fee admin (`feeToSetter`): the owner's Ledger.** Protocol fees start off (`feeTo` unset), so
      this role only matters once fees are switched on.

## 1. Contracts on Arc mainnet (you, ~15 min)

Checked on this machine 2026-09-19: contracts compile and 63/63 tests pass locally
(`~/.foundry/bin/forge test`); Arc mainnet RPC is live (chain 5042); a no-broadcast simulation of the
deploy script against mainnet succeeds and estimates **~6.5M gas ≈ 0.27 USDC** in total.

- [ ] Put 1–2 USDC on Arc mainnet in the deploying wallet (USDC is the gas token; bridge with CCTP
      or withdraw to Arc from an exchange that supports it).
- [ ] Free rehearsal, any time (no `--broadcast`, nothing is sent):
      ```bash
      FEE_TO_SETTER=0xYourAddress ~/.foundry/bin/forge script contracts/script/DeployArchitex.s.sol:DeployArchitex --rpc-url https://rpc.mainnet.arc.io
      ```
- [ ] Deploy **with the Ledger** (Ethereum app open, blind signing on; three transactions to approve):
      ```bash
      FEE_TO_SETTER=0xYourLedgerAddress ~/.foundry/bin/forge script contracts/script/DeployArchitex.s.sol:DeployArchitex --rpc-url https://rpc.mainnet.arc.io --broadcast --ledger --sender 0xYourLedgerAddress
      ```
      If the Ledger is not here yet, deploy from a hot wallet now and hand the role over later:
      ```bash
      FEE_TO_SETTER=0xYourHotAddress ~/.foundry/bin/forge script contracts/script/DeployArchitex.s.sol:DeployArchitex --rpc-url https://rpc.mainnet.arc.io --broadcast --interactive
      ```
      ```bash
      ~/.foundry/bin/cast send <factory> "setFeeToSetter(address)" 0xYourLedgerAddress --rpc-url https://rpc.mainnet.arc.io --interactive
      ```
      Never put a private key in a file or on the command line.
- [ ] Give Claude the JSON line the script prints (`{"factory":…,"router":…,"lens":…}`) and the three
      tx hashes (in `broadcast/DeployArchitex.s.sol/5042/run-latest.json`) → Claude fills
      `src/deployments/arc-mainnet.json`, verifies the wiring on-chain and redeploys the site.
- [ ] Verify the contracts on the explorer.

## 2. Liquidity (you, real funds)

- [ ] Pools → "Create a pool" → USDC / EURC, seed both sides. Start small. The first deposit sets the
      price: deposit at the real EUR/USD rate or the pool is arbitraged at your expense.
- [ ] Smoke test on architex.fun: one small swap, one add, one remove.

## 3. Frontend to production (Claude on your word, ~30 min)

- [x] Typecheck, lint, 23 tests, accessibility scan 0, production build ~72 KB gzip entry, no dev
      secrets in `dist/`.
- [x] Mainnet mode verified locally: Beta chip, USDC + EURC in the pickers, faucet hidden, a clear
      "contracts are not deployed on this network yet" note until the addresses are filled in.
- [x] `vercel.json` (frame-ancestors, nosniff, referrer policy, immutable asset caching),
      `VITE_ARC_RPC_URL` override, error boundary, non-throwing popovers, link-preview card + meta
      for architex.fun.
- [x] In git: `Metapad-Zero/Architex` (private), branch `main`.
- [x] **Deployed to Vercel** 2026-09-19: project `architex` (team `redemption`), production
      deployment live at **https://architex.fun** (also `architex-eight.vercel.app`), currently the
      **testnet** build (`VITE_ARC_NETWORK=testnet` on Production + Preview). Verified there: pools load,
      no dev wallet seeded, passkey sign-in offered, WalletConnect issues a QR, security headers served.
      Redeploy with `vercel deploy --prod` from the repo root (CLI deploys; the GitHub repo is not
      connected to Vercel yet).
- [ ] **Flip to mainnet** once section 1 is done: set `VITE_ARC_NETWORK=mainnet` on Production,
      fill `src/deployments/arc-mainnet.json`, redeploy.
- [x] Passkey scope pinned to `architex.fun` (apex, www and subdomains share wallets) before any real
      wallet exists on the domain.
- [ ] Reown dashboard: WalletConnect already works from `architex.fun`; if you ever turn the
      allowlist on, add `architex.fun` first or the relay will refuse it.
- [ ] Price-history chart on mainnet: `explorer.arc.io/api` sits behind a Cloudflare challenge (fine
      on testnet). Verify in the browser after deploy; fallback is RPC `getLogs` in 2k-block windows,
      or hiding the chart on mainnet. Swaps and pools do not depend on it.
- [ ] "Built with Arc Studio" watermark: keep or remove. Terms / risk page: you supply the text.

## 4. Launch verification on architex.fun (both, ~20 min)

Passkeys made on `localhost` or a `*.vercel.app` preview do not exist on the real domain: test there.

- [ ] Passkey with real Touch ID: create → sign → clear site data → "Sign in with passkey" = same address.
- [ ] Phone wallet over WalletConnect: scan, approve, confirm it accepts Arc as a network, one swap.
- [ ] Extension wallet (MetaMask / Rabby): connect, add-network prompt, one swap.
- [ ] Safari and a phone browser. (Browsers without passkey PRF hide the Passkey option and offer the
      password wallet; that is expected.)
- [ ] Back up the key of any wallet you fund.

## 5. After the switch is flipped

- [ ] Watch the first hours: `PairCreated` / `Swap` events, RPC errors, wallet connection failures.
- [ ] Announce.
- [ ] Launchpad (bonding curves that graduate into Architex pairs): built, reviewed twice, 152 tests,
      proven against the deployed testnet bytecode. Not deployed yet. Testnet first, then the
      "Before mainnet" list: `docs/launchpad/TESTNET-DEPLOY.md`.
- [ ] Later, not blocking: third-party audit,
      full `connect-src` CSP (hosts in `docs/MAINNET-DEPLOY.md`), Google/email sign-in (Privy or Circle
      user-controlled wallets), re-sync the Arc Studio sandbox, rename the Arc Studio app.
