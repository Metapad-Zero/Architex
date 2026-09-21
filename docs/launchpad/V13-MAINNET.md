# Launchpad v1.3 — mainnet deploy runbook

The owner deploys; Claude verifies and switches the site. Nothing here needs a key in chat or in a file: the
deploy prompts for it (`--interactive`) or uses the Ledger (`--ledger`).

What gets deployed (one launchpad suite, then the four reference plugins):

| Contract | Script | Role after deploy |
| --- | --- | --- |
| `ArchitexLaunchpad` | `DeployLaunchpad.s.sol` | `feeTo`, `feeToSetter`, `launchFee` (≤ 100 USDC); no other admin |
| `LaunchPairFactory` | `DeployLaunchpad.s.sol` | none (only the launchpad creates pairs) |
| `LaunchRouter` | `DeployLaunchpad.s.sol` | none |
| `SplitPlugin`, `BuybackBurnPlugin`, `HolderDistributionPlugin`, `ComboPlugin` | `DeployLaunchPlugins.s.sol` | none (no owner, nothing to hand over) |

Readiness: V13-SPEC.md (§9 accepted limits), SECURITY.md §3b (reviews, tools, tests), V13-REHEARSAL.md (two
testnet rehearsals, the second on the reviewed contracts; the only change since is two view functions). Contracts are **not third-party audited**; the site keeps saying so.

## 0. Before (Claude)

- [x] v1.3 merged to `main`; `forge test` green on that commit (611 pass, 5 fork tests skipped offline).
- [x] The v1.2 mainnet launchpad `0x9Ac420d7…B959` has 0 launches, so retiring it strands nobody.
- [x] Gas: about 12M gas for both scripts ≈ 0.25–0.35 USDC at ~20 gwei (checked 2026-09-21); the deployer
      `0xc387…9cf60` holds 3.93 USDC.

## 1. Deploy (owner, in your own terminal)

```bash
cd ~/Development/arc-dex
git checkout main && git pull
export FEE_TO=0xc387A6C9229A91bfcdA286078d248a41dff9cf60        # receives the 0.5% platform fee + launch fees
export FEE_TO_SETTER=0xc387A6C9229A91bfcdA286078d248a41dff9cf60 # can change feeTo and the launch fee; hand to the Ledger later
export LAUNCH_FEE=1000000                                       # 1 USDC
```

Simulate first (free, no key):

```bash
forge script contracts/script/DeployLaunchpad.s.sol:DeployLaunchpad --rpc-url https://rpc.mainnet.arc.io
```

Then broadcast (prompts for the key; or `--ledger --sender <address>`):

```bash
forge script contracts/script/DeployLaunchpad.s.sol:DeployLaunchpad --rpc-url https://rpc.mainnet.arc.io --broadcast --interactive
```

It prints one JSON line with `launchpad`, `pairFactory`, `router`, `usdc`. Then the plugins:

```bash
export LAUNCHPAD=<launchpad address from that line>
forge script contracts/script/DeployLaunchPlugins.s.sol:DeployLaunchPlugins --rpc-url https://rpc.mainnet.arc.io --broadcast --interactive
```

It prints `split`, `buybackBurn`, `holders`, `combo`. Both scripts check their own wiring after deploying and
refuse to run with a non-Arc USDC on mainnet.

## 2. Verify and switch the site (Claude)

- [ ] Every address's code equals the local build: `bun run scripts/verify-bytecode.ts <address> <Contract> https://rpc.mainnet.arc.io`
      for the launchpad, pair factory, router and the four plugins.
- [ ] Read-only wiring: launchpad `usdc`/`pairFactory`/`router`/`feeTo`/`feeToSetter`/`launchFee`/`FEE_BPS`/
      `MAX_CREATOR_FEE_BPS`; each plugin's `launchpad()` and `usdc()`.
- [ ] Fill `src/deployments/arc-mainnet.json` (`launchpad`, `launchPairFactory`, `launchRouter`, `splitPlugin`,
      `buybackPlugin`, `holderPlugin`, `comboPlugin`, `txs.launchpad`) and the plugin registry addresses; commit the
      broadcast records under `broadcast/*/5042/`.
- [ ] Deploy the site from a clean worktree of `main` (never the working tree): the Launch tab reappears.

## 3. First launch (owner, small amounts)

- [ ] Create one token from the site with a small creator fee and a first buy of a few USDC; buy and sell once;
      collect creator fees; check where they went on the token page.
- [ ] `collectFees()` sends the platform fees to `FEE_TO`.

## 4. Later

- [ ] When the Ledger arrives: `setFeeToSetter(<ledger>)` on the launchpad (and on the core factory, still owed),
      then `setFeeTo(...)` from the Ledger if fees should land elsewhere.
- [ ] Free third-party scanners once the contracts are verified (SECURITY.md §4).
