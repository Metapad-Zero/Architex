# Launchpad v1.4: the Arc Testnet rehearsal

This is the Arc Testnet rehearsal of V14-SPEC §11. It deploys the v1.4 suite with its own Foundry script, then drives
every part of it through real transactions against Uniswap's own v4 PoolManager on Arc Testnet
(`0x8366a39CC670B4001A1121B8F6A443A643e40951`). Five tokens are launched, bought inside and after the curve's snipe
window, graduated into Uniswap v4 and traded there, and every fee is synced, collected and paid out. The books are
checked to the unit after every transaction.

**Status, 2026-09-25: built, and proven end to end on a local anvil fork of Arc Testnet at `15ac4ea`. Nothing has been
sent to Arc Testnet or mainnet.** The live run waits for the two security reviews in progress.

| Fork dry run (Run A, rUSDC) | Transactions | Checks | Gas | USDC at 25 gwei |
| --- | ---: | ---: | ---: | ---: |
| deploy (the Foundry script) | 7 | 36 | 12,175,363 | 0.304384 |
| drive (5 tokens, 5 graduations) | 88 | 1,409 | 23,153,494 | 0.578837 |
| **total** | **95** | **1,445** | **35,328,857** | **0.883221** |

Every check passed on the first attempt of the final run, and **no contract behaviour contradicted the spec**. "USDC at
25 gwei" is what Arc Testnet charges (a 20 gwei base fee plus the node's 5 gwei tip, so 1M gas is 0.025 USDC); the fork's
own gas prices mean nothing (below).

Run B, on Arc's own USDC, was built and typechecked. On the fork it deploys, passes every deployment check and launches
its token, then stops at its first USDC transfer, as it must: Arc's USDC is a precompile that a fork cannot execute. It
only runs live.

## The scripts

| File | What it does |
| --- | --- |
| `contracts-v14/script/DeployLaunchpadV14.s.sol` | Deploys the suite (unchanged): the launchpad, the hook at a mined CREATE2 address through the deterministic deployer, the router, the wiring, and the Split, Distribute to holders and Combo plugins. |
| `scripts/v14-rehearsal-record.ts` | Writes the deployment record from Foundry's broadcast: every receipt succeeded, every contract has code, the hook is CREATE2 of its salt and init code with the low 14 bits `0x28EC`, the contracts point at each other. |
| `scripts/v14-rehearsal.ts` | The driver: Run A or Run B (from the record's USDC), resumable, every transaction checked. `--preview` shows which tokens a deploy at the deployer's next nonces would sort below USDC. |
| `scripts/v14-v4-math.ts` | Uniswap v4's pool math (TickMath, SqrtPriceMath, SwapMath, the tick bitmap's one-word stepping, Pool.swap and modifyLiquidity, LiquidityAmounts) ported to bigint, line for line: the driver's model of the PoolManager. Cross-checked against Uniswap's own TypeScript SDK on 3,000 ticks and 40,000 random swap steps before any chain was used. |
| `scripts/v14-rehearsal-fork.sh` | The free dry run: forks Arc Testnet with anvil, deploys with the Foundry script as the impersonated burner, records and drives, then stops anvil. No key. |

The test `RawSwapper` (`contracts-v14/test/V14Base.sol`) is deployed by the driver from its artifact in
`contracts-v14/out`, and checked against the local build like the rest, to make the swaps the Architex router never makes
(exact out, donations, outside liquidity).

## Run A: the plan

On the mintable rehearsal USDC, rUSDC (TestToken `0x309297011592BA9a157204e57EB0AF2175D8ceed`, 6 decimals, owned by the
dev burner `0x7212fA4Fe663d063A7a83dA0467d592ed3A51D46`, which mints what the run needs). Launch fee 1 rUSDC; `feeTo` and
`feeToSetter` are the burner.

| Token | Creator fee → destination | Pool | Creator's first buy | Buys in the curve's window | Pool orientation (deployed at nonce 272) |
| --- | --- | --- | --- | ---: | --- |
| RWAL | 1% → a plain wallet | closed | 100 rUSDC | 1 | USDC is currency0; exact-out, dump and bid scenarios |
| RSPL | 10% → Split, payees 5/3/2 | open | none | 1 | USDC is currency0; takes outside liquidity |
| RHLD | 10% → Distribute to holders | closed | 100 rUSDC | 1 | USDC is currency1; exact-out, dump and bid scenarios |
| RCMB | 1% → Combo: 50% holders, 30% Split (payees 1:1), 20% a wallet | open | none | 1 | USDC is currency0 |
| RZRO | 0% → a plain wallet | closed | none | 3 | USDC is currency0 |

**Which side of USDC a token sorts on decides which branch of the hook runs** (USDC as currency0 or currency1), and it
follows from the token's CREATE address, so from the deployer's nonce at deploy time. The driver predicts every token's
address before the first launch and runs the exact-out, dump and bid scenarios on the first token of each orientation.
At the burner's current nonce (272) the third token, RHLD, sorts below rUSDC, so both orientations are covered, with the
very addresses the fork run used. `bun run scripts/v14-rehearsal.ts --preview` shows it for the next six nonces; if the
burner sends anything else first, check it again (nonces 274 to 277 put every token on the same side).

