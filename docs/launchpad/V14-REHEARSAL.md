# Launchpad v1.4: the Arc Testnet rehearsal

This is the Arc Testnet rehearsal of V14-SPEC §11. It deploys the v1.4 suite with its own Foundry script, then drives
every part of it through real transactions against Uniswap's own v4 PoolManager on Arc Testnet
(`0x8366a39CC670B4001A1121B8F6A443A643e40951`). Five tokens are launched, bought inside and after the curve's snipe
window, graduated into Uniswap v4 and traded there, and every fee is synced, collected and paid out. The books are
checked to the unit after every transaction.

**Status, 2026-09-25: built, and proven end to end on a local anvil fork of Arc Testnet at `5880d6f`, which includes
`v14` at `82d410d`: the owner's option A (a buy's snipe fee becomes a bid inside that buy, and `lock` is gone) with
Claude review #9's cap (a window buy's bid starts from half the cheaper of the price just before it and the graduation
price, so no bid starts above half the graduation price). Nothing has been sent to Arc Testnet or mainnet.** The live
run waits for the two security reviews in progress.

| Fork dry run (Run A, rUSDC) | Transactions | Checks | Gas | USDC at 25 gwei |
| --- | ---: | ---: | ---: | ---: |
| deploy (the Foundry script) | 7 | 36 | 12,087,746 | 0.302194 |
| drive (5 tokens, 5 graduations) | 86 | 1,613 | 24,390,801 | 0.609770 |
| **total** | **93** | **1,649** | **36,478,547** | **0.911964** |

Every check passed, before and after each merge (option A, then the cap), and **no contract behaviour contradicted the
spec**. "USDC at 25 gwei" is what Arc Testnet charges (a 20 gwei base fee plus the node's 5 gwei tip, so 1M gas is
0.025 USDC); the fork's own gas prices mean nothing (below).

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
| RWAL | 1% → a plain wallet | closed | 100 rUSDC | 1 | USDC is currency0; exact-out and crash scenarios |
| RSPL | 10% → Split, payees 5/3/2 | open | none | 1 | USDC is currency0; takes outside liquidity |
| RHLD | 10% → Distribute to holders | closed | 100 rUSDC | 1 | USDC is currency1; exact-out and crash scenarios |
| RCMB | 1% → Combo: 50% holders, 30% Split (payees 1:1), 20% a wallet | open | none | 1 | USDC is currency0 |
| RZRO | 0% → a plain wallet | closed | none | 3 | USDC is currency0 |

**Which side of USDC a token sorts on decides which branch of the hook runs** (USDC as currency0 or currency1), and it
follows from the token's CREATE address, so from the deployer's nonce at deploy time. The driver predicts every token's
address before the first launch and runs the exact-out and crash scenarios on the first token of each orientation. At
the burner's current nonce (272) the third token, RHLD, sorts below rUSDC, so both orientations are covered, with the
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
  - the hook's claims, `PoolManager.balanceOf(hook, uint160(rUSDC))`, == `Σ (pendingPlatform + pendingCreator + lockHeld)`
    (V14-SPEC §11 says "at least", since anyone can add claims to the hook; nobody does here, so the run holds it to the
    unit);
  - **snipe fees never wait: `lockHeld` is 2 units or less for every token**;
  - no token's supply grows, and every token's supply sits with the addresses tracked (launchpad, burner, RawSwapper,
    PoolManager, hook).
- **The burner's own side**: its native balance moves by the gas alone (rUSDC), checked with the gas added back.

**Bids (V14-SPEC §5: option A, with Claude review #9's cap).** The curve's surcharge becomes the first bid at
graduation, from half the graduation price. Inside the pool's window every buy places its own surcharge, with the unit
or two any earlier bid left, as a bid in the same transaction. For each such buy the driver takes the cheaper of two
prices, as the hook's `_cheaperOf` does: the pool's tick at B-1 (the price just before the buy) and the graduation
tick. With USDC as currency0 that is the higher tick, otherwise the lower one. The bid's top is 6,932 ticks past it,
rounded away from the price onto the 200-tick spacing, and the bid runs 92,200 ticks down. So a buy from above the
graduation price gets the graduation bid's range, and a buy after a crash gets a range from half the crashed price. Then
it checks that:

- `BidLocked` equals that range, with the model's liquidity and USDC;
- the bid's top is not above half the graduation price (the graduation bid's top);
- the range is wholly on the USDC side of the tick the buy left;
- `ModifyLiquidity` adds a fresh position at salt `bidCount + 1`, and `StateView` shows that position's liquidity;
- the claims were minted for the fees and burned by exactly what the bid took, leaving `lockHeld` at 2 units or less;
- the PoolManager's rUSDC grew by the whole buy.

