# Launchpad: deploying to Arc Testnet

**Deployed 2026-09-19:** [`0xd9a7b70085AFE91c4868587899824048d933736e`](https://explorer.testnet.arc.io/address/0xd9a7b70085AFE91c4868587899824048d933736e)
by Arc Studio's testnet deployer, launch fee 1 USDC, `feeTo` and `feeToSetter` = the dev burner
`0x7212fA4Fe663d063A7a83dA0467d592ed3A51D46` (testnet only; mainnet uses a hardware wallet).
The on-chain code was checked byte for byte against the local build:

```bash
bun run scripts/verify-bytecode.ts 0xd9a7b70085AFE91c4868587899824048d933736e ArchitexLaunchpad
```

The launchpad is one contract, `ArchitexLaunchpad`, deployed next to the existing Architex factory.
It deploys each `LaunchToken` itself, so there is nothing else to deploy.

## What is already proven

| Check | Result |
| --- | --- |
| Unit, fuzz and invariant tests (`forge test`) | 152 pass. Accounting identity holds to the unit: USDC held == accrued fees + curve float |
| Reference vectors, executed on-chain and in `src/lib/curve.ts` | Identical to the last unit |
| Two red-team reviews (`GROK-REVIEW-1.md`, `GROK-REVIEW-2.md`) | Every finding closed |
| Against the factory, pair and router bytecode **actually deployed** on Arc Testnet | 5 fork tests pass: pair creation, graduation seeding, trading the graduated pool through the live router, the pair lock |
| Deploy simulation on Arc Testnet | ~3.54M gas, about 0.19 USDC. Runtime size 11.9 KB of the 24 KB limit |

Run the fork suite yourself (it is skipped without the variable, so `forge test` stays offline):

```bash
ARC_TESTNET_RPC=https://rpc.testnet.arc.io forge test --match-contract LaunchpadArcFork -vv
```

## What only a live deployment can prove

Arc's USDC moves balances through a chain-native precompile. A local fork can read it but cannot
execute a transfer, so no Foundry test touches the real token. `scripts/launchpad-smoke.ts` is that
test: it creates a token, buys, sells and collects fees with real testnet USDC and compares every
number with the reference model. It refuses to run on any chain but Arc Testnet.

## Deploy

The script holds no key. Never put a key on the command line; it lands in shell history.

```bash
export FACTORY=0x6362f5A0fc007AB7D1e61f99D3F4eB04360D060a   # src/deployments/arc-testnet.json
export FEE_TO=<address that receives fees>
export FEE_TO_SETTER=<admin address>                          # can change feeTo and the launch fee
export LAUNCH_FEE=1000000                                     # 1 USDC, in 6-decimal base units
```

Simulate first, free:

```bash
forge script contracts/script/DeployLaunchpad.s.sol:DeployLaunchpad --rpc-url https://rpc.testnet.arc.io --sender <deployer-address>
```

Then broadcast with one of:

```bash
forge script contracts/script/DeployLaunchpad.s.sol:DeployLaunchpad --rpc-url https://rpc.testnet.arc.io --broadcast --ledger --sender <ledger-address>
```

```bash
forge script contracts/script/DeployLaunchpad.s.sol:DeployLaunchpad --rpc-url https://rpc.testnet.arc.io --broadcast --interactive
```

The script checks the chain before spending gas (USDC has code and 6 decimals, the factory answers)
and prints one line: `{"launchpad":"0x…"}`.

The deployer needs about 0.2 test USDC for gas: [faucet.circle.com](https://faucet.circle.com), Arc Testnet.

## After the deploy

1. Put the address in `launchpad` in both `src/deployments/arc-testnet.json` and `deployments/arc-testnet.json`.
2. Read-only check of wiring and constants:

   ```bash
   bun run scripts/launchpad-smoke.ts
   ```

3. Trading check with real USDC. The account needs about 12 test USDC and gets most of it back:

   ```bash
   BURNER_KEY=<testnet-only key, from your environment> bun run scripts/launchpad-smoke.ts
   ```

4. Remove `VITE_LAUNCHPAD_FIXTURE=1` from `.env.local`, then redeploy the site. The Launch tab
   appears on its own once the address is non-zero:

   ```bash
   vercel deploy --prod --yes
   ```

## Before mainnet

From the second review. Testnet needs none of these; mainnet needs all of them.

- [x] `quoteSell` enforces the same guards as `sell` (`ExceedsSold`, zero proceeds)
- [x] Solvency invariant is an equality, counts `pendingFees`, and the handler calls `collectFees`
- [x] Vectors V4 and V5 executed through `buy()`, not only quoted
- [x] Suite run against the deployed Architex bytecode on Arc (fork suite above)
- [x] Deployed to Arc Testnet, bytecode verified against the local build, read-only smoke passes
- [ ] Live trading smoke test passes on Arc Testnet with real USDC (needs ~12 test USDC on the burner)
- [ ] One token taken all the way to graduation on testnet, then traded on the Swap tab
- [ ] `LAUNCH_FEE` decided and non-zero (spam cost; the cap is 100 USDC)
- [ ] `FEE_TO_SETTER` is a hardware wallet and is kept, never renounced: it is the only way to move
      `feeTo` if that address is ever blocklisted by USDC
