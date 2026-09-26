# Launchpad v1.4: mainnet deploy runbook

The owner deploys; Claude verifies and switches the site. Nothing here needs a key in chat or in a file: the
deploy prompts for it (`--interactive`) or uses the Ledger (`--ledger --sender <address>`).

What gets deployed, all by one script (`contracts-v14/script/DeployLaunchpadV14.s.sol`, Foundry profile `v14`):

| Contract | Role after deploy |
| --- | --- |
| `ArchitexLaunchpadV14` | `feeTo`, `feeToSetter`, `launchFee` (at most 100 USDC); no other admin |
| `ArchitexLaunchHook` | none: no owner, no upgrade, fees fixed. Deployed through the deterministic CREATE2 deployer (`0x4e59b448…956C`) at a salt the script mines so the address carries the hook's permission bits (`0x28EC`) |
| `ArchitexV4Router` | none |
| `SplitPlugin`, `HolderDistributionPlugin`, `ComboPlugin` (bound to the v1.4 launchpad) | none |

It uses Uniswap's own v4 PoolManager on Arc (`0x8366a39CC670B4001A1121B8F6A443A643e40951`) and Arc's USDC
(`0x3600000000000000000000000000000000000000`); neither is ours to deploy.

Readiness:

- V14-SPEC.md, with §10's accepted limits.
- Reviews:
  - Grok #7 and #8.
  - Claude #7, #8 and #9, and #9's follow-up.
  - Integration review #9b.
  - No High is open, and every finding is fixed or accepted: GROK-REVIEW-7/8.md, CLAUDE-REVIEW-7/8/9.md, INTEGRATION-REVIEW-9.md.
- Tests: 239 v1.4 tests, among them every review's PoCs kept as regression tests. CI runs them.
- Rehearsal: V14-REHEARSAL.md. Both live Arc Testnet runs passed on the same code:
  - Run A, 1,762 checks;
  - Run B, on Arc's USDC, 191 checks.
- The contracts are **not third-party audited**; the site keeps saying so.

## 0. Before (Claude)

- [x] `FOUNDRY_PROFILE=v14 forge test`: 239 pass at `1fa9e54`. The default profile, the live v1.3 contracts, is
      untouched and builds as before.
- [x] Live Arc Testnet rehearsal passed at `3bc28ab`: `1fa9e54` merged into the rehearsal branch. The contracts
      differ from `1fa9e54` in nothing but the rehearsal's records.
- [x] Deployer `0xc387…9cf60` holds 3.62 USDC (read 2026-09-26). The deploy is about 12.1M gas, about 0.30 USDC at
      Arc's 20 gwei base fee plus a 5 gwei tip.
- [x] The CREATE2 deployer `0x4e59b44847b379578588920cA78FbF26c0B4956C` exists on Arc mainnet.
- [ ] `v14` (with the rehearsal branch) merged to `main` and pushed, and CI green on it, including the
      `forge-tests-v14` job. **Waits on the owner's go.**

## Decisions for the owner before deploying

1. **Who holds the admin role.**
   - `feeTo` receives the 0.5% platform fee and the launch fees.
   - `feeToSetter` can change `feeTo` and the launch fee, or renounce.
   - v1.3 uses the hot wallet `0xc387…9cf60` for both, with the Ledger handover still owed.
   - Deploying v1.4 straight to the Ledger avoids a second handover.
2. **Launch fee:** 1 USDC, as v1.3; at most 100.
3. **v1.3 in the builder:** the builder stops offering v1.3 launches the day v1.4 is live (proposed; V14-SPEC §12).
   v1.3 tokens keep trading where they are.

## 1. Deploy (owner, in your own terminal)

```bash
cd ~/Development/arc-dex
git checkout main && git pull
export FEE_TO=0xc387A6C9229A91bfcdA286078d248a41dff9cf60        # or the Ledger address
export FEE_TO_SETTER=0xc387A6C9229A91bfcdA286078d248a41dff9cf60 # or the Ledger address
export LAUNCH_FEE=1000000                                       # 1 USDC
```

Simulate first (free, no key). The simulation also mines the hook's salt, which takes a few seconds:

```bash
FOUNDRY_PROFILE=v14 ~/.foundry/bin/forge script contracts-v14/script/DeployLaunchpadV14.s.sol:DeployLaunchpadV14 --rpc-url https://rpc.mainnet.arc.io
```

Then broadcast. It prompts for the key; or use `--ledger --sender <address>` in place of `--interactive`. `--slow`
sends one transaction at a time, and the gas flags skip Forge's fee lookup, which Arc's RPC once refused:

```bash
FOUNDRY_PROFILE=v14 ~/.foundry/bin/forge script contracts-v14/script/DeployLaunchpadV14.s.sol:DeployLaunchpadV14 --rpc-url https://rpc.mainnet.arc.io --broadcast --slow --interactive --with-gas-price 30gwei --priority-gas-price 2gwei
```

It sends 7 transactions: the launchpad, the hook, the router, `initialize`, and the three plugins. It prints one
JSON line with `launchpad`, `hook`, `router`, `split`, `holders` and `combo`. Paste that line back to Claude. The
record lands in `broadcast/DeployLaunchpadV14.s.sol/5042/`.

## 2. After (Claude)

1. Read the wiring back on chain, and check every contract against the local build byte for byte (immutables and
   metadata masked), as for v1.3 and on the rehearsal:
   - the launchpad's hook, router and USDC;
   - the hook's launchpad, USDC and PoolManager, and its address bits `0x28EC`;
   - the router's immutables;
   - each plugin's launchpad.
2. Verify the sources on Sourcify and ArcScan (`scripts/verify-arcscan.sh`).
3. Fill the v1.4 suite into `src/deployments/arc-mainnet.json`, merge `v14-site`, and deploy the site from a clean
   worktree of `main`.
4. Make the first launch a small one and watch it through graduation.
5. Afterwards:
   - submit the hook for Uniswap's routing allowlist (V14-SPEC §12 has the notes);
   - ask 0x and KyberSwap to route it;
   - hand the admin role to the Ledger if it was not deployed there.