Every other trade must place nothing. The final step checks every bid position again: none starts above half the
graduation price.

The snipe windows are checked against the block each transaction actually landed in: the expected surcharge is
`9000 × (openBlock + 20 - B) / 20` bps, capped so all fees stay under 99%, from `createdBlock` (curve) or the graduation
block (pool) and the receipt's block number. The window transactions are sent the moment the launch or graduation is
mined, before any check reads the chain, so they land inside the 20 blocks (about 10 s on Arc).

Before each pool transaction the driver rebuilds the pool from its own record of positions (the hook's full-range
position, every bid, the RawSwapper's outside liquidity) and checks that model against StateView at B-1: the active
liquidity, every initialized tick's gross and net liquidity, every position's liquidity, and that the protocol and LP
fees are 0. Then it runs Uniswap's swap on the model and compares.

### Steps

| Step | What it proves |
| --- | --- |
| `deploy` | The deployment the Foundry script made: Uniswap's PoolManager on this chain is byte for byte the tests' fixture and has no protocol-fee controller; the launchpad, hook and router point at each other, the PoolManager and rUSDC; every constant matches the spec; **the hook address's low 14 bits are `0x28EC`**, `getHookPermissions()` is exactly those seven flags, and the address is CREATE2 of the recorded salt through `0x4e59…956C`, with init code equal to the local build's plus (PoolManager, launchpad, USDC); **each of the six contracts equals the local build byte for byte** (immutables and metadata hashes masked, as `scripts/verify-bytecode.ts` does). The deployer kept no power: `initialize` again, `setFeeTo`, `hook.graduate` and `hook.release` by a stranger all revert. |
| `raw`, `fund`, `approve` | The RawSwapper deploys and equals its build; the burner mints 400,000 rUSDC to itself and 50,000 to the RawSwapper; approvals. |
| `plan` | Predicts every token's address and which side of rUSDC it sorts on; picks the scenario tokens (the first of each orientation). |
| `create:*` | `createToken` registers the plugin, the creator fee, the open or closed choice, `createdBlock`; the token lands at its predicted address and is wired to the launchpad, router, PoolManager and hook; dividends exclude the launchpad, PoolManager, hook, `0x…dEaD` and 0; `hook.poolKeyOf` is the model's key. **The creator's first buy pays no surcharge although its block's is 90%.** Split, Combo and Holders are configured (write-once). Then the window buys, each at its landed block: the surcharge, `snipeBpsOf` at that block, the `Trade` event, the quote at the block before (with its own block's surcharge), and **`pendingSnipe` moving by exactly the surcharge**. Once, free: every refusal of `createToken` (the hook, the PoolManager, the router, rUSDC, the launchpad, zero, an existing token, the new token's own predicted address, a 10.01% fee, a raised launch fee, data for a plain address, a Split paying the PoolManager or the hook), nobody initializing the token's pool first, no transfer into the PoolManager before graduation, the router refusing a curve token, the hook knowing no pool yet (`snipeBpsOf` reverts `UnknownLaunch`), `syncPoolFees` booking nothing for a curve, `accrueTradeFees` reverting. |
| `curve:*` | After the window: a buy (quote at the block before == fill == model, no surcharge) and a sell of half (both fees on the gross, rounded up; no surcharge on sells); selling back returns less than was paid; deadlines, slippage and `ExceedsSold`. |
| `graduate:*` | The sell-out buy: the exact fill, and **the pool initialized at the price where one full-range position takes both amounts** (`Initialize`, `StateView.getSlot0`), within 1 ppm of the curve's final price `virtualUsdc / virtualTokens`; **the hook's full-range position (owner the hook, salt 0) with the model's liquidity**; **the leftover tokens burned**; **the first bid, the curve's surcharge, from half the graduation price** (`BidLocked` ticks equal the model from the graduation tick, its top 0.497 of the graduation price, `bidCount` 1, its own position at salt 1); `launchOf`; the pool's window opening at 90%; **the hook holding 0 rUSDC and claims equal to what it owes**. Then, inside the pool's window and sent before any check, on every token: **a 10,000 rUSDC router buy from the graduation price, whose bid lands on the graduation bid's range** (salt 2) and which lifts the price at least a tick spacing; then **a 2,000 rUSDC router buy from above the graduation price, whose bid is capped at half the graduation price**: the graduation bid's range again (salt 3), where half its own pre-buy price would have put it higher (checked, so the cap is what decided it). On the scenario tokens then **the crash case**: a 150M-token dump that takes the price under half the graduation price (crossing into the graduation bid), then **a router buy whose bid follows the price down**, placed from half the crashed pre-buy price (now the cheaper one), past the graduation bid's top, with nothing left waiting. Then a router sell on every token (no surcharge, no bid), and on the scenario tokens an exact-out buy through the RawSwapper, whose surcharge on a net amount becomes a bid the same way. |
| `pool:*` | After the window: router buy and sell, **quote == fill == model** both ways, fees held as claims, no surcharge and no bid. |
| `raw:*` | **Exact-out buy** (exactly the tokens asked; fees on the pool's net on top) and **exact-out sell** (exactly the USDC asked; the pool paid it plus the fees) through the RawSwapper; **a donation of either currency reverts** (`DonationsRefused`); an exact-in buy that a price limit stops early reverts (`PartialFill`). |
| `lp` | **Outside liquidity is refused by a closed pool** (`ClosedPool`) **and accepted by an open one** (RSPL): the position and its amounts match the model; a buy then trades through it and still pays every fee; the RawSwapper removes half of it and gets exactly the model's amounts. |
| `sync:wallet`, `syncBatch` | **`syncPoolFees` and `syncPoolFeesBatch` book exactly what the hook held** (`FeesReleased` == `PoolFeesAccrued` == the hook's pending fees at the block before; the claims burn by that, the PoolManager pays the launchpad that); a token with nothing held books nothing; `hook.release` by anyone else reverts. |
| `collect:*`, `release:split:*` | **`collectCreatorFees` syncs first** (RHLD and RCMB were never synced: their pool fees are released in the same transaction) **and pays each plugin**: the wallet by transfer, Split credited, Holders forwarding everything into the token's 24-hour stream (checked against the stream model), Combo splitting 50/30/20 through Holders, Split and a wallet; a 0% token collects nothing but still books its platform fees. **Split's `release`** pays each payee `totalReceived × share / 10 - released`. |
| `sample`, `claim:*` | **The Holders stream accrues**: two readings 20 s apart, claimable grows by about `streamRate × dt × share` and every view equals the model; the burner's claim pays exactly what `claimable` was at its block; everyone eligible has earned everything that streamed, within a unit or two. |
| `collectFees` | **`feeTo` receives exactly `pendingFees`.** |
| `final` | All invariants; every supply is 1e9 less only the graduation's leftover burn (read from `PoolOpened`); each pool's positions, ticks and bids match the model and `bidCount` equals its bid positions; **no bid position starts above half the graduation price**; **the PoolManager holds at least what every position is worth plus the hook's claims** (the rest is rounding in the pools' favour); both windows were exercised, and the cap and the crash case each in both pool orientations. |

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

On the fork Run B deployed (12,067,126 gas), passed its 34 deployment checks, approved (55,438 gas; Arc's USDC keeps
allowances in its own storage) and launched (1,626,278 gas), then stopped exactly where it must: the window buy's
`transferFrom` reverts with no revert data, because the native-balance precompile behind Arc's USDC does not exist on a
fork (`balanceOf` and `approve` answer; `transfer`, `transferFrom` and `totalSupply` revert).

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
| Run A deploy (measured on the fork) | 12,087,746 | 0.30 |
| Run A drive (measured on the fork) | 24,390,801 | 0.61 |
| Run B deploy (measured on the fork) | 12,067,126 | 0.30 |
| Run B drive (launch measured on the fork, the rest estimated from v1.3's Arc-USDC trades) | about 2.3M | 0.06 |
| Run B's surcharge, left in the launchpad for good | | 0.54 to 0.86 |
| **Total** | **about 51M** | **about 1.8 to 2.1** |

A buy inside the pool's window also places its bid. On the fork a router buy cost 155,000 to 161,000 gas after the
window and, inside it, 237,000 to 240,000 when its bid landed on ticks an earlier bid had opened (77,000 to 79,000 more)
and 283,000 to 284,000 when it opened new ones (122,000 to 124,000 more), within V14-SPEC §5's figures; the first buy
after graduation costs 254,000 to 291,000 because it also writes the pool's first fee balances. Run A has 14 such buys,
and its measured drive includes them. The cap adds 15,574 gas to the hook's deploy; the drive costs 0.04 USDC more than
before the cap only because it now makes seven more window buys, so that every token has a lifting buy and a capped
buy. rUSDC is minted freely and is not part of this. The driver refuses any transaction past `GAS_CAP` (2 USDC of gas
for Run A's progress file, 1 for Run B's).

**Order matters.** Deploy Run A first, as the burner's next transaction, so it lands at nonce 272 and reproduces the fork
run's addresses and orientations (check `--preview` first). Run B's deploy then comes 93 nonces later; Run B opens no
pool, so its orientation does not matter.

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

Three more runs at `5880d6f`:

- With `ACTOR=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` (anvil's first default account) the default account deploys
  and drives, and the burner is impersonated only to mint rUSDC and receives the platform fees as `feeTo`. It passed
  (1,634 checks) at other addresses, where the planner picked RSPL (USDC as currency0) and RWAL (currency1) for the
  scenarios, so the outside liquidity went into a crashed open pool.
- The driver was killed with SIGKILL while a pool trade after the window was in flight, then restarted. It found the
  transaction mined and recorded it, re-sent nothing (86 transactions, 86 distinct, no action twice) and passed all
  1,649 checks.
- It was also killed while RWAL's second window buy was in flight, inside the pool's window. The restart recorded that
  buy and re-sent nothing (86 transactions, 86 distinct), but the window's remaining transactions (the dump, the crash
  buy, the sell and the exact-out buy) then went out 32 to 35 blocks after graduation, past the window. They were
  checked as such (no surcharge, no bid), every other check passed, and the final step failed on the crash case for USDC
  as currency0, as it must. **An interruption inside a pool's window costs that token's remaining window cases, and
  nothing else.**

### Results, by step

The final run, at `5880d6f`, from a fork of Arc Testnet at block 64,046,791:

| step | transactions | checks | gas | USDC at 25 gwei | result |
| --- | ---: | ---: | ---: | ---: | --- |
| deploy | 7 | 36 | 12,087,746 | 0.302194 | deployed |
| raw | 1 | 11 | 780,827 | 0.019521 | pass |
| fund | 2 | 22 | 106,308 | 0.002658 | pass |
| approve | 2 | 20 | 92,532 | 0.002313 | pass |
| plan | 0 | 1 | 0 | 0 | pass |
| create:wallet | 2 | 58 | 1,888,711 | 0.047218 | pass |
| create:split | 2 | 38 | 2,054,995 | 0.051375 | pass |
| create:holders | 2 | 38 | 1,868,186 | 0.046705 | pass |
| create:combo | 2 | 38 | 2,207,526 | 0.055188 | pass |
| create:zero | 4 | 64 | 1,984,668 | 0.049617 | pass |
| curve:wallet | 2 | 32 | 195,475 | 0.004887 | pass |
| curve:split | 2 | 29 | 195,475 | 0.004887 | pass |
| curve:holders | 2 | 29 | 195,475 | 0.004887 | pass |
| curve:combo | 2 | 29 | 195,475 | 0.004887 | pass |
| curve:zero | 2 | 29 | 185,181 | 0.004630 | pass |
| graduate:wallet | 7 | 165 | 2,090,654 | 0.052266 | pass |
| graduate:split | 4 | 96 | 1,314,030 | 0.032851 | pass |
| graduate:holders | 7 | 160 | 2,057,285 | 0.051432 | pass |
| graduate:combo | 4 | 96 | 1,314,002 | 0.032850 | pass |
| graduate:zero | 4 | 96 | 1,283,791 | 0.032095 | pass |
| fund:raw | 3 | 30 | 136,359 | 0.003409 | pass |
| pool:wallet | 2 | 34 | 318,152 | 0.007954 | pass |
| pool:split | 2 | 34 | 317,865 | 0.007947 | pass |
| pool:holders | 2 | 34 | 317,651 | 0.007941 | pass |
| pool:combo | 2 | 34 | 318,881 | 0.007972 | pass |
| pool:zero | 2 | 34 | 313,037 | 0.007826 | pass |
| raw:wallet | 2 | 36 | 297,001 | 0.007425 | pass |
| raw:holders | 2 | 36 | 297,322 | 0.007433 | pass |
| lp | 3 | 44 | 492,504 | 0.012313 | pass |
| sync:wallet | 1 | 15 | 81,054 | 0.002026 | pass |
| syncBatch | 1 | 14 | 114,710 | 0.002868 | pass |
| collect:wallet | 1 | 13 | 71,825 | 0.001796 | pass |
| collect:split | 1 | 14 | 114,214 | 0.002855 | pass |
| release:split:1 | 1 | 12 | 110,678 | 0.002767 | pass |
| release:split:2 | 1 | 12 | 93,578 | 0.002339 | pass |
| release:split:3 | 1 | 12 | 93,578 | 0.002339 | pass |
| collect:holders | 1 | 18 | 236,669 | 0.005917 | pass |
| collect:combo | 1 | 20 | 381,980 | 0.009550 | pass |
| collect:zero | 1 | 12 | 39,039 | 0.000976 | pass |
| sample | 0 | 12 | 0 | 0 | pass |
| claim:holders | 1 | 18 | 96,480 | 0.002412 | pass |
| claim:combo | 1 | 17 | 96,480 | 0.002412 | pass |
| collectFees | 1 | 12 | 41,148 | 0.001029 | pass |
| final | 0 | 45 | 0 | 0 | pass |
| **total** | **93** | **1,649** | **36,478,547** | **0.911964** | **all pass** |

### What the run showed

- **Both windows.** All seven curve window buys paid the surcharge at their landed block (8,550 bps one block after the
  launch; RZRO's three at 8,550, 8,100 and 7,650), and `pendingSnipe` moved by exactly that each time. In the pool's
  window the lifting buys paid 8,550 bps one block after graduation and the capped buys 8,100 two blocks after; the
  crash buys (RWAL, RHLD) paid 6,750 five blocks after, and the exact-out buys 5,850 and 5,400 seven and eight blocks
  after, on the net. The window sells paid none. For the 10% tokens the creation block's 90% is capped to 88.5%
  (9,900 - 50 - 1,000), as the spec caps it.
- **Graduation.** Every pool opened with 24,999.999969 to 24,999.999971 rUSDC and 200M tokens at the model's price
  (tick 366,200 with USDC as currency0, -366,201 as currency1), less than a part per billion from the curve's final
  price; the full-range position took all of the USDC; 7,440,651 to 83,139,851 wei of tokens were left over and burned;
  the curve's surcharge (855 rUSDC, 2,430 for RZRO) became the first bid, from tick 373,200 to 465,400 (or -465,400 to
  -373,200), whose top is 0.497 of the graduation price, and the bid took all of it.
- **Bids inside the buys.** On every token the first window buy (10,000 rUSDC) started at the graduation tick, so its
  bid (8,550 rUSDC) landed on the graduation bid's range, at salt 2. It lifted the tick by 1,014 (RWAL, RCMB), 1,090
  (RZRO) or 317 (RSPL and RHLD, whose 10% creator fee leaves less of the buy for the pool).
- **The cap.** The second window buy (2,000 rUSDC) then started above the graduation price, and its bid (1,620 rUSDC)
  landed on the graduation bid's range again, at salt 3, in both orientations. Half its own pre-buy price would have put
  the bid's top at 372,200 (373,000 on RSPL, -373,000 on RHLD) instead of 373,200 (-373,200), above half the graduation
  price.
- **The crash case.** The dumps took RWAL's tick to 375,398 (RHLD's to -375,703), through the graduation bid. The next
  window buy then placed its 1,350 rUSDC from that crashed tick, now the cheaper price, at [382,400, 474,600] (RHLD:
  [-475,000, -382,800]), past the graduation bid's top. The exact-out window buys bid from their own pre-buy ticks
  ([382,000, 474,200] and [-474,600, -382,400]).
- **Every bid** sat wholly under the market, none started above half the graduation price, every one took all it was
  given (`lockHeld` 0 after each), and the PoolManager's rUSDC grew by each whole buy. At the end RWAL and RHLD hold six
  hook positions (the full range and five bids), the others four; the capped bids opened no ticks.
- **Fees.** Every pool fee sat in the hook as claims until a sync or collection released it; every release equalled what
  the hook held. At the end the launchpad holds 0 rUSDC (everything collected), the hook's claims are 0, and the
  PoolManager holds 30 units of rUSDC more than the 174,562.232762 its positions are worth (rounding in the pools'
  favour).
- **Dividends.** The Holders streams (RHLD directly, RCMB through Combo) grew by about `streamRate × dt × share` over 20 s
  (1,257,761 units against 1,257,758, and 46,977 against 46,960: `streamRate` is rounded down); each claim paid exactly
  `claimable` at its block; 2 units of dust in RHLD (two holders) and 1 in RCMB at the end.

### Gas per transaction

| step | transaction | gas | USDC at 25 gwei |
| --- | --- | ---: | ---: |
| deploy | launchpad | 5,264,637 | 0.131616 |
| deploy | hook | 2,831,744 | 0.070794 |
| deploy | router | 932,275 | 0.023307 |
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
| graduate:wallet | buy RWAL out (graduation) | 660,312 | 0.016508 |
| graduate:wallet | buy RWAL in the pool's window (router) | 290,885 | 0.007272 |
| graduate:wallet | buy RWAL again in the pool's window, above the graduation price (router) | 239,665 | 0.005992 |
| graduate:wallet | dump 150000000 RWAL under half the graduation price (router) | 174,213 | 0.004355 |
| graduate:wallet | buy RWAL in the pool's window after the crash (router) | 282,922 | 0.007073 |
| graduate:wallet | sell RWAL in the pool's window (router) | 157,340 | 0.003934 |
| graduate:wallet | exact-out buy of 5000000 RWAL in the window (RawSwapper) | 285,317 | 0.007133 |
| graduate:split | buy RSPL out (graduation) | 643,200 | 0.016080 |
| graduate:split | buy RSPL in the pool's window (router) | 273,865 | 0.006847 |
| graduate:split | buy RSPL again in the pool's window, above the graduation price (router) | 238,705 | 0.005968 |
| graduate:split | sell RSPL in the pool's window (router) | 158,260 | 0.003956 |
| graduate:holders | buy RHLD out (graduation) | 643,535 | 0.016088 |
| graduate:holders | buy RHLD in the pool's window (router) | 272,703 | 0.006818 |
| graduate:holders | buy RHLD again in the pool's window, above the graduation price (router) | 237,559 | 0.005939 |
| graduate:holders | dump 150000000 RHLD under half the graduation price (router) | 173,673 | 0.004342 |
| graduate:holders | buy RHLD in the pool's window after the crash (router) | 284,099 | 0.007102 |
| graduate:holders | sell RHLD in the pool's window (router) | 157,370 | 0.003934 |
| graduate:holders | exact-out buy of 5000000 RHLD in the window (RawSwapper) | 288,346 | 0.007209 |
| graduate:combo | buy RCMB out (graduation) | 643,212 | 0.016080 |
| graduate:combo | buy RCMB in the pool's window (router) | 273,785 | 0.006845 |
| graduate:combo | buy RCMB again in the pool's window, above the graduation price (router) | 239,665 | 0.005992 |
| graduate:combo | sell RCMB in the pool's window (router) | 157,340 | 0.003934 |
| graduate:zero | buy RZRO out (graduation) | 638,061 | 0.015952 |
| graduate:zero | buy RZRO in the pool's window (router) | 253,797 | 0.006345 |
| graduate:zero | buy RZRO again in the pool's window, above the graduation price (router) | 236,585 | 0.005915 |
| graduate:zero | sell RZRO in the pool's window (router) | 155,348 | 0.003884 |
| fund:raw | transfer 30000000 RWAL to the RawSwapper | 39,753 | 0.000994 |
| fund:raw | transfer 30000000 RHLD to the RawSwapper | 39,753 | 0.000994 |
| fund:raw | transfer 30000000 RSPL to the RawSwapper | 56,853 | 0.001421 |
| pool:wallet | buy RWAL (router) | 160,844 | 0.004021 |
| pool:wallet | sell RWAL (router) | 157,308 | 0.003933 |
| pool:split | buy RSPL (router) | 160,525 | 0.004013 |
| pool:split | sell RSPL (router) | 157,340 | 0.003934 |
| pool:holders | buy RHLD (router) | 160,313 | 0.004008 |
| pool:holders | sell RHLD (router) | 157,338 | 0.003933 |
| pool:combo | buy RCMB (router) | 160,561 | 0.004014 |
| pool:combo | sell RCMB (router) | 158,320 | 0.003958 |
| pool:zero | buy RZRO (router) | 157,637 | 0.003941 |
| pool:zero | sell RZRO (router) | 155,400 | 0.003885 |
| raw:wallet | exact-out buy of 2000000 RWAL (RawSwapper) | 145,630 | 0.003641 |
| raw:wallet | exact-out sell for 100 rUSDC of RWAL (RawSwapper) | 151,371 | 0.003784 |
| raw:holders | exact-out buy of 2000000 RHLD (RawSwapper) | 146,939 | 0.003673 |
| raw:holders | exact-out sell for 100 rUSDC of RHLD (RawSwapper) | 150,383 | 0.003760 |
| lp | add outside liquidity to the open RSPL pool (RawSwapper) | 203,239 | 0.005081 |
| lp | buy RSPL through the outside liquidity (router) | 160,652 | 0.004016 |
| lp | remove half the outside liquidity (RawSwapper) | 128,613 | 0.003215 |
| sync:wallet | syncPoolFees RWAL | 81,054 | 0.002026 |
| syncBatch | syncPoolFeesBatch RSPL, RZRO, RWAL | 114,710 | 0.002868 |
| collect:wallet | collectCreatorFees RWAL | 71,825 | 0.001796 |
| collect:split | collectCreatorFees RSPL | 114,214 | 0.002855 |
| release:split:1 | Split release to payee 1 | 110,678 | 0.002767 |
| release:split:2 | Split release to payee 2 | 93,578 | 0.002339 |
| release:split:3 | Split release to payee 3 | 93,578 | 0.002339 |
| collect:holders | collectCreatorFees RHLD | 236,669 | 0.005917 |
| collect:combo | collectCreatorFees RCMB | 381,980 | 0.009550 |
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
- **The PoolManager's `Swap` event carries the pool's own swap, before the hook's fees.** RCMB's first window buy of
  10,000 rUSDC logs `amount0 = -1300000000`: the other 8,700 were fees (8,550 of them now a bid); a sell logs the gross
  USDC the pool paid, not what the trader received. Charts and trade history (V14-SPEC §9) must take the trader's amounts
  from the hook's `PoolTrade` event, or add its fees back.
- **Bids share the graduation bid's ticks unless the price crashed.** Each window buy places its bid from half the
  cheaper of its pre-buy price and the graduation price, so every buy from at or above the graduation price adds a
  position on the graduation bid's own ticks (salts 2 and 3 here), and only a buy after a crash opens a new range, from
  half the crashed price. Each new range initializes two ticks, which is where the crash and exact-out buys' extra gas
  goes: V14-SPEC §5 gives about 56,000 to 93,000 more gas than the same buy after the window on existing ticks and
  117,000 to 176,000 on new ones; the fork measured 77,000 to 79,000 and 122,000 to 124,000 on router buys.
- A token priced at a tiny fraction of a USDC unit per wei rounds coarsely in the sqrt price: in RHLD's pool (USDC is
  currency1) the swaps left 2,069,897 wei (2e-12 tokens) of rounding with the pool in all; in the other pools 2 to 5 wei.
- Gas: `createToken` is 1.63M to 2.03M (v1.3's was 3.2M to 3.4M: no launch pair to deploy); the sell-out buy with the
  pool's opening, the full-range add and the first bid is 638k to 660k (v1.3's 240k to 286k); a router buy or sell after
  the window about 155k to 161k; a window buy 237k to 240k when its bid lands on ticks an earlier bid opened, 254k to
  291k for the first buy after graduation (which also writes the pool's first fee balances), 283k to 288k when it opens
  new ticks; `syncPoolFees` 81k; `collectCreatorFees` 39k (release only) to 382k (Combo); the suite's deploy 12.1M.

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
- On the fork the window transactions landed 1 to 8 blocks after the launch or graduation. Live, each needs its receipt
  before the next is sent (1 to 3 s on Arc; its RPC answers in about 35 ms from here, and Arc Testnet made 1,000 blocks
  in 510 s, so a 20-block window lasts about 10 s). The pool's window transactions therefore go out in the order the
  cases need: the lifting buy, the capped buy, then on the scenario tokens the dump and the crash buy, and only then the
  window sell and the exact-out buy. The crash buy is the fourth transaction after graduation: it lands inside the
  window if each transaction takes under about 2.5 s from send to receipt. The checks use the landed block either way
  (a late buy must pay no surcharge and place no bid), and the final step fails if the cap or the crash case is missing
  in either orientation.
