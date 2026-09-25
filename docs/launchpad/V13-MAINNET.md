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

## Deployed 2026-09-21

| Contract | Address |
| --- | --- |
| `ArchitexLaunchpad` | `0xC4Edce6e3751a91dc9094f140D217aCE23221327` |
| `LaunchPairFactory` | `0xAE59776B7B3B23AcD6784cA0f9E5256C82d2f41a` |
| `LaunchRouter` | `0x4B179cD28c4e6014a7b311df3db1B6284dF2b808` |
| `SplitPlugin` | `0x39d34Ef3Bf6279fA430f71eb8A19da257573e6E7` |
| `BuybackBurnPlugin` | `0xB9Be42e021194e33866a0C43b36Ffb357369944D` |
| `HolderDistributionPlugin` | `0x11278F83eb85fFB8987C59A62C316aB4E27CF012` |
| `ComboPlugin` | `0x6f265D785191e7F13357940a2D4A94C35e54df9D` |
| `DeepenPoolPlugin` (added 2026-09-25) | `0x50351E90A19491550b14e909C051fB2181613079` |

Deployed by the owner from `0xc387…9cf60` (`feeTo` = `feeToSetter` = that wallet, launch fee 1 USDC). Gas: 7,528,131
(0.171 USDC) for the launchpad suite, 4,152,048 (0.091 USDC) for the plugins. All seven match the local build byte
for byte (`scripts/verify-bytecode.ts`, immutables and metadata masked), and the wiring reads back correctly on
chain. Records: `broadcast/DeployLaunchpad.s.sol/5042/`, `broadcast/DeployLaunchPlugins.s.sol/5042/`.

**Deepen pool, 2026-09-25** (V13-SPEC §2.3). Deployed by the owner from the same wallet with
`contracts/script/DeployDeepenPool.s.sol` (`LAUNCHPAD` set to the launchpad above): tx
`0xa26ce59b752717ac6d76a2f974eadf0d0416e5759e464d50b7e2baf8a849cf81`, block 22,703,890, 2,110,960 gas. It matches the
local build byte for byte, reads back the launchpad, USDC and every pacing constant, declares `IArchitexFeePlugin`,
and its source is verified on Sourcify (exact match, runtime and creation) and ArcScan. It has no owner, so nothing is
handed over. Reviews: SECURITY.md §3c; Arc Testnet rehearsal: `DEEPEN-REHEARSAL.md`. Record:
`broadcast/DeployDeepenPool.s.sol/5042/`. Buyback & burn above stays deployed but is paused in the builder (H1, V13-SPEC
§2.2); Deepen pool at a 100% burn share does its job.

Two things the deploy ran into, for next time: a terminal opened before Foundry was on the PATH needs
`~/.foundry/bin/forge`; and Arc's RPC once answered Forge's EIP-1559 fee lookup with "request beyond head block"
(nothing was sent) — passing `--with-gas-price 30gwei --priority-gas-price 2gwei` skips that lookup.

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

- [x] Every address's code equals the local build: `bun run scripts/verify-bytecode.ts <address> <Contract> https://rpc.mainnet.arc.io`
      for the launchpad, pair factory, router and the four plugins.
- [x] Read-only wiring: launchpad `usdc`/`pairFactory`/`router`/`feeTo`/`feeToSetter`/`launchFee`/`FEE_BPS`/
      `MAX_CREATOR_FEE_BPS`; each plugin's `launchpad()` and `usdc()`.
- [x] Fill `src/deployments/arc-mainnet.json` (`launchpad`, `launchPairFactory`, `launchRouter`, `splitPlugin`,
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