The fee recipients are fixed addresses nobody holds a key for (the last 20 bytes of
`keccak256("architex/v14-rehearsal/<label>")`); they only ever receive fees:

| Recipient | Address |
| --- | --- |
| RWAL's wallet | `0x4e2C399D87B354C9bf22796129445D9801166883` |
| RZRO's wallet | `0x50e6443f8103d9A6e3a6e51e3d84080C353f57ff` |
| Split payees (RSPL), shares 5 / 3 / 2 | `0xa23B599B1c8768569F112F1e42B1BC33Cba9dc38`, `0x024D1e1259dCfE1484bF7421afED9e421e8DFF36`, `0xB75c938d6ed9bd7f5E5F5c06BC102FA495395E2d` |
| Combo's Split entry, 1 : 1 | `0xf32Ec73142367aF72Dd41ae2a9bFDddd8D24377d`, `0x36a4ec1cF44Ec67aB5dc1f0F91BE8Cc176DCd8aa` |
| Combo's 20% wallet | `0x446888076cEFBaC98a8c05D502C0c08acb8473C1` |

### What every transaction is checked against

Every transaction is simulated first (a revert costs nothing) and checked at the block it landed in, B, against B-1:

- **Its result**, against the contracts' own quotes and an independent model: the curve (V13-SPEC §5 with the snipe fee
  as a third fee), the hook's fees (V14-SPEC §3: on the gross or on the net, split platform first), Uniswap's pool math
  to the unit (every swap step across ticks, every add, every bid), the graduation, and LaunchToken's dividend stream fed
  with the token's own storage.
- **Its events**: the launchpad's (`Trade`, `Graduated`, `PoolFeesAccrued`, ...), the hook's (`PoolOpened`, `PoolTrade`,
  `BidLocked`, `FeesReleased`), Uniswap's (`Initialize`, `ModifyLiquidity`, `Swap`, and the ERC-6909 `Transfer`s that mint
  and burn the hook's claims), the plugins' and the token's.
