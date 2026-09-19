# Architex go-live checklist

State on 2026-09-19. **You** = needs the owner (keys, funds, accounts, decisions). **Claude** = can be
done by the agent on request. Order matters: each block depends on the one before it.

## 0. Decisions (you, ~5 min) — everything else waits on these

- [ ] **Mainnet today, or public testnet beta today?** The contracts are a Uniswap-V2 design with 64
      passing tests and Arc Studio's automated review, but **no third-party audit**. Mainnet means
      real funds sit in them. If mainnet: start with liquidity you can afford to lose and label it Beta.
- [ ] **The permanent domain.** Passkey wallets are derived per hostname and the Reown allowlist is
      per domain: changing it later orphans passkey wallets. Pick it once.
- [ ] **Launch tokens / pools** (mainnet token addresses; USDC `0x3600…0000` is already configured).
- [ ] **Who holds `feeToSetter`** (cold wallet or multisig), and which wallet deploys.

## 1. Contracts on Arc mainnet (you, ~20 min) — skip for a testnet beta

Arc mainnet RPC is live (chain 5042) and USDC has code at `0x3600…0000` (checked 2026-09-19).
Foundry is installed at `~/.foundry/bin/forge`.

- [ ] Fund the deployer with a few USDC on Arc mainnet (USDC is the gas token).
- [ ] Optional rehearsal on testnet: same command with `--rpc-url https://rpc.testnet.arc.io`.
- [ ] Deploy (prompts for the key; never put it in a file):
      ```bash
      export FEE_TO_SETTER=0xYourAdminAddress
      ~/.foundry/bin/forge script contracts/script/DeployArchitex.s.sol:DeployArchitex --rpc-url https://rpc.mainnet.arc.io --broadcast --interactive
      ```
- [ ] Give Claude the three addresses + tx hashes → Claude fills `src/deployments/arc-mainnet.json`
      and runs `scripts/verify-deploy.ts` against mainnet.
- [ ] Verify the contracts on the explorer; if you deployed from a hot key, `setFeeToSetter(multisig)`.

## 2. Liquidity (you, real funds)

- [ ] Create the first pool(s) from Pools → "Create a pool" and seed both sides. Start small.
- [ ] Smoke test on the production build: one small swap, one add, one remove.

## 3. Frontend to production (Claude on your word, ~30 min)

- [x] Typecheck, lint, 23 tests, accessibility scan 0, production build 69 KB gzip entry, no dev
      secrets in `dist/`.
- [x] Testnet-only UI (Testnet chip, faucet panel, "Switch to Arc Testnet") already keys off the network.
- [x] `vercel.json`: `frame-ancestors`, `nosniff`, referrer policy, immutable asset caching.
- [x] `VITE_ARC_RPC_URL` overrides the public RPC (rate-limited) with a dedicated endpoint.
- [x] Crash safety: a top-level error boundary ("Architex stopped unexpectedly" + Reload) instead of a
      blank page, and every popover call goes through a helper that cannot throw.
- [ ] **First commit** — the repo has zero commits and no remote. Then push to GitHub (`water-bear86`).
- [ ] Vercel project (CLI is logged in as `water-bear86`): env `VITE_ARC_NETWORK=mainnet` (or
      `testnet`), optional `VITE_ARC_RPC_URL`, attach the domain, DNS.
- [ ] **Reown dashboard → allowlist the production domain** (you; the relay refuses unlisted domains).
- [ ] Price-history chart on mainnet: `explorer.arc.io/api` sits behind a Cloudflare challenge (403 to
      scripts, fine on testnet). Verify in the browser after deploy; fallback is RPC `getLogs` in
      2k-block windows, or hiding the chart on mainnet. Swaps and pools do not depend on it.
- [ ] "Built with Arc Studio" watermark: keep or remove.
- [ ] Beta / unaudited notice and a Terms + risk link in the footer (you supply the text).

## 4. Launch verification on the production domain (both, ~20 min)

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
- [ ] Later, not blocking: third-party audit, full `connect-src` CSP (hosts listed in
      `docs/MAINNET-DEPLOY.md`), Google/email sign-in (Privy or Circle user-controlled wallets),
      re-sync the Arc Studio sandbox, rename the Arc Studio app.