- **Everything else**: one Multicall3 snapshot per block of about 140 quantities (every tracked rUSDC balance, the
  launchpad's accruals, every curve, every token's supply and holders, the hook's pending fees, lockHeld, bidCount and
  claims, every pool's price, tick and liquidity). Each must move by exactly what the model says, and every other one
  must not move at all.
- **The invariants** (V14-SPEC §11), at every block:
  - launchpad rUSDC == `pendingFees + Σ pendingCreatorFees + Σ pendingSnipe + Σ (virtualUsdc - VIRTUAL_USDC_0)` over
    live curves;
  - the hook holds no rUSDC and no launch token;
  - the hook's claims, `PoolManager.balanceOf(hook, uint160(rUSDC))`, == `Σ (pendingPlatform + pendingCreator + lockHeld)`;
  - no token's supply grows, and every token's supply sits with the addresses tracked (launchpad, burner, RawSwapper,
    PoolManager, hook).
- **The burner's own side**: its native balance moves by the gas alone (rUSDC), checked with the gas added back.

The snipe windows are checked against the block each transaction actually landed in: the expected surcharge is
`9000 × (openBlock + 20 - B) / 20` bps, capped so all fees stay under 99%, from `createdBlock` (curve) or the graduation
block (pool) and the receipt's block number. The window buys are sent the moment the launch or graduation is mined,
before any check reads the chain, so they land inside the 20 blocks (about 10 s on Arc).

Before each pool transaction the driver rebuilds the pool from its own record of positions (the hook's full-range
position, each bid, the RawSwapper's outside liquidity) and checks that model against StateView at B-1: the active
liquidity, every initialized tick's gross and net liquidity, every position's liquidity, and that the protocol and LP
fees are 0. Then it runs Uniswap's swap on the model and compares.

### Steps

| Step | What it proves |
| --- | --- |
| `deploy` | The deployment the Foundry script made: Uniswap's PoolManager on this chain is byte for byte the tests' fixture and has no protocol-fee controller; the launchpad, hook and router point at each other, the PoolManager and rUSDC; every constant matches the spec; **the hook address's low 14 bits are `0x28EC`**, `getHookPermissions()` is exactly those seven flags, and the address is CREATE2 of the recorded salt through `0x4e59…956C`, with init code equal to the local build's plus (PoolManager, launchpad, USDC); **each of the six contracts equals the local build byte for byte** (immutables and metadata hashes masked, as `scripts/verify-bytecode.ts` does). The deployer kept no power: `initialize` again, `setFeeTo`, `hook.graduate` and `hook.release` by a stranger all revert. |
| `raw`, `fund`, `approve` | The RawSwapper deploys and equals its build; the burner mints 400,000 rUSDC to itself and 50,000 to the RawSwapper; approvals. |
| `plan` | Predicts every token's address and which side of rUSDC it sorts on; picks the scenario tokens. |
| `create:*` | `createToken` registers the plugin, the creator fee, the open or closed choice, `createdBlock`; the token lands at its predicted address and is wired to the launchpad, router, PoolManager and hook; dividends exclude the launchpad, PoolManager, hook, `0x…dEaD` and 0; `hook.poolKeyOf` is the model's key. **The creator's first buy pays no surcharge although its block's is 90%.** Split, Combo and Holders are configured (write-once). Then the window buys, each at its landed block: the surcharge, `snipeBpsOf` at that block, the `Trade` event, the quote at the block before (with its own block's surcharge), and **`pendingSnipe` moving by exactly the surcharge**. Once, free: every refusal of `createToken` (the hook, the PoolManager, the router, rUSDC, the launchpad, zero, an existing token, the new token's own predicted address, a 10.01% fee, a raised launch fee, data for a plain address, a Split paying the PoolManager or the hook), nobody initializing the token's pool first, no transfer into the PoolManager before graduation, the router refusing a curve token, `lock` refusing an unknown launch, `syncPoolFees` booking nothing for a curve, `accrueTradeFees` reverting. |
| `curve:*` | After the window: a buy (quote at the block before == fill == model, no surcharge) and a sell of half (both fees on the gross, rounded up; no surcharge on sells); selling back returns less than was paid; deadlines, slippage and `ExceedsSold`. |
| `graduate:*` | The sell-out buy: the exact fill, and **the pool initialized at the price where one full-range position takes both amounts** (`Initialize`, `StateView.getSlot0`), within 1 ppm of the curve's final price `virtualUsdc / virtualTokens`; **the hook's full-range position (owner the hook, salt 0) with the model's liquidity**; **the leftover tokens burned**; **the graduation bid at the anchored range** (`BidLocked` ticks equal the model from the graduation tick, its top 0.497 of the graduation price, `bidCount` 1, its own position at salt 1); `launchOf`; the pool's window opening at 90%; **the hook holding 0 rUSDC and claims equal to what it owes**. Then, inside the pool's window: a router buy (the surcharge held by the hook as claims; the launchpad books nothing), a router sell (no surcharge), and for the scenario tokens an exact-out buy through the RawSwapper (the surcharge on a net amount), **a 150M-token dump under the bid's top and a `lock` that then places nothing while `lockHeld` stays**. |
| `buyback:*` | After the window: a buy back above the bid's top (no surcharge), then **`lock` places the waiting surcharge as a fresh position (salt 2) at the same anchored range**. |
| `lock:*` | The other tokens: **`lock` places the window's surcharge as a new position with a fresh salt at the anchored range**, paid by burning claims, the price and active liquidity untouched. |
| `pool:*` | After the window: router buy and sell, **quote == fill == model** both ways, fees held as claims. |
| `raw:*` | **Exact-out buy** (exactly the tokens asked; fees on the pool's net on top) and **exact-out sell** (exactly the USDC asked; the pool paid it plus the fees) through the RawSwapper; **a donation of either currency reverts** (`DonationsRefused`); an exact-in buy that a price limit stops early reverts (`PartialFill`). |
| `lp` | **Outside liquidity is refused by a closed pool** (`ClosedPool`) **and accepted by an open one** (RSPL): the position and its amounts match the model; a buy then trades through it and still pays every fee; the RawSwapper removes half of it and gets exactly the model's amounts. |
| `sync:wallet`, `syncBatch` | **`syncPoolFees` and `syncPoolFeesBatch` book exactly what the hook held** (`FeesReleased` == `PoolFeesAccrued` == the hook's pending fees at the block before; the claims burn by that, the PoolManager pays the launchpad that); a token with nothing held books nothing; `hook.release` by anyone else reverts. |
| `collect:*`, `release:split:*` | **`collectCreatorFees` syncs first** (RHLD and RCMB were never synced: their pool fees are released in the same transaction) **and pays each plugin**: the wallet by transfer, Split credited, Holders forwarding everything into the token's 24-hour stream (checked against the stream model), Combo splitting 50/30/20 through Holders, Split and a wallet; a 0% token collects nothing but still books its platform fees. **Split's `release`** pays each payee `totalReceived × share / 10 - released`. |
| `sample`, `claim:*` | **The Holders stream accrues**: two readings 20 s apart, claimable grows by about `streamRate × dt × share` and every view equals the model; the burner's claim pays exactly what `claimable` was at its block; everyone eligible has earned everything that streamed, within a unit or two. |
| `collectFees` | **`feeTo` receives exactly `pendingFees`.** |
| `final` | All invariants; every supply is 1e9 less only the graduation's leftover burn (read from `PoolOpened`); each pool's positions, ticks and bids match the model; **the PoolManager holds at least what every position is worth plus the hook's claims** (the rest is rounding in the pools' favour); both windows were exercised. |

## Run B: Arc's own USDC

Arc's USDC (`0x3600000000000000000000000000000000000000`) is a precompile behind an ERC-20 face; the gas token is the same
balance. A graduation needs about 25,000 USDC, which the burner does not have, so Run B covers the curve only, with 1 USDC
trades. It deploys the whole suite on Arc's USDC with launch fee 0, and runs one token (1% creator fee, closed pool, the
burner as its creator-fee destination so the fees come back):

1. `deploy`: the same checks as Run A, against the Arc-USDC deployment.
2. `approve`: the launchpad, for exactly what the trades need (6 USDC).
3. `create:wallet`: the launch, then a 1 USDC buy fired inside the curve's window, checked at the block it lands in.
4. `curve:wallet`: a 1 USDC buy after the window and a sell of half.
5. `sellAll:wallet`: sells everything back, so the curve's float returns.
6. `collect:wallet`, `collectFees`: the creator and platform fees come back to the burner.
7. `final`.

Every transaction is checked as in Run A, with two differences. The burner's side is checked on its native balance (the
USDC it trades plus the gas it pays), and the PoolManager's USDC is not tracked (every Uniswap trade on Arc moves it; Run
B opens no pool). The driver refuses any transaction that would leave the burner under 0.5 USDC (`FLOOR`).

**The in-window buy is a real cost.** Its surcharge (up to 85.5% of the 1 USDC if it lands one block after the launch,
about 54% to 72% if it lands 4 to 8 blocks after, as live latency suggests) goes to `pendingSnipe`, and since the token
never graduates it stays in the launchpad for good (V14-SPEC §5). `RUNB_WINDOW_USDC=0.1` makes that 10 times smaller.

On the fork Run B deployed (12,154,743 gas), passed its 34 deployment checks, approved (Arc's USDC keeps allowances in its
own storage) and launched (1,626,278 gas), then stopped exactly where it must: the window buy's `transferFrom` reverts
with no revert data, because the native-balance precompile behind Arc's USDC does not exist on a fork (`balanceOf` and
`approve` answer; `transfer`, `transferFrom` and `totalSupply` revert).

## How to run it live

The scripts hold no key. The driver signs with the key in `REHEARSAL_KEY`, read into its own process and never printed,
logged or written; it refuses Arc mainnet always. Type the key at a hidden prompt so it never reaches shell history.

```bash
FOUNDRY_PROFILE=v14 forge build       # contracts-v14/out: the ABIs, and the build every bytecode check compares with
export RPC_URL=https://rpc.testnet.arc.io
BURNER=0x7212fA4Fe663d063A7a83dA0467d592ed3A51D46

# 0. Read-only: which tokens sort below rUSDC at the burner's next nonce (at 272: the third, RHLD).
bun run scripts/v14-rehearsal.ts --preview

# 1. The key, into this shell only.
read -rs REHEARSAL_KEY && export REHEARSAL_KEY

# 2. Run A: deploy on rUSDC with the Foundry script, as the burner's next transaction.
USDC=0x309297011592BA9a157204e57EB0AF2175D8ceed LAUNCH_FEE=1000000 FEE_TO=$BURNER FEE_TO_SETTER=$BURNER FOUNDRY_PROFILE=v14 \
  forge script contracts-v14/script/DeployLaunchpadV14.s.sol:DeployLaunchpadV14 --rpc-url $RPC_URL --broadcast --slow \
  --private-key "$REHEARSAL_KEY" --with-gas-price 30gwei --priority-gas-price 5gwei

# 3. Record it, before any other deploy replaces broadcast/DeployLaunchpadV14.s.sol/5042002/run-latest.json.
bun run scripts/v14-rehearsal-record.ts deployments/arc-testnet-v14-rehearsal.json

# 4. Read-only checks of the deployment (wiring, hook bits, bytecode); no key used.
SIGNER=none bun run scripts/v14-rehearsal.ts

# 5. Drive Run A. MARKDOWN=1 prints the result tables for this file.
SIGNER=key MARKDOWN=1 bun run scripts/v14-rehearsal.ts

# 6. Run B: deploy on Arc's USDC (USDC unset), launch fee 0; record; drive.
LAUNCH_FEE=0 FEE_TO=$BURNER FEE_TO_SETTER=$BURNER FOUNDRY_PROFILE=v14 \
  forge script contracts-v14/script/DeployLaunchpadV14.s.sol:DeployLaunchpadV14 --rpc-url $RPC_URL --broadcast --slow \
  --private-key "$REHEARSAL_KEY" --with-gas-price 30gwei --priority-gas-price 5gwei
bun run scripts/v14-rehearsal-record.ts deployments/arc-testnet-v14-realusdc.json --real-usdc
SIGNER=key DEPLOYMENT=deployments/arc-testnet-v14-realusdc.json MARKDOWN=1 bun run scripts/v14-rehearsal.ts

unset REHEARSAL_KEY
```

The gas flags make forge pay what the driver pays: at Arc's 20 gwei base fee, a 5 gwei tip is 25 gwei (the 30 gwei cap
only leaves headroom). Without them, forge paid 32.5 gwei for the v1.3 deploys. `--private-key` puts the key in forge's
process arguments while it runs; `--interactive` instead of `--private-key "$REHEARSAL_KEY"` makes forge prompt for it.

**Budget.** The burner holds 4.47 USDC of gas.

| Part | Gas | USDC |
| --- | ---: | ---: |
| Run A deploy (measured on the fork) | 12,175,363 | 0.30 |
| Run A drive (measured on the fork) | 23,153,494 | 0.58 |
| Run B deploy (measured on the fork) | 12,154,743 | 0.30 |
| Run B drive (launch measured on the fork, the rest estimated from v1.3's Arc-USDC trades) | about 2.3M | 0.06 |
| Run B's surcharge, left in the launchpad for good | | 0.54 to 0.86 |
| **Total** | **about 50M** | **about 1.8 to 2.1** |

rUSDC is minted freely and is not part of this. The driver refuses any transaction past `GAS_CAP` (2 USDC of gas for Run
A's progress file, 1 for Run B's).

**Order matters.** Deploy Run A first, as the burner's next transaction, so it lands at nonce 272 and reproduces the fork
run's addresses and orientations (check `--preview` first). Run B's deploy then comes about 95 nonces later; Run B opens
no pool, so its orientation does not matter.

**Resuming.** Progress (token addresses, the pools' positions, mined transactions, finished steps) lives in
`deployments/<name>.progress.json`, which is gitignored:

- A re-run skips finished steps and never sends a transaction twice.
- A step whose checks fail stops the run; the next run checks it again at the mined transactions' blocks without
  re-sending them (Arc's RPC serves historical state).
- A transaction left in flight by a crash is looked up by its hash (saved before it is broadcast) and recorded.

At the end the driver writes the tokens, pool ids and totals into the deployment record, next to the addresses.

Settings: `DEPLOYMENT`, `PROGRESS`, `RPC_URL` (or `ARC_TESTNET_RPC`), `SIGNER` (`key`, `anvil` or `none`),
`REHEARSAL_KEY`, `ACTOR` (anvil only), `ARTIFACTS` (default `contracts-v14/out`), `GAS_CAP`, `FLOOR`, `RUNB_WINDOW_USDC`,
`SAMPLE_SECONDS` (default 20), `MARKDOWN=1`.

## The fork dry run

```bash
FOUNDRY_PROFILE=v14 forge build
scripts/v14-rehearsal-fork.sh              # Run A, end to end: about 90 s
RUN=b scripts/v14-rehearsal-fork.sh        # Run B, up to its first USDC transfer
```

The helper starts `anvil --fork-url https://rpc.testnet.arc.io` on a free port with `--chain-id 31337` (nothing signed
for it could ever be valid on Arc Testnet; the scripts refuse to sign for a local node that reports 5042002),
`--hardfork prague` (Arc Testnet's) and `--block-time 0.5` (Arc's pace, so a 20-block window lasts about 10 s, as live).
It impersonates the burner with `anvil_impersonateAccount`, gives it gas with `anvil_setBalance`, deploys with the Foundry
script as the burner (`--unlocked --sender`), records, drives with `SIGNER=anvil`, and stops anvil on exit whatever
happens. No key is used anywhere. Because the burner deploys at its real nonce, the fork's launchpad, hook, router,
plugins, RawSwapper and tokens have exactly the addresses a live deploy at nonce 272 will have.

With `ACTOR=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` (anvil's first default account) the default account deploys and
drives, and the burner is impersonated only to mint rUSDC and receives the platform fees as `feeTo`. That run also passed
(1,443 checks), at other addresses.

The run was also killed with SIGKILL in the middle of the `lock` steps and restarted: it resumed at the interrupted step,
re-sent nothing (81 transactions, 81 distinct) and passed.

### Results, by step

The final run, at `15ac4ea`, from a fork of Arc Testnet at block 63,984,515:

| step | transactions | checks | gas | USDC at 25 gwei | result |
| --- | ---: | ---: | ---: | ---: | --- |
| deploy | 7 | 36 | 12,175,363 | 0.304384 | deployed |
| raw | 1 | 10 | 780,827 | 0.019521 | pass |
| fund | 2 | 20 | 106,308 | 0.002658 | pass |
| approve | 2 | 18 | 92,532 | 0.002313 | pass |
| plan | 0 | 1 | 0 | 0 | pass |
| create:wallet | 2 | 56 | 1,888,711 | 0.047218 | pass |
| create:split | 2 | 36 | 2,054,995 | 0.051375 | pass |
| create:holders | 2 | 36 | 1,868,186 | 0.046705 | pass |
| create:combo | 2 | 36 | 2,207,526 | 0.055188 | pass |
| create:zero | 4 | 60 | 1,984,668 | 0.049617 | pass |
| curve:wallet | 2 | 30 | 195,475 | 0.004887 | pass |
| curve:split | 2 | 27 | 195,475 | 0.004887 | pass |
| curve:holders | 2 | 27 | 195,475 | 0.004887 | pass |
| curve:combo | 2 | 27 | 195,475 | 0.004887 | pass |
| curve:zero | 2 | 27 | 185,181 | 0.004630 | pass |
| graduate:wallet | 6 | 104 | 1,438,287 | 0.035957 | pass |
| graduate:split | 3 | 59 | 1,020,207 | 0.025505 | pass |
| graduate:holders | 6 | 99 | 1,403,069 | 0.035077 | pass |
| graduate:combo | 3 | 59 | 1,020,183 | 0.025505 | pass |
| graduate:zero | 3 | 59 | 992,268 | 0.024807 | pass |
| fund:raw | 3 | 27 | 136,359 | 0.003409 | pass |
| buyback:wallet | 2 | 32 | 292,759 | 0.007319 | pass |
| lock:split | 1 | 16 | 117,457 | 0.002936 | pass |
| buyback:holders | 2 | 32 | 292,287 | 0.007307 | pass |
| lock:combo | 1 | 16 | 117,457 | 0.002936 | pass |
| lock:zero | 1 | 16 | 117,457 | 0.002936 | pass |
| pool:wallet | 2 | 30 | 323,170 | 0.008079 | pass |
| pool:split | 2 | 30 | 318,441 | 0.007961 | pass |
| pool:holders | 2 | 30 | 317,056 | 0.007926 | pass |
| pool:combo | 2 | 30 | 317,565 | 0.007939 | pass |
| pool:zero | 2 | 30 | 312,745 | 0.007819 | pass |
| raw:wallet | 2 | 32 | 296,304 | 0.007408 | pass |
| raw:holders | 2 | 32 | 296,940 | 0.007424 | pass |
| lp | 3 | 40 | 492,248 | 0.012306 | pass |
| sync:wallet | 1 | 14 | 81,073 | 0.002027 | pass |
| syncBatch | 1 | 13 | 114,748 | 0.002869 | pass |
| collect:wallet | 1 | 12 | 71,825 | 0.001796 | pass |
| collect:split | 1 | 13 | 114,214 | 0.002855 | pass |
| release:split:1 | 1 | 11 | 110,678 | 0.002767 | pass |
| release:split:2 | 1 | 11 | 93,578 | 0.002339 | pass |
| release:split:3 | 1 | 11 | 88,778 | 0.002219 | pass |
| collect:holders | 1 | 17 | 236,684 | 0.005917 | pass |
| collect:combo | 1 | 19 | 395,676 | 0.009892 | pass |
| collect:zero | 1 | 11 | 39,039 | 0.000976 | pass |
| sample | 0 | 12 | 0 | 0 | pass |
| claim:holders | 1 | 17 | 96,480 | 0.002412 | pass |
| claim:combo | 1 | 16 | 96,480 | 0.002412 | pass |
| collectFees | 1 | 11 | 41,148 | 0.001029 | pass |
| final | 0 | 37 | 0 | 0 | pass |
| **total** | **95** | **1,445** | **35,328,857** | **0.883221** | **all pass** |

### What the run showed

- **Both windows.** All seven curve window buys paid the surcharge at their landed block (8,550 bps one block after the
  launch; RZRO's three at 8,550, 8,100 and 7,650), and `pendingSnipe` moved by exactly that each time. All five pool
  window buys paid 8,550 bps one block after graduation; the exact-out window buys paid 7,650 bps three blocks after, on
  the net. The window sells paid none. For the 10% tokens the creation block's 90% is capped to 88.5% (9,900 - 50 -
  1,000), as the spec caps it.
- **Graduation.** Every pool opened with 24,999.999969 to 24,999.999971 rUSDC and 200M tokens at the model's price
  (tick 366,200 with USDC as currency0, -366,201 as currency1), less than a part per billion from the curve's final
  price; the full-range position took all of the USDC; 7,440,651 to 83,139,851 wei of tokens were left over and burned;
  the curve surcharge (855 rUSDC, 2,430 for RZRO) became a bid from tick 373,200 to 465,400 (or -465,400 to -373,200)
  whose top is 0.497 of the graduation price, and the bid took all of it.
- **Bids.** The 150M-token dumps crossed into the bid range (tick 373,200 and -373,200); `lock` then placed nothing
  while 3,963 and 5,468 rUSDC of surcharge waited as claims. The buy back crossed out again, and `lock` placed it as salt
  2 at the same range. At the end every pool has three hook positions (the full range and two bids) and `lockHeld` is 0.
- **Fees.** Every pool fee sat in the hook as claims until a sync or collection released it; every release equalled what
  the hook held. At the end the launchpad holds 0 rUSDC (everything collected), the hook's claims are 0, and the
  PoolManager holds 23 units of rUSDC more than the 172,706.318472 its positions are worth (rounding in the pools'
  favour).
- **Dividends.** The Holders streams (RHLD directly, RCMB through Combo) grew by about `streamRate × dt × share` over 19 s
  (1,601,583 units against 1,601,581, and 35,369 against 35,360: `streamRate` is rounded down); each claim paid exactly
  `claimable` at its block; 1 unit of dust in each token overall.

### Gas per transaction

| step | transaction | gas | USDC at 25 gwei |
| --- | --- | ---: | ---: |
| deploy | launchpad | 5,264,637 | 0.131616 |
| deploy | hook | 2,919,373 | 0.072984 |
| deploy | router | 932,263 | 0.023307 |
| deploy | initialize | 78,336 | 0.001958 |
| deploy | split | 1,040,036 | 0.026001 |
| deploy | holders | 574,991 | 0.014375 |
| deploy | combo | 1,365,727 | 0.034143 |
| raw | deploy RawSwapper | 780,827 | 0.019521 |
| fund | mint 400000 rUSDC to the burner | 53,154 | 0.001329 |
| fund | mint 50000 rUSDC to the raw | 53,154 | 0.001329 |
| approve | approve the launchpad | 46,266 | 0.001157 |
| approve | approve the router | 46,266 | 0.001157 |
| create:wallet | createToken RWAL | 1,766,888 | 0.044172 |
| create:wallet | buy RWAL in the curve's window (1) | 121,823 | 0.003046 |
| create:split | createToken RSPL | 1,881,872 | 0.047047 |
| create:split | buy RSPL in the curve's window (1) | 173,123 | 0.004328 |
| create:holders | createToken RHLD | 1,746,363 | 0.043659 |
| create:holders | buy RHLD in the curve's window (1) | 121,823 | 0.003046 |
| create:combo | createToken RCMB | 2,034,403 | 0.050860 |
| create:combo | buy RCMB in the curve's window (1) | 173,123 | 0.004328 |
| create:zero | createToken RZRO | 1,634,652 | 0.040866 |
| create:zero | buy RZRO in the curve's window (1) | 150,872 | 0.003772 |
| create:zero | buy RZRO in the curve's window (2) | 99,572 | 0.002489 |
| create:zero | buy RZRO in the curve's window (3) | 99,572 | 0.002489 |
| curve:wallet | buy RWAL on the curve, after its window | 99,291 | 0.002482 |
| curve:wallet | sell RWAL on the curve (half) | 96,184 | 0.002405 |
| curve:split | buy RSPL on the curve, after its window | 99,291 | 0.002482 |
| curve:split | sell RSPL on the curve (half) | 96,184 | 0.002405 |
| curve:holders | buy RHLD on the curve, after its window | 99,291 | 0.002482 |
| curve:holders | sell RHLD on the curve (half) | 96,184 | 0.002405 |
| curve:combo | buy RCMB on the curve, after its window | 99,291 | 0.002482 |
| curve:combo | sell RCMB on the curve (half) | 96,184 | 0.002405 |
| curve:zero | buy RZRO on the curve, after its window | 94,140 | 0.002354 |
| curve:zero | sell RZRO on the curve (half) | 91,041 | 0.002276 |
| graduate:wallet | buy RWAL out (graduation) | 661,887 | 0.016547 |
| graduate:wallet | buy RWAL in the pool's window (router) | 234,356 | 0.005859 |
| graduate:wallet | sell RWAL in the pool's window (router) | 158,140 | 0.003954 |
| graduate:wallet | exact-out buy of 5000000 RWAL in the window (RawSwapper) | 168,308 | 0.004208 |
| graduate:wallet | dump 150000000 RWAL under the bid's top (router) | 173,933 | 0.004348 |
| graduate:wallet | lock RWAL while the price is under the bid's top | 41,663 | 0.001042 |
| graduate:split | buy RSPL out (graduation) | 644,787 | 0.016120 |
| graduate:split | buy RSPL in the pool's window (router) | 217,248 | 0.005431 |
| graduate:split | sell RSPL in the pool's window (router) | 158,172 | 0.003954 |
| graduate:holders | buy RHLD out (graduation) | 645,142 | 0.016129 |
| graduate:holders | buy RHLD in the pool's window (router) | 216,745 | 0.005419 |
| graduate:holders | sell RHLD in the pool's window (router) | 158,146 | 0.003954 |
| graduate:holders | exact-out buy of 5000000 RHLD in the window (RawSwapper) | 168,861 | 0.004222 |
| graduate:holders | dump 150000000 RHLD under the bid's top (router) | 172,561 | 0.004314 |
| graduate:holders | lock RHLD while the price is under the bid's top | 41,614 | 0.001040 |
| graduate:combo | buy RCMB out (graduation) | 644,787 | 0.016120 |
| graduate:combo | buy RCMB in the pool's window (router) | 217,256 | 0.005431 |
| graduate:combo | sell RCMB in the pool's window (router) | 158,140 | 0.003954 |
| graduate:zero | buy RZRO out (graduation) | 639,636 | 0.015991 |
| graduate:zero | buy RZRO in the pool's window (router) | 197,240 | 0.004931 |
| graduate:zero | sell RZRO in the pool's window (router) | 155,392 | 0.003885 |
| fund:raw | transfer 30000000 RWAL to the RawSwapper | 39,753 | 0.000994 |
| fund:raw | transfer 30000000 RHLD to the RawSwapper | 39,753 | 0.000994 |
| fund:raw | transfer 30000000 RSPL to the RawSwapper | 56,853 | 0.001421 |
| buyback:wallet | buy RWAL back above the bid's top (router) | 175,302 | 0.004383 |
| buyback:wallet | lock RWAL above the top | 117,457 | 0.002936 |
| lock:split | lock RSPL | 117,457 | 0.002936 |
| buyback:holders | buy RHLD back above the bid's top (router) | 175,455 | 0.004386 |
| buyback:holders | lock RHLD above the top | 116,832 | 0.002921 |
| lock:combo | lock RCMB | 117,457 | 0.002936 |
| lock:zero | lock RZRO | 117,457 | 0.002936 |
| pool:wallet | buy RWAL (router) | 165,981 | 0.004150 |
| pool:wallet | sell RWAL (router) | 157,189 | 0.003930 |
| pool:split | buy RSPL (router) | 160,369 | 0.004009 |
| pool:split | sell RSPL (router) | 158,072 | 0.003952 |
| pool:holders | buy RHLD (router) | 159,838 | 0.003996 |
| pool:holders | sell RHLD (router) | 157,218 | 0.003930 |
| pool:combo | buy RCMB (router) | 159,373 | 0.003984 |
| pool:combo | sell RCMB (router) | 158,192 | 0.003955 |
| pool:zero | buy RZRO (router) | 157,417 | 0.003935 |
| pool:zero | sell RZRO (router) | 155,328 | 0.003883 |
| raw:wallet | exact-out buy of 2000000 RWAL (RawSwapper) | 145,991 | 0.003650 |
| raw:wallet | exact-out sell for 100 rUSDC of RWAL (RawSwapper) | 150,313 | 0.003758 |
| raw:holders | exact-out buy of 2000000 RHLD (RawSwapper) | 146,604 | 0.003665 |
| raw:holders | exact-out sell for 100 rUSDC of RHLD (RawSwapper) | 150,336 | 0.003758 |
| lp | add outside liquidity to the open RSPL pool (RawSwapper) | 203,271 | 0.005082 |
| lp | buy RSPL through the outside liquidity (router) | 160,332 | 0.004008 |
| lp | remove half the outside liquidity (RawSwapper) | 128,645 | 0.003216 |
| sync:wallet | syncPoolFees RWAL | 81,073 | 0.002027 |
| syncBatch | syncPoolFeesBatch RSPL, RZRO, RWAL | 114,748 | 0.002869 |
| collect:wallet | collectCreatorFees RWAL | 71,825 | 0.001796 |
| collect:split | collectCreatorFees RSPL | 114,214 | 0.002855 |
| release:split:1 | Split release to payee 1 | 110,678 | 0.002767 |
| release:split:2 | Split release to payee 2 | 93,578 | 0.002339 |
| release:split:3 | Split release to payee 3 | 88,778 | 0.002219 |
| collect:holders | collectCreatorFees RHLD | 236,684 | 0.005917 |
| collect:combo | collectCreatorFees RCMB | 395,676 | 0.009892 |
| collect:zero | collectCreatorFees RZRO | 39,039 | 0.000976 |
| claim:holders | claim RHLD dividends | 96,480 | 0.002412 |
| claim:combo | claim RCMB dividends | 96,480 | 0.002412 |
| collectFees | collectFees | 41,148 | 0.001029 |

## Notes from the fork

**Uniswap v4 on Arc**

- The PoolManager on Arc Testnet is byte for byte the code the Foundry tests etch, and it has no protocol-fee controller,
  so new pools carry no protocol fee (the driver still checks `protocolFee == 0` on every pool read; Uniswap's owner could
  set a controller later).
- v4 wraps every hook revert: a refused donation surfaces as
  `WrappedError(hook, beforeDonate, DonationsRefused(), HookCallFailed())`, and likewise `ClosedPool`, `PartialFill` and
  `PoolCreationRestricted`. Anything that shows the reason (the site, an indexer) has to unwrap it.
- **The PoolManager's `Swap` event carries the pool's own swap, before the hook's fees.** An exact-in router buy of 2,000
  rUSDC logs `amount0 = -260000000` in the opening block (the rest was fees); a sell logs the gross USDC the pool paid,
  not what the trader received. Charts and trade history (V14-SPEC §9) must take the trader's amounts from the hook's
  `PoolTrade` event, or add its fees back.
- A token priced at a tiny fraction of a USDC unit per wei rounds coarsely in the sqrt price: in RHLD's pool (USDC is
  currency1) the swaps left 333,560 wei (3e-13 tokens) of rounding with the pool in all; in the other pools 1 to 5 wei.
- Gas: `createToken` is 1.63M to 2.03M (v1.3's was 3.2M to 3.4M: no launch pair to deploy); the sell-out buy with the
  pool's opening, the full-range add and the bid is 640k to 662k (v1.3's 240k to 286k); a router buy or sell about 155k
  to 166k (197k to 234k for the first buy into a new pool); `lock` 117k to place a bid, 42k to place nothing;
  `syncPoolFees` 81k; `collectCreatorFees` 39k (release only) to 396k (Combo); the suite's deploy 12.2M.

**The fork**

- anvil 1.8.1 forks Arc Testnet as is (the whole v4 stack, Multicall3, the CREATE2 deployer, rUSDC), throttled to 200
  compute units a second with retries against the public RPC's burst limit. The Foundry deploy script runs against it
  with `--unlocked --sender` after `anvil_impersonateAccount`. Nothing had to be etched.
- Arc's USDC at `0x36…00` answers `balanceOf` and `approve` on a fork, but `transfer`, `transferFrom` and `totalSupply`
  revert with empty data: the native-balance precompile behind it is missing. That is where Run B stops on a fork.
- `eth_call` at an explicit block runs with `block.number` equal to that block on both anvil and Arc's RPC, so the
  surcharge views are checked at a receipt's own block.
- The fork's base fee starts at Arc's 20 gwei and decays towards zero because anvil's blocks are empty (Arc holds it at
  20 gwei), so the fork's own costs mean nothing; every cost above is gas × 25 gwei.
- On the fork every window buy landed one block after the launch or graduation. Live, the receipt and the next send take
  a few seconds, so expect them 4 to 8 blocks in (a smaller surcharge); the checks use the landed block either way, and
  the final step fails if no window buy paid a surcharge at all.
