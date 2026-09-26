# Launchpad v1.4: the Arc Testnet rehearsal

This is the Arc Testnet rehearsal of V14-SPEC §11. It deploys the v1.4 suite with its own Foundry script, then drives
every part of it through real transactions against Uniswap's own v4 PoolManager on Arc Testnet
(`0x8366a39CC670B4001A1121B8F6A443A643e40951`). Five tokens are launched, bought inside and after the curve's snipe
window, graduated into Uniswap v4 and traded there, and every fee is synced, collected and paid out. The books are
checked to the unit after every transaction.

**Status, 2026-09-26: run live on Arc Testnet, and both runs passed.** Run A (rUSDC) and Run B (Arc's own USDC) were
deployed with the Foundry script and driven from `v14-rehearsal` at `3bc28ab`, which includes `v14` at `1fa9e54`: the
owner's option A (a buy's snipe fee becomes a bid inside that buy, and `lock` is gone), with every window bid placed
from half the pool's reference, `bidRefTick`, the lowest price any window buy has started from (Claude review #9's L1
and its residual). Since `39a78b4` the contracts have changed only in comments. The deployment records and Foundry's
broadcasts are committed as `aa9e5c1`. Nothing has been sent to mainnet.

| Live run, Arc Testnet (chain 5042002) | Transactions | Checks | Gas | USDC at 25 gwei |
| --- | ---: | ---: | ---: | ---: |
| Run A (rUSDC): deploy (the Foundry script) | 7 | 36 | 12,134,854 | 0.303371 |
| Run A: drive (5 tokens, 5 graduations) | 90 | 1,726 | 25,299,447 | 0.632486 |
| Run B (Arc's USDC): deploy | 7 | 34 | 12,114,234 | 0.302856 |
| Run B: drive (1 token, curve only) | 8 | 157 | 2,324,017 | 0.058100 |
| **total** | **112** | **1,953** | **51,872,552** | **1.296814** |

Every check passed on the first attempt, each run in one pass (no step re-run, nothing re-sent), and **no contract
behaviour contradicted the spec**. The burner's native balance fell from 4.472875 to 3.095060 USDC (nonce 272 to 384,
all 112 transactions its own): exactly the gas above, every transaction at 25 gwei, plus the 0.081001 USDC that Run B
left in its launchpad for good (its window buy's surcharge and 1 unit of curve float). That is inside the budget.
"USDC at 25 gwei" is what Arc Testnet charges: a 20 gwei base fee plus the node's 5 gwei tip, so 1M gas is 0.025 USDC.

The anvil-fork dry run of the same scripts is kept below as the pre-flight: at `f9649d4` it passed with 97
transactions and 1,721 checks, and the live Run A matched it to within 1,112 gas. The live results are under "The
live run", after the plan and the commands.

## The scripts

| File | What it does |
| --- | --- |
| `contracts-v14/script/DeployLaunchpadV14.s.sol` | Deploys the suite (unchanged): the launchpad, the hook at a mined CREATE2 address through the deterministic deployer, the router, the wiring, and the Split, Distribute to holders and Combo plugins. |
| `scripts/v14-rehearsal-record.ts` | Writes the deployment record from Foundry's broadcast: every receipt succeeded, every contract has code, the hook is CREATE2 of its salt and init code with the low 14 bits `0x28EC`, the contracts point at each other. |
| `scripts/v14-rehearsal.ts` | The driver: Run A or Run B (from the record's USDC), resumable, every transaction checked; the pool window's transactions planned from the model and sent back to back. `--preview` shows which tokens a deploy at the deployer's next nonces would sort below USDC. |
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
| RWAL | 1% → a plain wallet | closed | 100 rUSDC | 1 | USDC is currency0; crash, lift-back and exact-out scenarios |
| RSPL | 10% → Split, payees 5/3/2 | open | none | 1 | USDC is currency0; takes outside liquidity |
| RHLD | 10% → Distribute to holders | closed | 100 rUSDC | 1 | USDC is currency1; crash, lift-back and exact-out scenarios |
| RCMB | 1% → Combo: 50% holders, 30% Split (payees 1:1), 20% a wallet | open | none | 1 | USDC is currency0 |
| RZRO | 0% → a plain wallet | closed | none | 3 | USDC is currency0 |

**Which side of USDC a token sorts on decides which branch of the hook runs** (USDC as currency0 or currency1), and it
follows from the token's CREATE address, so from the deployer's nonce at deploy time. The driver predicts every token's
address before the first launch and runs the crash, lift-back and exact-out scenarios on the first token of each
orientation. At the burner's current nonce (272) the third token, RHLD, sorts below rUSDC, so both orientations are
covered, with the very addresses the fork run used. `bun run scripts/v14-rehearsal.ts --preview` shows it for the next
six nonces; if the burner sends anything else first, check it again (nonces 274 to 277 put every token on the same
side).

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

Every transaction is simulated first (a revert costs nothing) and checked at the block it landed in, B, against B-1.
In the pool's window, where several of the run's transactions can land in one block, each one after the first in its
block is checked against the model's state after the one before it, and the block's books are checked once for all of
them (below). The checks:

- **Its result**, against the contracts' own quotes and an independent model: the curve (V13-SPEC §5 with the snipe fee
  as a third fee), the hook's fees (V14-SPEC §3: on the gross or on the net, split platform first), Uniswap's pool math
  to the unit (every swap step across ticks, every add, every bid), the graduation, and LaunchToken's dividend stream fed
  with the token's own storage.
- **Its events**: the launchpad's (`Trade`, `Graduated`, `PoolFeesAccrued`, ...), the hook's (`PoolOpened`, `PoolTrade`,
  `BidLocked`, `FeesReleased`), Uniswap's (`Initialize`, `ModifyLiquidity`, `Swap`, and the ERC-6909 `Transfer`s that mint
  and burn the hook's claims), the plugins' and the token's.
- **Everything else**: one Multicall3 snapshot per block of about 140 quantities (every tracked rUSDC balance, the
  launchpad's accruals, every curve, every token's supply and holders, the hook's pending fees, lockHeld, bidCount,
  bidRefTick and claims, every pool's price, tick and liquidity). Each must move by exactly what the model says, and
  every other one must not move at all.
- **The invariants** (V14-SPEC §11), at every block:
  - launchpad rUSDC == `pendingFees + Σ pendingCreatorFees + Σ pendingSnipe + Σ (virtualUsdc - VIRTUAL_USDC_0)` over
    live curves;
  - the hook holds no rUSDC and no launch token;
  - the hook's claims, `PoolManager.balanceOf(hook, uint160(rUSDC))`, == `Σ (pendingPlatform + pendingCreator + lockHeld)`
    (V14-SPEC §11 says "at least", since anyone can add claims to the hook; nobody does here, so the run holds it to the
    unit);
  - **snipe fees never wait: `lockHeld` is 2 units or less for every token**;
  - **every pool's reference, `bidRefTick`, never rises from one block to the next, and is never above the graduation
    price**;
  - no token's supply grows, and every token's supply sits with the addresses tracked (launchpad, burner, RawSwapper,
    PoolManager, hook).
- **The burner's own side**: its native balance moves by the gas alone (rUSDC), checked with the gas added back.

**Bids (V14-SPEC §5: option A, from the pool's reference).** The curve's surcharge becomes the first bid at
graduation, from half the graduation price, and `launchOf` shows the pool's reference, `bidRefTick`, starting at the
graduation tick. Inside the pool's window every buy places its own surcharge, with the unit or two any earlier bid
left, as a bid in the same transaction. For each such buy the driver takes the cheaper of two prices, as the hook's
`_cheaperOf` does: the pool's tick just before the buy and the pool's reference just before it (with USDC as currency0
the higher tick, otherwise the lower one). That is the buy's reference, and the pool's from then on, so the reference
only ever moves down. The bid's top is 6,932 ticks past it, rounded away from the price onto the 200-tick spacing, and
the bid runs 92,200 ticks down. So a buy from above the graduation price gets the graduation bid's range while nothing
has crashed, a buy after a crash gets a range from half the crashed price, and every buy after that one stays there,
however far the price is lifted again. Then it checks that:

- `bidRefTick` after the buy equals that reference;
- `BidLocked` equals that range, with the model's liquidity and USDC;
- the bid's top is not above half the graduation price (the graduation bid's top);
- the range is wholly on the USDC side of the tick the buy left;
- `ModifyLiquidity` adds a fresh position at salt `bidCount + 1`, and `StateView` shows that position's liquidity;
- the claims were minted for the fees and burned by exactly what the bid took, leaving `lockHeld` at 2 units or less;
- the PoolManager's rUSDC grew by the whole buy (from the transaction's own `Transfer` logs).

Every other trade must place nothing and leave the reference alone. The final step checks every bid position again
(none starts above half the graduation price) and where each pool's reference ended.

The snipe windows are checked against the block each transaction actually landed in: the expected surcharge is
`9000 × (openBlock + 20 - B) / 20` bps, capped so all fees stay under 99%, from `createdBlock` (curve) or the graduation
block (pool) and the receipt's block number. The curve's window buys are sent the moment the launch is mined, before any
check reads the chain.

**The pool's window transactions go out back to back.** The moment the sell-out buy is mined, the driver plans the
window from the model (the pool the graduation opened, which the checks hold to the chain afterwards) and sends the
whole batch in nonce order without waiting for any receipt in between; the scenario tokens send a second batch as soon
as the first is mined, its lift sized from the first batch as it landed. Because nothing waits between transactions:

- **each buy's minimum out is 95% of the lowest fill it can get**, whichever blocks the batch lands in: the batch is
  modelled landing whole in every block from the latest to the window's end (a later block lowers a buy's own surcharge
  but puts more of every earlier buy into the pool, so these bound any split) and the lowest fill is kept; the dump
  goes out with no minimum;
- **each gas limit is a fresh estimate with 30% or 200,000 on top, whichever is more** (V14-SPEC §5): the first
  transaction is simulated with its real arguments, the others are estimated with a minimum of 0 against the state
  before the batch's earlier transactions land, and the limit covers what those change (a crash moves the next bid
  onto new ticks, for example);
- **transactions that share a block are checked in order**: the first against B-1 as usual, each one after it against
  the model's state after the one before (which that one's own events checked: `Swap`, `PoolTrade`, `BidLocked`,
  `ModifyLiquidity`, the claims), and the block's books once, with every tracked quantity moving by the sum of the
  block's transactions and the burner's native balance by all their gas. A quote at B-1 is compared with a fill only
  when the trade was first in its block.

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
| `graduate:*` | The sell-out buy: the exact fill, and **the pool initialized at the price where one full-range position takes both amounts** (`Initialize`, `StateView.getSlot0`), within 1 ppm of the curve's final price `virtualUsdc / virtualTokens`; **the hook's full-range position (owner the hook, salt 0) with the model's liquidity**; **the leftover tokens burned**; **the first bid, the curve's surcharge, from half the graduation price** (`BidLocked` ticks equal the model from the graduation tick, its top 0.497 of the graduation price, `bidCount` 1, its own position at salt 1); `launchOf`, with `bidRefTick` at the graduation tick; the pool's window opening at 90%; **the hook holding 0 rUSDC and claims equal to what it owes**. Then the pool's window, sent back to back before any check. On every token: **a 10,000 rUSDC router buy from the graduation price, whose bid lands on the graduation bid's range** (salt 2) and which lifts the price at least a tick spacing; then **a 2,000 rUSDC router buy from above the graduation price, whose bid still starts from half the graduation price**, the pool's reference: the graduation bid's range again (salt 3), where half its own pre-buy price would have put it higher (checked, so the reference is what decided it). On the scenario tokens, in the same batch, **the crash case**: a 150M-token dump that takes the price under half the graduation price (crossing into the graduation bid), then **a router buy whose bid follows the price down**: the crashed price becomes the pool's reference and the bid starts from half of it, past the graduation bid's top, with nothing left waiting. Then, in a second batch, **the lift-back case**: a router buy sized to lift the price back above the graduation price, and one more router buy from up there; **both bids must still start from half the crashed price** (a cap at the graduation price alone would have put the second on the graduation bid's range, checked). Then a router sell (no surcharge, no bid, the reference unchanged), and on the scenario tokens an exact-out buy through the RawSwapper, whose surcharge on a net amount becomes a bid from the crashed reference too. The other tokens send their sell in their one batch. |
| `pool:*` | After the window: router buy and sell, **quote == fill == model** both ways, fees held as claims, no surcharge and no bid. |
| `raw:*` | **Exact-out buy** (exactly the tokens asked; fees on the pool's net on top) and **exact-out sell** (exactly the USDC asked; the pool paid it plus the fees) through the RawSwapper; **a donation of either currency reverts** (`DonationsRefused`); an exact-in buy that a price limit stops early reverts (`PartialFill`). |
| `lp` | **Outside liquidity is refused by a closed pool** (`ClosedPool`) **and accepted by an open one** (RSPL): the position and its amounts match the model; a buy then trades through it and still pays every fee; the RawSwapper removes half of it and gets exactly the model's amounts. |
| `sync:wallet`, `syncBatch` | **`syncPoolFees` and `syncPoolFeesBatch` book exactly what the hook held** (`FeesReleased` == `PoolFeesAccrued` == the hook's pending fees at the block before; the claims burn by that, the PoolManager pays the launchpad that); a token with nothing held books nothing; `hook.release` by anyone else reverts. |
| `collect:*`, `release:split:*` | **`collectCreatorFees` syncs first** (RHLD and RCMB were never synced: their pool fees are released in the same transaction) **and pays each plugin**: the wallet by transfer, Split credited, Holders forwarding everything into the token's 24-hour stream (checked against the stream model), Combo splitting 50/30/20 through Holders, Split and a wallet; a 0% token collects nothing but still books its platform fees. **Split's `release`** pays each payee `totalReceived × share / 10 - released`. |
| `sample`, `claim:*` | **The Holders stream accrues**: two readings 20 s apart, claimable grows by about `streamRate × dt × share` and every view equals the model; the burner's claim pays exactly what `claimable` was at its block; everyone eligible has earned everything that streamed, within a unit or two. |
| `collectFees` | **`feeTo` receives exactly `pendingFees`.** |
| `final` | All invariants; every supply is 1e9 less only the graduation's leftover burn (read from `PoolOpened`); each pool's positions, ticks and bids match the model and `bidCount` equals its bid positions; **no bid position starts above half the graduation price**; **each pool's `bidRefTick` ended where the model says** (the crashed price on the scenario tokens, the graduation price on the others); **the PoolManager holds at least what every position is worth plus the hook's claims** (the rest is rounding in the pools' favour); both windows were exercised, and the cap, the crash case and the lift-back case each in both pool orientations. |

## Run B: Arc's own USDC

Arc's USDC (`0x3600000000000000000000000000000000000000`) is a precompile behind an ERC-20 face; the gas token is the same
balance. A graduation needs about 25,000 USDC, which the burner does not have, so Run B covers the curve only, with 1 USDC
trades. It deploys the whole suite on Arc's USDC with launch fee 0, and runs one token (1% creator fee, closed pool, the
burner as its creator-fee destination so the fees come back):

1. `deploy`: the same checks as Run A, against the Arc-USDC deployment.
2. `approve`: the launchpad, for exactly what the trades need (6 USDC; 4.2 with `RUNB_WINDOW_USDC=0.1`, as live).
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
The live run used it: the buy landed 2 blocks after the launch and left 0.081 USDC.

On the fork Run B deployed (12,114,246 gas), passed its 34 deployment checks, approved (55,438 gas; Arc's USDC keeps
allowances in its own storage) and launched (1,626,278 gas), then stopped exactly where it must: the window buy's
`transferFrom` reverts with no revert data, because the native-balance precompile behind Arc's USDC does not exist on a
fork (`balanceOf` and `approve` answer; `transfer`, `transferFrom` and `totalSupply` revert). Live, Run B ran to the end
(below).

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

The live run below was driven with these scripts and `SIGNER=key` from `3bc28ab`, Run B with `RUNB_WINDOW_USDC=0.1`.

**Budget.** The burner held 4.47 USDC of gas before the live run (3.10 after).

| Part | Gas | USDC |
| --- | ---: | ---: |
| Run A deploy (measured on the fork) | 12,134,866 | 0.30 |
| Run A drive (measured on the fork) | 25,298,323 | 0.63 |
| Run B deploy (measured on the fork) | 12,114,246 | 0.30 |
| Run B drive (launch measured on the fork, the rest estimated from v1.3's Arc-USDC trades) | about 2.3M | 0.06 |
| Run B's surcharge, left in the launchpad for good | | 0.54 to 0.86 |
| **Total** | **about 52M** | **about 1.8 to 2.2** |

A buy inside the pool's window also places its bid. On the fork a router buy after the window cost 156,817 to 160,709
gas; inside it, the same token's buy cost 77,241 to 79,718 more when its bid landed on ticks an earlier bid had opened,
and 125,678 to 128,208 more when it opened new ones (the crash buys, which also move the pool's reference), in line
with V14-SPEC §5's +78k and +121k to +124k. The first buy after graduation costs 253,595 to 290,683 because it also
writes the pool's first fee balances. Run A has 18 window buys, and its measured drive includes them. The reference
adds 46,892 gas to the hook's deploy; the drive costs 0.02 USDC more than at `82d410d` because the scenario tokens now
make two more window buys each. The window transactions' gas limits (estimate + 30% or + 200,000) are about 360,000 to
500,000; only the gas used is paid, but the limit times the fee cap is held against the balance while a transaction is
pending, about 0.02 USDC each. rUSDC is minted freely and is not part of this. The driver refuses any transaction past
`GAS_CAP` (2 USDC of gas for Run A's progress file, 1 for Run B's). The live run spent 1.377815 USDC, inside the
budget ("Against the budget", below).

**Order matters.** Deploy Run A first, as the burner's next transaction, so it lands at nonce 272 and reproduces the fork
run's addresses and orientations (check `--preview` first). Run B's deploy then comes 97 nonces later; Run B opens no
pool, so its orientation does not matter. Live, Run A deployed at nonces 272 to 278 and Run B at 369 to 375.

**Resuming.** Progress (token addresses, the pools' positions, mined transactions, finished steps) lives in
`deployments/<name>.progress.json`, which is gitignored:

- A re-run skips finished steps and never sends a transaction twice.
- A step whose checks fail stops the run; the next run checks it again at the mined transactions' blocks without
  re-sending them (Arc's RPC serves historical state).
- A transaction left in flight by a crash is looked up by its hash (saved before it is broadcast) and recorded; so is
  every transaction of a window batch that was in flight. The rest of an interrupted batch is planned again from the
  state the mined ones left and sent (inside the window if the restart is quick, else checked as landing after it).

At the end the driver writes the tokens, pool ids and totals into the deployment record, next to the addresses.

Settings: `DEPLOYMENT`, `PROGRESS`, `RPC_URL` (or `ARC_TESTNET_RPC`), `SIGNER` (`key`, `anvil` or `none`),
`REHEARSAL_KEY`, `ACTOR` (anvil only), `ARTIFACTS` (default `contracts-v14/out`), `GAS_CAP`, `FLOOR`, `RUNB_WINDOW_USDC`,
`SAMPLE_SECONDS` (default 20), `MARKDOWN=1`.

## The live run (2026-09-26)

Both runs went out from the dev burner `0x7212fA4Fe663d063A7a83dA0467d592ed3A51D46` on 2026-09-26: Run A deployed at
06:03 UTC and finished at 06:07:37, Run B deployed at 06:08:28 and finished at 06:09:02. Every deployed contract equals
the local build byte for byte (`scripts/verify-bytecode.ts`, immutables and metadata hashes masked), and each hook
address has the low 14 bits `0x28EC`.

### Addresses

**Run A, on rUSDC: `deployments/arc-testnet-v14-rehearsal.json`.**

- Launch fee 1 rUSDC. `feeTo`, `feeToSetter` and the rUSDC owner are the dev burner.
- Uniswap's own v4 contracts: the PoolManager `0x8366a39CC670B4001A1121B8F6A443A643e40951` (its code is the tests'
  fixture, byte for byte, and it has no protocol-fee controller) and StateView
  `0xF3334192D15450CdD385c8B70e03f9A6bD9E673b`.
- The fee recipients are the plan's (above).

| Contract | Address |
| --- | --- |
| rUSDC (TestToken "Architex Rehearsal USD", 6 decimals) | `0x309297011592BA9a157204e57EB0AF2175D8ceed` |
| ArchitexLaunchpadV14 | `0x5a0eFD7b3ac83686E5a08d8004f181443A13CC58` |
| ArchitexLaunchHook (CREATE2 through `0x4e59b44847b379578588920cA78FbF26c0B4956C`, salt `0x…0266`) | `0x8c420B3EC4d92d50Ff2928476d26A26e63e768ec` |
| ArchitexV4Router | `0xf87C6Da66dCb64991208E1189Ea0e8e74bb90664` |
| SplitPlugin | `0xfd8e55DD52992Dc6B9ea7Af52fab70Ee28F5CD1f` |
| HolderDistributionPlugin | `0x17B608b4B55045c5380437E0E28752BC31194e2D` |
| ComboPlugin | `0x3CeA455cE9320Ac479cA59284D02ca91c78D1b5d` |
| RawSwapper (test only, `contracts-v14/test/V14Base.sol`) | `0x69cf92c006C5bC512646BD6984e47d1Da024FB09` |

| Token | Creator fee → destination | Pool | Token address | Pool id |
| --- | --- | --- | --- | --- |
| RWAL | 1% → a plain wallet | closed; USDC is currency0 | `0xD7aD75F24f84e3E263b3580a461AE70d93B8E958` | `0x27f2e8b1db71ff6b99d8e0db366cfbbaec009bdcfdbab0c5cdaf921a62231ccd` |
| RSPL | 10% → Split, payees 5/3/2 | open; USDC is currency0 | `0x9A96EfCfd6b6184f5b448e9151c83639cec9cd33` | `0xea152fb5ef6979804de3a0d4089e60e82f5b131890cc22de028c64247c794412` |
| RHLD | 10% → Distribute to holders | closed; USDC is currency1 | `0x2fB747e32255B07e7BDFF9b1b43ddc44f90fE1DD` | `0xdd1ccfe203b4cdb1e2cc91c66cac7d6c72a74874f0d136403641d8e3445e1f21` |
| RCMB | 1% → Combo: 50% holders, 30% Split (payees 1:1), 20% a wallet | open; USDC is currency0 | `0x357227Fd75205822B93B35F3Fb518da7792f0a78` | `0x9d111ef2a5f42e6e1234db4c506bfb85fd48e3c8fdf362c5571eb6c2dbdaf8c2` |
| RZRO | 0% → a plain wallet | closed; USDC is currency0 | `0x471779Bf350BC71fe18a81F6E4375342eC84284e` | `0xb306fc6f5857b67d44574e8e5e5095931fa8b9072b9aa507a4994b445a0d33ac` |

**Run B, on Arc's USDC: `deployments/arc-testnet-v14-realusdc.json`.** Launch fee 0. `feeTo` and `feeToSetter` are the
burner, which is also RARC's creator-fee destination.

| Contract | Address |
| --- | --- |
| Arc's USDC | `0x3600000000000000000000000000000000000000` |
| ArchitexLaunchpadV14 | `0x5abc3eA7416fAaE83d5B6d4046E3F67718EA4592` |
| ArchitexLaunchHook (salt `0x…27a3`; no pool opened) | `0xa17E63F995831e60769743c7195e82835Ff8e8Ec` |
| ArchitexV4Router | `0x433E576B36890F1D516C8C678BE932778f7b4c13` |
| SplitPlugin | `0x67e087811E5953Ea447eD5c7ac83c3C7BDE3D7fe` |
| HolderDistributionPlugin | `0x3C87c4AcDb4fB00F0C1E3567aFa6B9Eb940b316B` |
| ComboPlugin | `0x9668A944A320326BB72f7DBEd93E1a4AC67C416A` |
| RARC (1% → the burner, closed pool), on the curve | `0x516d7d4cA63F359CceB94c172496a63E2817b314` |

The deploy transactions are the `deploy` rows under "Every transaction" below; Foundry's broadcasts are in
`broadcast/DeployLaunchpadV14.s.sol/5042002/`.

### Results, by step

Run A, rUSDC:

| step | transactions | checks | gas | USDC at 25 gwei | result |
| --- | ---: | ---: | ---: | ---: | --- |
| deploy | 7 | 36 | 12,134,854 | 0.303371 | deployed |
| raw | 1 | 13 | 780,827 | 0.019521 | pass |
| fund | 2 | 26 | 106,308 | 0.002658 | pass |
| approve | 2 | 24 | 92,532 | 0.002313 | pass |
| plan | 0 | 1 | 0 | 0 | pass |
| create:wallet | 2 | 62 | 1,888,711 | 0.047218 | pass |
| create:split | 2 | 42 | 2,054,995 | 0.051375 | pass |
| create:holders | 2 | 42 | 1,868,186 | 0.046705 | pass |
| create:combo | 2 | 42 | 2,207,526 | 0.055188 | pass |
| create:zero | 4 | 72 | 1,984,668 | 0.049617 | pass |
| curve:wallet | 2 | 36 | 195,475 | 0.004887 | pass |
| curve:split | 2 | 33 | 195,475 | 0.004887 | pass |
| curve:holders | 2 | 33 | 195,475 | 0.004887 | pass |
| curve:combo | 2 | 33 | 195,475 | 0.004887 | pass |
| curve:zero | 2 | 33 | 185,181 | 0.004630 | pass |
| graduate:wallet | 9 | 172 | 2,545,761 | 0.063644 | pass |
| graduate:split | 4 | 78 | 1,314,598 | 0.032865 | pass |
| graduate:holders | 9 | 168 | 2,507,933 | 0.062698 | pass |
| graduate:combo | 4 | 92 | 1,313,702 | 0.032843 | pass |
| graduate:zero | 4 | 78 | 1,283,655 | 0.032091 | pass |
| fund:raw | 3 | 36 | 136,359 | 0.003409 | pass |
| pool:wallet | 2 | 40 | 318,943 | 0.007974 | pass |
| pool:split | 2 | 40 | 318,283 | 0.007957 | pass |
| pool:holders | 2 | 40 | 318,646 | 0.007966 | pass |
| pool:combo | 2 | 40 | 319,135 | 0.007978 | pass |
| pool:zero | 2 | 40 | 313,371 | 0.007834 | pass |
| raw:wallet | 2 | 42 | 297,878 | 0.007447 | pass |
| raw:holders | 2 | 42 | 296,475 | 0.007412 | pass |
| lp | 3 | 51 | 492,468 | 0.012312 | pass |
| sync:wallet | 1 | 17 | 81,048 | 0.002026 | pass |
| syncBatch | 1 | 16 | 114,698 | 0.002867 | pass |
| collect:wallet | 1 | 15 | 71,825 | 0.001796 | pass |
| collect:split | 1 | 16 | 114,214 | 0.002855 | pass |
| release:split:1 | 1 | 14 | 110,678 | 0.002767 | pass |
| release:split:2 | 1 | 14 | 93,578 | 0.002339 | pass |
| release:split:3 | 1 | 14 | 93,578 | 0.002339 | pass |
| collect:holders | 1 | 20 | 236,664 | 0.005917 | pass |
| collect:combo | 1 | 22 | 381,976 | 0.009549 | pass |
| collect:zero | 1 | 14 | 39,039 | 0.000976 | pass |
| sample | 0 | 12 | 0 | 0 | pass |
| claim:holders | 1 | 20 | 96,480 | 0.002412 | pass |
| claim:combo | 1 | 19 | 96,480 | 0.002412 | pass |
| collectFees | 1 | 14 | 41,148 | 0.001029 | pass |
| final | 0 | 48 | 0 | 0 | pass |
| **total** | **97** | **1,762** | **37,434,301** | **0.935858** | **all pass** |

Run B, Arc's USDC:

| step | transactions | checks | gas | USDC at 25 gwei | result |
| --- | ---: | ---: | ---: | ---: | --- |
| deploy | 7 | 34 | 12,114,234 | 0.302856 | deployed |
| approve | 1 | 12 | 55,438 | 0.001386 | pass |
| plan | 0 | 1 | 0 | 0 | pass |
| create:wallet | 2 | 57 | 1,832,737 | 0.045818 | pass |
| curve:wallet | 2 | 36 | 223,974 | 0.005599 | pass |
| sellAll:wallet | 1 | 13 | 98,835 | 0.002471 | pass |
| collect:wallet | 1 | 15 | 56,923 | 0.001423 | pass |
| collectFees | 1 | 14 | 56,110 | 0.001403 | pass |
| final | 0 | 9 | 0 | 0 | pass |
| **total** | **15** | **191** | **14,438,251** | **0.360956** | **all pass** |

### The pool windows

Every window went out in back-to-back batches the moment its graduation was mined, and every case landed inside the
20 blocks, at most 5 blocks after graduation. The blocks each transaction landed in, with the surcharge a buy paid in
that block (sells pay none):

| Token | Graduation block | First batch | Second batch |
| --- | ---: | --- | --- |
| RWAL | 64,054,629 | lifting buy, capped buy, dump: 64,054,631 (+2, 8,100 bps); crash buy: 64,054,632 (+3, 7,650 bps) | lift back, buy after it, sell, exact-out buy: 64,054,634 (+5, 6,750 bps) |
| RSPL | 64,054,699 | lifting buy, capped buy, sell: 64,054,702 (+3, 7,650 bps) | |
| RHLD | 64,054,707 | lifting buy, capped buy: 64,054,709 (+2, 8,100 bps); dump, crash buy: 64,054,710 (+3, 7,650 bps) | all four: 64,054,712 (+5, 6,750 bps) |
| RCMB | 64,054,721 | lifting buy: 64,054,722 (+1, 8,550 bps); capped buy, sell: 64,054,723 (+2, 8,100 bps) | |
| RZRO | 64,054,729 | lifting buy, capped buy, sell: 64,054,731 (+2, 8,100 bps) | |

By the blocks' timestamps, each window's transactions were all mined 1 to 3 seconds after its graduation: RWAL's
graduation block is stamped 06:04:29 UTC and its second batch's block 06:04:32; RHLD's 06:05:09 and 06:05:11.

The crash and the lift back, in both orientations:

| | RWAL (USDC is currency0) | RHLD (USDC is currency1) |
| --- | --- | --- |
| graduation tick, the first reference | 366,200 | -366,201 |
| after the lifting buy | 364,847 | -365,532 |
| after the 150M-token dump | 375,315 | -375,613 |
| crash buy: the new reference and its bid | 375,315: [382,400, 474,600], 1,530 rUSDC | -375,613: [-474,800, -382,600], 1,530 rUSDC |
| lift back: its size, and the tick before and after it | 38,786 rUSDC: 374,971 to 364,476, 1,724 ticks above graduation | 61,929 rUSDC: -375,407 to -363,727, 2,474 ticks above graduation |
| the lift back's bid | the crash bid's range, 26,180.55 rUSDC | the crash bid's range, 41,802.075 rUSDC |
| the buy after the lift, from above graduation: its bid | the crash bid's range, 1,350 rUSDC | the crash bid's range, 1,350 rUSDC |
| where a cap at the graduation price alone would have put that bid | [373,200, 465,400] | [-465,400, -373,200] |
| where its own pre-buy price would have put it | [371,600, 463,800] | [-463,000, -370,800] |
| the exact-out buy in the window: its bid | the crash bid's range, 1,720.279112 rUSDC | the crash bid's range, 2,577.513588 rUSDC |
| `bidRefTick` at the end | 375,315 | -375,613 |

### What the live run showed

- **Both windows.** The curve's window buys landed 2 or 3 blocks after their launches (RWAL and RSPL 3, at 7,650 bps;
  RHLD, RCMB and RZRO 2, at 8,100; RZRO's second and third 4 and 7 blocks after, at 7,200 and 5,850), and
  `pendingSnipe` moved by exactly each surcharge. At graduation the curves' surcharges became the graduation bids:
  765 rUSDC (RWAL, RSPL), 810 (RHLD, RCMB) and 2,115 (RZRO). In the pools' windows every buy paid the surcharge of the
  block it landed in, and the window sells paid none.
- **Graduation.** As on the fork: every pool opened with 24,999.999968 to 24,999.999971 rUSDC and 200M tokens at tick
  366,200 (-366,201 for RHLD, the one token with USDC as currency1); 7,427,141 to 83,139,851 wei of tokens were left
  over and burned; `bidRefTick` started at the graduation tick.
- **Above graduation, the reference held.** The lifting buys (10,000 rUSDC) lifted the tick by 1,353 (RWAL), 1,014
  (RSPL, RCMB), 669 (RHLD) and 1,428 (RZRO), and bid 8,100 rUSDC (7,650 on RSPL, 8,550 on RCMB) on the graduation
  bid's range. Every capped buy (2,000 rUSDC) then bid on that range again, at salt 3, in both orientations; half its
  own pre-buy price would have started its bid at 371,800 to 372,200 (-372,600 on RHLD) instead of 373,200
  (-373,200).
- **After the crash, the reference stayed down** (table above): the crash buy moved it to the crashed price, and a lift
  back above graduation, the buy after it and the exact-out buy all still bid from half of it.
- **Every bid** sat wholly under the market, none started above half the graduation price, and each of the 18 window
  bids took everything it was given (`lockHeld` stayed 0). At the end RWAL and RHLD hold eight hook positions (the
  full range and seven bids), the others four.
- **Window gas.** No window transaction used more than 60.2% of its limit. The most any used beyond the estimate it was
  sent with was 9,332 gas: RHLD's crash buy, estimated before the dump ahead of it had crashed the price.
- **Fees.** At collection the creator fees paid out 986.335208 rUSDC to RWAL's wallet, 4,407.154131 to Split for RSPL
  (then released to its three payees), 12,506.230637 to Holders for RHLD (9,522.947078 of it released from the hook in
  that same transaction), 405.41498 to Combo for RCMB and nothing for RZRO; `feeTo` received the platform's
  1,754.564217. At the end the launchpad holds 0 rUSDC, the hook's claims are 0, and the PoolManager holds 36 units
  more than the 275,448.092177 rUSDC its positions are worth (rounding in the pools' favour).
- **Dividends.** Over 21 s RHLD's stream grew by 2,907,273 units against the model's 2,907,272, and RCMB's by 49,269
  against 49,266; each claim paid exactly `claimable`, leaving 2 and 1 units of dust.
- **Run B.** The window buy (0.1 USDC) landed 2 blocks after the launch and paid 8,100 bps: 0.081 USDC to
  `pendingSnipe`, where it stays, since RARC never graduates. A 1 USDC buy after the window, a sell of half (0.48514
  USDC back) and a sell of the rest (0.50232 back) followed; the creator fees (0.021026) and the platform fees
  (0.010513) came back to the burner, and RARC's curve keeps 1 unit of float. The same calls cost more gas on Arc's
  USDC than on rUSDC: the window buy 206,459 (RWAL's: 121,823), a buy after the window 115,539 (99,291), a sell 108,435
  (96,184).

### Against the budget

| Part | Budget (USDC) | Spent (USDC) |
| --- | ---: | ---: |
| Run A deploy | 0.30 | 0.303371 |
| Run A drive | 0.63 | 0.632486 |
| Run B deploy | 0.30 | 0.302856 |
| Run B drive | 0.06 | 0.058100 |
| Run B's surcharge, left in the launchpad for good | 0.54 to 0.86 (0.054 to 0.086 with `RUNB_WINDOW_USDC=0.1`) | 0.081000 |
| Run B's curve float, left in the launchpad | | 0.000001 |
| **Total** | **about 1.8 to 2.2 (about 1.34 to 1.38 with 0.1)** | **1.377815** |

The burner went from 4.472875 to 3.095060 USDC. Run A's gas matched the fork's to within 1,112 in all (and 1,964 at
most for any one step), and Run B's drive (2,324,017 gas) its estimate of about 2.3M.

### What differed from the fork run

- **RPC retries.** 14 RPC calls (reads, estimates or receipt polls) hit transient errors on Arc Testnet's public RPC
  and were retried with backoff; the fork had none. No step failed and nothing was sent twice: 97 transactions for Run
  A's 97 actions, 15 for Run B's.
- **Later landings.** Arc mined transactions a block or two later than anvil did: the curve's window buys 2 or 3
  blocks after their launch (fork: 1; RZRO's three at 2, 4 and 7 against 1, 2 and 3), the pools' first batches 1 to 3
  blocks after graduation, split over two blocks on RWAL, RHLD and RCMB (fork: whole, 1 block after), and the second
  batches 5 blocks after (fork: 3). Every case still landed inside its window, and the surcharges were lower: 765 or
  810 rUSDC of curve surcharge per token (fork: 855), 2,115 on RZRO (2,430).
- **The crash and the lift back.** The buys before each dump paid less surcharge and so put more into the pool, and the
  crashes stopped a little higher: at 375,315 against the fork's 375,416, and -375,613 against -375,722. The crash
  bids' ranges are the same on RWAL and one spacing higher on RHLD ([-474,800, -382,600] against [-475,000,
  -382,800]). The lift back was sized for the next block's surcharge (7,200 bps) and landed a block later (6,750), so
  it passed its 400-tick target: 1,724 ticks above graduation on RWAL and 2,474 on RHLD (fork: 2,440 and 4,588).
- **More checks.** 1,762 against 1,721: where the window's transactions spread over more blocks, each block's books
  are checked on their own (13 or 14 more checks per extra block, on RWAL, RHLD and RCMB).
- **Gas and the hook's address.** 37,434,301 against 37,433,189 (+1,112). The hook's deploy used 12 gas less:
  `3bc28ab`'s comment changes altered its metadata hash, so its init code, its mined CREATE2 salt (`0x…0266`; the
  fork's was `0x…01ea`) and its address (`0x8c420B3E…e8Ec`; the fork's `0x5b2E249b…e8Ec`), and with it every pool id.
  Every other address is the fork's, since the burner deployed at the same nonce. The drive used 1,124 more, from the
  window trades' different surcharges and prices.
- **The price of gas.** Arc Testnet charged exactly 25 gwei on all 112 transactions, the figure every cost here uses.

### Every transaction

Run A, rUSDC:

| step | transaction | tx hash | gas | USDC at 25 gwei |
| --- | --- | --- | ---: | ---: |
| deploy | launchpad | `0x913aeab481c7690272cf4cecc321d0e5ca43c0f7967c14b07ff4ff1d732d28d2` | 5,264,637 | 0.131616 |
| deploy | hook | `0xac69053c20c17c8888d65ed25a974f1ade6dffd351abc4013d5afd3a4dfcfe2f` | 2,878,852 | 0.071971 |
| deploy | router | `0x8c1baabe9221f2938bd51c8fb729fb0200e047facf6a32eacb455532aaeaedf0` | 932,275 | 0.023307 |
| deploy | initialize | `0x201154a6fa03da2d5c3ce86a4c0c7671ac44ecf5c3d58f3703304410f2e317fd` | 78,336 | 0.001958 |
| deploy | split | `0xb0e1abea08ba042ed227f64865a47bdffe06c51ed656f2e59c71e05f80c08abb` | 1,040,036 | 0.026001 |
| deploy | holders | `0x9fde1c3d25978f1e1d8ecaa62b9cbe74e94d100e747cedac7263a54b4d059237` | 574,991 | 0.014375 |
| deploy | combo | `0xdd18452e784ee10c22f17b12f104bdb9c1220df6b46011c65437b185af321b91` | 1,365,727 | 0.034143 |
| raw | deploy RawSwapper | `0xb57462199749ba1fe0c7fe0dd54fe460a3f5194de343c1d7da283ad6240dc6b2` | 780,827 | 0.019521 |
| fund | mint 1000000 rUSDC to the burner | `0x995f1770c8b365ce22d059c19d8098ec8f9cdf7686f8751fdb3dbd2227eccb66` | 53,154 | 0.001329 |
| fund | mint 50000 rUSDC to the raw | `0x883bb7105f032dc49c26ec6741979cccc5ac81fc9e960ec5e9a3fe995e39edb8` | 53,154 | 0.001329 |
| approve | approve the launchpad | `0x92b7cb2af07c91cdc9f9325fc50707989828f2bf3607d76fa36c2c49e3d3985b` | 46,266 | 0.001157 |
| approve | approve the router | `0x927b1bb486e223874f997094c6454c81b6712e1ad7847e775c693c9ae966c50b` | 46,266 | 0.001157 |
| create:wallet | createToken RWAL | `0xf20e1b39cc47b4c6eb66e7179d44dbfb84b0c6057241d4ad4c958c0873fa6ef1` | 1,766,888 | 0.044172 |
| create:wallet | buy RWAL in the curve's window (1) | `0xfdbc6c6653a5dd57eab93b85f7795c98191834a061d07d73757cee77ac704c2b` | 121,823 | 0.003046 |
| create:split | createToken RSPL | `0xfcbe47c6c95c9e3d9edde2de8d9e15e68f5ae9fadab9823117e910138ec0e482` | 1,881,872 | 0.047047 |
| create:split | buy RSPL in the curve's window (1) | `0x221eac0ea79049cfb3f19bb81d58a7aaa71ebf8cab75f2efe48508d3a8e6be7a` | 173,123 | 0.004328 |
| create:holders | createToken RHLD | `0x52a1b1bf799861edf130da918e914cc9bd22c4d7effbc7238c8214a77a1e92e2` | 1,746,363 | 0.043659 |
| create:holders | buy RHLD in the curve's window (1) | `0x42dfb876f94010a480f3df94169f84bf078130e3daed352755693538d9d0a156` | 121,823 | 0.003046 |
| create:combo | createToken RCMB | `0x5a3023eb181b66f1d3a4384bdaba39a1f5d984ebd4f396a6698c5c9fa308c938` | 2,034,403 | 0.050860 |
| create:combo | buy RCMB in the curve's window (1) | `0x4b6756ff418782926da90a9cba69f89c3387c1f7834652cef3c9fda604232383` | 173,123 | 0.004328 |
| create:zero | createToken RZRO | `0x2a151471bead0b9ab15262afcb5b2b8e424856ad1ce1a40498c20006767ac24c` | 1,634,652 | 0.040866 |
| create:zero | buy RZRO in the curve's window (1) | `0xaa47b5ea066b36b2073658c94d74a076305591e0e5495c625461281e86203981` | 150,872 | 0.003772 |
| create:zero | buy RZRO in the curve's window (2) | `0xa6fcf6f9a68749ab8b2a464a8beabb5bb41c83ab80710613f0b8333915c33726` | 99,572 | 0.002489 |
| create:zero | buy RZRO in the curve's window (3) | `0xde8df82292280cfa924a31807cb82e29bf0eef7f724704097b22fc90fab5b4c6` | 99,572 | 0.002489 |
| curve:wallet | buy RWAL on the curve, after its window | `0x8f87340dd910815ab300b083d8b8a17e940399b2e39a168a07cbb138204d77ee` | 99,291 | 0.002482 |
| curve:wallet | sell RWAL on the curve (half) | `0x0d8caa7e59f380ca82d30160c4d592c85e7bde01446969b0a1bbc63cf11dc58c` | 96,184 | 0.002405 |
| curve:split | buy RSPL on the curve, after its window | `0x618af20799477e265b078813908f595ee943482d07522b1d278c14f5925ec6b4` | 99,291 | 0.002482 |
| curve:split | sell RSPL on the curve (half) | `0x07d5ea672d779c370eb1216c0d9e8ed83937d24c3f01b9c1995a50170134fe11` | 96,184 | 0.002405 |
| curve:holders | buy RHLD on the curve, after its window | `0x6b16745a82ff41d5e2754d3a4f1313f77220d3a013b2714d36169f8adc56efca` | 99,291 | 0.002482 |
| curve:holders | sell RHLD on the curve (half) | `0x86f77e25f18854c6082e5c535754827a8dc1e231ba8ae7484dc23aaf1535344a` | 96,184 | 0.002405 |
| curve:combo | buy RCMB on the curve, after its window | `0xf1ad32ed9197bca1667cecd7f68942270737a7f144d4be6ff40555e20bce4c35` | 99,291 | 0.002482 |
| curve:combo | sell RCMB on the curve (half) | `0x66b4026211e07957b2d0b6212624ff480de55acb025c65eb0e3a4fb7217bd2f6` | 96,184 | 0.002405 |
| curve:zero | buy RZRO on the curve, after its window | `0x0b85db060663d53b626bb931a7d5ae25237dbd5596caeafdc48431f31bc423de` | 94,140 | 0.002354 |
| curve:zero | sell RZRO on the curve (half) | `0x59740539b3d1ceedc6a4a4bec230f339ec1c17133f4be0453ebdb40e5ee3265a` | 91,041 | 0.002276 |
| graduate:wallet | buy RWAL out (graduation) | `0x98b74546cd2209cded88383b2c5e03c40d6a7e36fb6ef181742f82a1058c97a9` | 660,302 | 0.016508 |
| graduate:wallet | buy RWAL in the pool's window (router) | `0xffb93b2347014d1921ffe7590c1d80a2232552daa1f7e783baafc644b38ace54` | 289,827 | 0.007246 |
| graduate:wallet | buy RWAL again in the pool's window, above the graduation price (router) | `0x7725e36e9cd7dd24bcfea23d447eafb75f35e2b7a18da45a69454b1bf5a7e97f` | 239,359 | 0.005984 |
| graduate:wallet | dump 150000000 RWAL under half the graduation price (router) | `0xa48c34c2b9f60b9b484f7a8f665ffa0cba9b9a8d078b6eed871fb82b6190a0b1` | 174,275 | 0.004357 |
| graduate:wallet | buy RWAL in the pool's window after the crash (router) | `0x65781c490d67d0efff2d06541403ffada75f4bebb1025912a3c4f69025c734e9` | 286,423 | 0.007161 |
| graduate:wallet | buy RWAL back above the graduation price in the window (router) | `0xbe3d02d250fc1ea5357c276ca69091d8e7e2477aba8535bf58de2225d35ba611` | 255,644 | 0.006391 |
| graduate:wallet | buy RWAL in the window after that lift (router) | `0x6db6d17920c4709565f5488d2eb5d2bfb1576836235ef9dba972a05316fe7b2e` | 239,595 | 0.005990 |
| graduate:wallet | sell RWAL in the pool's window (router) | `0xa0b6412090f8469f300d257272d56cff4f21d0c94ba6a3a08103da7701ed2064` | 158,418 | 0.003960 |
| graduate:wallet | exact-out buy of 5000000 RWAL in the window (RawSwapper) | `0xcc7e1e67a71da546f8b9c4e9254ad6af7787de11d0cc2450aae0cea47d57152f` | 241,918 | 0.006048 |
| graduate:split | buy RSPL out (graduation) | `0xbf3fda88d48493028983f69d01f6f2e491afb6df3fead247f0131ff08fad63e2` | 643,190 | 0.016080 |
| graduate:split | buy RSPL in the pool's window (router) | `0xf666e00e03184beb1c0cace992a6187f929a74089f8a3aa27ebd021ede0dc651` | 273,571 | 0.006839 |
| graduate:split | buy RSPL again in the pool's window, above the graduation price (router) | `0xad7bed38afb0cfa6a4ee5b456eee6dfe3a3e53bcdeb3f7b718bd32a164c5c4f7` | 239,487 | 0.005987 |
| graduate:split | sell RSPL in the pool's window (router) | `0xccbfd9f97accea3ff6690435e3083e3ffed5d2df1f64b432d32a6b808999b792` | 158,350 | 0.003959 |
| graduate:holders | buy RHLD out (graduation) | `0x63d40ab5191305f1a4595f9d5fcef9102a08732acdb619dcd58bd7e65907f8b4` | 643,537 | 0.016088 |
| graduate:holders | buy RHLD in the pool's window (router) | `0x31b3de6c057f79fb8a3c202b9eb56d8053c99495e9b56f9ab4c91072f9ed5c7e` | 272,535 | 0.006813 |
| graduate:holders | buy RHLD again in the pool's window, above the graduation price (router) | `0xba94daff273d8a5f258093e4cb22a597833b0166f8b9bb4ed14022ec0b056c6f` | 238,259 | 0.005956 |
| graduate:holders | dump 150000000 RHLD under half the graduation price (router) | `0x0d00656ae5d11c8b1522d683f7c73ebe2389efe630b5f36b86fbb3610a832807` | 173,799 | 0.004345 |
| graduate:holders | buy RHLD in the pool's window after the crash (router) | `0xbc23bb01a97b96ce1b86a8030beda3261ae7c238be746152db0ab46c48ca6830` | 288,330 | 0.007208 |
| graduate:holders | buy RHLD back above the graduation price in the window (router) | `0xa304b7278348f1b1032a79eed2f37786afa5d306b7f034bc6444cf31b8b9d4d8` | 254,024 | 0.006351 |
| graduate:holders | buy RHLD in the window after that lift (router) | `0x05aed72194cf2ca23f7338a52c7bcaca25a924d798274b7624e9270b185b84a0` | 238,307 | 0.005958 |
| graduate:holders | sell RHLD in the pool's window (router) | `0xa6480a152cc72e68f36f74b685e824cc6b36138744041a299c2e72fdc70d46ad` | 157,464 | 0.003937 |
| graduate:holders | exact-out buy of 5000000 RHLD in the window (RawSwapper) | `0x964db6cba8c3d8bfd1dc26606dc0bddf4419cf150c45ef3494990bcf7f5998b7` | 241,678 | 0.006042 |
| graduate:combo | buy RCMB out (graduation) | `0x045bf24438fb584852dd5118be50e3f3dabc5820548d4dce173c0189e850e054` | 643,202 | 0.016080 |
| graduate:combo | buy RCMB in the pool's window (router) | `0x4dd2ad46dcb14acd45c2fdaf0b7431bc44f2133122e4daa8df2519033b67b0c6` | 273,583 | 0.006840 |
| graduate:combo | buy RCMB again in the pool's window, above the graduation price (router) | `0xc6d032af17d5ae25fc7316662e21ca2f8b04ccf5bd34dc0b3d103c981cbb960c` | 239,451 | 0.005986 |
| graduate:combo | sell RCMB in the pool's window (router) | `0x433e346027d969fb83d55ecbd1be821393d63aaaef9da18bab6c33a8e423ab21` | 157,466 | 0.003937 |
| graduate:zero | buy RZRO out (graduation) | `0x60967bb2fb73f17e75e5836f6fa7bbd6cfe5592450090a44e0442272cf3e4201` | 638,051 | 0.015951 |
| graduate:zero | buy RZRO in the pool's window (router) | `0xf3e4cdc7ed58e6117f8b431431764678c99e1bdb69fe54479aa0399395095456` | 253,563 | 0.006339 |
| graduate:zero | buy RZRO again in the pool's window, above the graduation price (router) | `0x6e9be64ac05c754f512805c7c78631999b127f05f8a3b65dab7ba32b1933fa4d` | 236,535 | 0.005913 |
| graduate:zero | sell RZRO in the pool's window (router) | `0xcdaecd734f7d30f51d32fefec0ce8cf31867b91db9f1916c763d2d06909d53a4` | 155,506 | 0.003888 |
| fund:raw | transfer 30000000 RWAL to the RawSwapper | `0xc74971b8e8d5887b6217f087e9f731df3b7cadac580491ebd4be99fea8856bb1` | 39,753 | 0.000994 |
| fund:raw | transfer 30000000 RHLD to the RawSwapper | `0x6e9e2808596f9af21b1bfcd20bb419cfd5aed990d0caf637ab0ba1c53ad2f0a1` | 39,753 | 0.000994 |
| fund:raw | transfer 30000000 RSPL to the RawSwapper | `0xd9d73525d9aaf612d09bab4fa72f43692b1f112cf0807394451cba58e2074f73` | 56,853 | 0.001421 |
| pool:wallet | buy RWAL (router) | `0x74f089f050bca4c7b839d8d5877c26f183bf7ac9901c99496c5b8956ddfd2c57` | 160,621 | 0.004016 |
| pool:wallet | sell RWAL (router) | `0x2fa0cdcb1838e376f971d878f179636d3e70da0a50278e32b74f950f8f37459c` | 158,322 | 0.003958 |
| pool:split | buy RSPL (router) | `0x25e372ae0badebd2ffd6bdd35050b99f26c61d9869ec5d4d0429efded6aa26c4` | 159,769 | 0.003994 |
| pool:split | sell RSPL (router) | `0x20a84d34800dfa34d9f293e111452d8fdecc9a0308c4812e3942f5ae798e36f9` | 158,514 | 0.003963 |
| pool:holders | buy RHLD (router) | `0x90f109c9579a5ba13ef4729566c4f623e9fcd6a0871d4903b48036a140eaca93` | 160,218 | 0.004005 |
| pool:holders | sell RHLD (router) | `0x5b01d5ac6e2444081f78ef20cad9a7502c0a3e1ae9465f84b4164f5b2190afe5` | 158,428 | 0.003961 |
| pool:combo | buy RCMB (router) | `0x91bc9a912b35f4bc2c2b2fc9ca44ebac2cc5fd9b6dfc2718680c3f1ee8246c35` | 160,689 | 0.004017 |
| pool:combo | sell RCMB (router) | `0xa278f832de2d586ae6ab67d3b4791ba9bda2989339367a06857d9ed70e597848` | 158,446 | 0.003961 |
| pool:zero | buy RZRO (router) | `0x3e092416a0ed65a30eca786b487434f79b05f259691322ef64ca3f2c9b4fa715` | 157,765 | 0.003944 |
| pool:zero | sell RZRO (router) | `0xfead8b6d7daffd1f898883f5e9bce3decd14b1822911538e59f67286ec7392bb` | 155,606 | 0.003890 |
| raw:wallet | exact-out buy of 2000000 RWAL (RawSwapper) | `0x53c396305186c2df1d63abf8d1a14263ce631c0f62360bdf2ed19665bba9d38b` | 146,347 | 0.003659 |
| raw:wallet | exact-out sell for 100 rUSDC of RWAL (RawSwapper) | `0x02be84df517ec38560115968a3c44d7c4be5db7e06cd818a4fa0c447d3eb411c` | 151,531 | 0.003788 |
| raw:holders | exact-out buy of 2000000 RHLD (RawSwapper) | `0xd7cc22ec365127adc1cb09f52c360494734e8ff3716a44711ce5a55316113b93` | 146,896 | 0.003672 |
| raw:holders | exact-out sell for 100 rUSDC of RHLD (RawSwapper) | `0x06b035532a5c2ace5acef13c5d975f02ae60536a511524400fccc7bcad619feb` | 149,579 | 0.003739 |
| lp | add outside liquidity to the open RSPL pool (RawSwapper) | `0x28fd8bc4016f6d054fc1368342485f740a9ec48ca31a4410643b26cb33c068d0` | 203,175 | 0.005079 |
| lp | buy RSPL through the outside liquidity (router) | `0x2700e8ff4c8267fe5470e9d9526f45ae0dedab8857fb77fb2eb1cb294d18e9a4` | 160,744 | 0.004019 |
| lp | remove half the outside liquidity (RawSwapper) | `0x5eeaa518fd2a8cd2badc684caeebd3548a8bf10727c4eead806a5bef4d0efea9` | 128,549 | 0.003214 |
| sync:wallet | syncPoolFees RWAL | `0x4420a3f04596d569cf917be6451ddfd1bb5c6704de2005f46756963a3b9e51a2` | 81,048 | 0.002026 |
| syncBatch | syncPoolFeesBatch RSPL, RZRO, RWAL | `0xc18a60ed605b9c26d3a18b823765ce123b5e046579f74ef2ce809bcfe2dc3c1c` | 114,698 | 0.002867 |
| collect:wallet | collectCreatorFees RWAL | `0x67aa341a3549de9ffe002e2c2922f4bc48f0b436fbfb492ff8a52c78e4d7f09b` | 71,825 | 0.001796 |
| collect:split | collectCreatorFees RSPL | `0xd497d1d0cf2e08162a0a9661f616be30428ef140826829f3394bb4954b6e7932` | 114,214 | 0.002855 |
| release:split:1 | Split release to payee 1 | `0xbfbd4fd0234a3e5ada3a9bc685a14d108f40e6408ae518bd9dbb5895301c89be` | 110,678 | 0.002767 |
| release:split:2 | Split release to payee 2 | `0xf10b2aac37dfc5c8d311cb970a4ccf8a09537111e2f54a454c58ac6aa563179a` | 93,578 | 0.002339 |
| release:split:3 | Split release to payee 3 | `0x7384740cf73fb82d30cc16e44a818194aeca399b8711683d820c7b06f03558e8` | 93,578 | 0.002339 |
| collect:holders | collectCreatorFees RHLD | `0xf97a9a9b974006c82ebf6379d252a0609b797cbc4e61d78eaeb5638df6809a5e` | 236,664 | 0.005917 |
| collect:combo | collectCreatorFees RCMB | `0x34ee403adccf13a207acf28dcd3e924ea49d4f077c0383e535d3d8e9ce2d875c` | 381,976 | 0.009549 |
| collect:zero | collectCreatorFees RZRO | `0x92d992adde723f9287821502446a0bf509ed630055c97a4dd964d59e9050c583` | 39,039 | 0.000976 |
| claim:holders | claim RHLD dividends | `0xc19a06f788975be8c74a1f695350e30991c3a0a036c162489cf059a1a5e25ba3` | 96,480 | 0.002412 |
| claim:combo | claim RCMB dividends | `0xf773ab08fbce86eb8d75d9e11f5728439b9448794f0ce0a8e29e700b6b46b838` | 96,480 | 0.002412 |
| collectFees | collectFees | `0xce40ba14927c59d6d4b8ae30544d8e1b599c356c545982c1110f013417be6efe` | 41,148 | 0.001029 |

Run B, Arc's USDC:

| step | transaction | tx hash | gas | USDC at 25 gwei |
| --- | --- | --- | ---: | ---: |
| deploy | launchpad | `0xffb23f546807a097b336e1a024c599afa342f1a49570ddd9d3d6d40ae431c849` | 5,244,473 | 0.131112 |
| deploy | hook | `0xb45645c8013b14019a6a947dd7e44c52b791ce37871773c895d1ea9355915497` | 2,878,624 | 0.071966 |
| deploy | router | `0x7e7cda7e65aa084dc8326bb168e0ee78d9717f28502469a777df782197f51170` | 932,047 | 0.023301 |
| deploy | initialize | `0x01e261754bf42e3d86adfc08eff84599b32fdbe81cdca1ada21713e401c82008` | 78,336 | 0.001958 |
| deploy | split | `0x63f3aba0de799d4d71972bdfe1e2184f58f0ed182dac01e5008616f08b8a8af6` | 1,040,036 | 0.026001 |
| deploy | holders | `0x6361f470f391a27816b31c6ff932f2a3c087b6eb6fec211230a89e7de287ab49` | 574,991 | 0.014375 |
| deploy | combo | `0x1c48f5898241768d610452e7257ef654d9bb0b6129ba8a6826f0d903052bb2cf` | 1,365,727 | 0.034143 |
| approve | approve the launchpad | `0x685a9ffdcf7e4907da34991430cf7e59b42270eee0942a68e16e4c6b4cb46f9d` | 55,438 | 0.001386 |
| create:wallet | createToken RARC | `0x29066d054f914ad50f7eb2a4245fd35127efa9f3e950f6a8857e9466033027e7` | 1,626,278 | 0.040657 |
| create:wallet | buy RARC in the curve's window (1) | `0xe0e55a70759b4f7266cd1096ba46c1d7954ab45dda5e53b4a4e819c9d88cf522` | 206,459 | 0.005161 |
| curve:wallet | buy RARC on the curve, after its window | `0x324582805f1a51ed4c3bdb43f2ff6c0c9738e3d7a442a0069576c21ac03542d1` | 115,539 | 0.002888 |
| curve:wallet | sell RARC on the curve (half) | `0x42ede84f9b9b7f288c97f9495b2176e4c66ae4ff34cc4c2b4c021f44fac5862c` | 108,435 | 0.002711 |
| sellAll:wallet | sell all RARC back to the curve | `0xf1f326fe3148ad8ea9721d76f9a1251c589ed0d16a60224c0781a4e93566fb2b` | 98,835 | 0.002471 |
| collect:wallet | collectCreatorFees RARC | `0x4a966c020fb8f146cbad0ce7dabe24b5d96ebfef14de31050340079e74b54f6d` | 56,923 | 0.001423 |
| collectFees | collectFees | `0x977ba47f8e865d62d032fdf3cf9dddec3e075c115ec0a0c7865dbed884c839f9` | 56,110 | 0.001403 |

## The fork dry run (the pre-flight)

Before the live run, the same scripts were proven on a local anvil fork of Arc Testnet. This section is that
pre-flight's record.

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

Four more runs:

- Run B (`RUN=b`) at `f9649d4`: it deployed (12,114,246 gas), passed its 34 deployment checks, approved (55,438 gas)
  and launched (1,626,278 gas), then stopped at its first USDC transfer, as above.
- With `ACTOR=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` (anvil's first default account) at `f9649d4`, the default
  account deploys and drives, and the burner is impersonated only to mint rUSDC and receives the platform fees as
  `feeTo`. It passed (1,704 checks) at other addresses, where the planner picked RSPL (USDC as currency0) and RWAL
  (currency1) for the scenarios, so the outside liquidity went into an open pool that had crashed and been lifted back.
- The driver was killed with SIGKILL while RWAL's first window batch was in flight (all four transactions sent, no
  receipt yet), then restarted at once. It recorded the four from their saved hashes, re-sent nothing, planned the
  second batch from the state they left and sent it: it still landed inside the window, 8 blocks after graduation
  (5,400 bps). Every case passed, and the whole run passed all 1,721 checks (90 transactions, 90 distinct, no action
  twice). This run also found a fork-only fault, fixed in `f9649d4`: the driver used to top the burner's gas up with
  `anvil_setBalance` on every start, and anvil writes that into the latest block's state, so a restart while window
  transactions were pending moved the burner's balance inside the graduation block and failed its books.
- It was also killed while a pool trade after the window was in flight, on a fork deployed at a later nonce (where
  every token sorts on the same side, so the planner ran the scenarios on RWAL alone). It recorded the trade, re-sent
  nothing (82 transactions, 82 distinct) and passed (1,588 checks).

### Results, by step (fork)

The final run, at `f9649d4`, from a fork of Arc Testnet at block 64,052,806:

| step | transactions | checks | gas | USDC at 25 gwei | result |
| --- | ---: | ---: | ---: | ---: | --- |
| deploy | 7 | 36 | 12,134,866 | 0.303372 | deployed |
| raw | 1 | 13 | 780,827 | 0.019521 | pass |
| fund | 2 | 26 | 106,308 | 0.002658 | pass |
| approve | 2 | 24 | 92,532 | 0.002313 | pass |
| plan | 0 | 1 | 0 | 0 | pass |
| create:wallet | 2 | 62 | 1,888,711 | 0.047218 | pass |
| create:split | 2 | 42 | 2,054,995 | 0.051375 | pass |
| create:holders | 2 | 42 | 1,868,186 | 0.046705 | pass |
| create:combo | 2 | 42 | 2,207,526 | 0.055188 | pass |
| create:zero | 4 | 72 | 1,984,668 | 0.049617 | pass |
| curve:wallet | 2 | 36 | 195,475 | 0.004887 | pass |
| curve:split | 2 | 33 | 195,475 | 0.004887 | pass |
| curve:holders | 2 | 33 | 195,475 | 0.004887 | pass |
| curve:combo | 2 | 33 | 195,475 | 0.004887 | pass |
| curve:zero | 2 | 33 | 185,181 | 0.004630 | pass |
| graduate:wallet | 9 | 159 | 2,545,745 | 0.063644 | pass |
| graduate:split | 4 | 78 | 1,314,734 | 0.032868 | pass |
| graduate:holders | 9 | 154 | 2,506,761 | 0.062669 | pass |
| graduate:combo | 4 | 78 | 1,314,622 | 0.032866 | pass |
| graduate:zero | 4 | 78 | 1,283,635 | 0.032091 | pass |
| fund:raw | 3 | 36 | 136,359 | 0.003409 | pass |
| pool:wallet | 2 | 40 | 319,095 | 0.007977 | pass |
| pool:split | 2 | 40 | 319,039 | 0.007976 | pass |
| pool:holders | 2 | 40 | 318,582 | 0.007965 | pass |
| pool:combo | 2 | 40 | 318,219 | 0.007955 | pass |
| pool:zero | 2 | 40 | 311,407 | 0.007785 | pass |
| raw:wallet | 2 | 42 | 297,850 | 0.007446 | pass |
| raw:holders | 2 | 42 | 297,439 | 0.007436 | pass |
| lp | 3 | 51 | 492,596 | 0.012315 | pass |
| sync:wallet | 1 | 17 | 81,048 | 0.002026 | pass |
| syncBatch | 1 | 16 | 114,698 | 0.002867 | pass |
| collect:wallet | 1 | 15 | 71,825 | 0.001796 | pass |
| collect:split | 1 | 16 | 114,214 | 0.002855 | pass |
| release:split:1 | 1 | 14 | 110,678 | 0.002767 | pass |
| release:split:2 | 1 | 14 | 93,578 | 0.002339 | pass |
| release:split:3 | 1 | 14 | 93,578 | 0.002339 | pass |
| collect:holders | 1 | 20 | 236,664 | 0.005917 | pass |
| collect:combo | 1 | 22 | 381,976 | 0.009549 | pass |
| collect:zero | 1 | 14 | 39,039 | 0.000976 | pass |
| sample | 0 | 12 | 0 | 0 | pass |
| claim:holders | 1 | 20 | 96,480 | 0.002412 | pass |
| claim:combo | 1 | 19 | 96,480 | 0.002412 | pass |
| collectFees | 1 | 14 | 41,148 | 0.001029 | pass |
| final | 0 | 48 | 0 | 0 | pass |
| **total** | **97** | **1,721** | **37,433,189** | **0.935830** | **all pass** |

### What the fork run showed

- **Both windows.** All seven curve window buys paid the surcharge at their landed block (8,550 bps one block after the
  launch; RZRO's three at 8,550, 8,100 and 7,650), and `pendingSnipe` moved by exactly that each time. In the pool's
  window every first batch landed whole one block after graduation (8,550 bps for every buy in it), and the scenario
  tokens' second batch whole three blocks after (7,650 bps, on the net for the exact-out buys). The window sells paid
  none. For the 10% tokens the creation block's 90% is capped to 88.5% (9,900 - 50 - 1,000), as the spec caps it.
- **Graduation.** Every pool opened with 24,999.999969 to 24,999.999971 rUSDC and 200M tokens at the model's price
  (tick 366,200 with USDC as currency0, -366,201 as currency1), less than a part per billion from the curve's final
  price; the full-range position took all of the USDC; 7,440,651 to 83,139,851 wei of tokens were left over and burned;
  the curve's surcharge (855 rUSDC, 2,430 for RZRO) became the first bid, from tick 373,200 to 465,400 (or -465,400 to
  -373,200), whose top is 0.497 of the graduation price, and the bid took all of it. `bidRefTick` started at the
  graduation tick.
- **Above graduation, the reference holds.** On every token the first window buy (10,000 rUSDC) started at the
  graduation tick, so its bid (8,550 rUSDC) landed on the graduation bid's range, at salt 2. It lifted the tick by 1,014
  (RWAL, RCMB), 1,090 (RZRO) or 317 (RSPL and RHLD, whose 10% creator fee leaves less of the buy for the pool). The
  second (2,000 rUSDC) started above the graduation price in the same block, and its bid (1,710 rUSDC) landed on the
  graduation bid's range again, at salt 3, in both orientations: half its own pre-buy price would have put the bid's
  top at 372,200 (373,000 on RSPL, -373,000 on RHLD) instead of 373,200 (-373,200), above half the graduation price.
- **The crash case.** The dumps took RWAL's tick to 375,416 (RHLD's to -375,722), through the graduation bid. The
  next window buy started there, so the pool's reference moved down to it, and its 1,710 rUSDC bid landed at [382,400,
  474,600] (RHLD: [-475,000, -382,800]), past the graduation bid's top.
- **The lift back.** The second batch's first buy, sized from the first batch as it landed (60,870 rUSDC on RWAL,
  132,036 on RHLD, at the next block's 8,100 bps), took the price from just above the crash back past the graduation
  price, to tick 363,760 (-361,613): 2,440 (4,588) ticks above it. Its bid (46,566 and 101,008 rUSDC) and the next
  buy's (1,530 rUSDC, from above the graduation price) both still started from half the crashed price, on the crash
  bid's range. Capped at the graduation price alone, the second would have landed on the graduation bid's range
  ([373,200, 465,400] and [-465,400, -373,200]); from its own pre-buy price, higher still ([370,800, 463,000] and
  [-460,800, -368,600]). The exact-out window buys bid from the crash reference too.
- **Every bid** sat wholly under the market, none started above half the graduation price, and every one took all it
  was given, so `lockHeld` stayed 0 and was never written by a window buy; the PoolManager's rUSDC grew by each whole
  buy. At the end RWAL and RHLD hold eight hook positions (the full range and seven bids), the others four, and their
  references stand at the crashed ticks, the others' at graduation.
- **Window gas.** No window transaction used more than 60% of its limit. The most any used beyond the estimate it was
  sent with was 9,907 gas: RHLD's crash buy, estimated before the dump ahead of it in its batch had crashed the price
  (so its bid then opened new ticks).
- **Fees.** Every pool fee sat in the hook as claims until a sync or collection released it; every release equalled what
  the hook held. At the end the launchpad holds 0 rUSDC (everything collected), the hook's claims are 0, and the
  PoolManager holds 36 units of rUSDC more than the 366,127.471559 its positions are worth (rounding in the pools'
  favour).
- **Dividends.** The Holders streams (RHLD directly, RCMB through Combo) grew by about `streamRate × dt × share` over 20 s
  (4,411,408 units against 4,411,405, and 46,974 against 46,960: `streamRate` is rounded down); each claim paid exactly
  `claimable` at its block; 2 units of dust in RHLD (two holders) and 1 in RCMB at the end.

### Gas per transaction (fork)

| step | transaction | gas | USDC at 25 gwei |
| --- | --- | ---: | ---: |
| deploy | launchpad | 5,264,637 | 0.131616 |
| deploy | hook | 2,878,864 | 0.071972 |
| deploy | router | 932,275 | 0.023307 |
| deploy | initialize | 78,336 | 0.001958 |
| deploy | split | 1,040,036 | 0.026001 |
| deploy | holders | 574,991 | 0.014375 |
| deploy | combo | 1,365,727 | 0.034143 |
| raw | deploy RawSwapper | 780,827 | 0.019521 |
| fund | mint 1000000 rUSDC to the burner | 53,154 | 0.001329 |
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
| graduate:wallet | buy RWAL out (graduation) | 660,302 | 0.016508 |
| graduate:wallet | buy RWAL in the pool's window (router) | 290,683 | 0.007267 |
| graduate:wallet | buy RWAL again in the pool's window, above the graduation price (router) | 239,487 | 0.005987 |
| graduate:wallet | dump 150000000 RWAL under half the graduation price (router) | 174,339 | 0.004358 |
| graduate:wallet | buy RWAL in the pool's window after the crash (router) | 286,387 | 0.007160 |
| graduate:wallet | buy RWAL back above the graduation price in the window (router) | 255,544 | 0.006389 |
| graduate:wallet | buy RWAL in the window after that lift (router) | 239,559 | 0.005989 |
| graduate:wallet | sell RWAL in the pool's window (router) | 157,466 | 0.003937 |
| graduate:wallet | exact-out buy of 5000000 RWAL in the window (RawSwapper) | 241,978 | 0.006049 |
| graduate:split | buy RSPL out (graduation) | 643,202 | 0.016080 |
| graduate:split | buy RSPL in the pool's window (router) | 273,663 | 0.006842 |
| graduate:split | buy RSPL again in the pool's window, above the graduation price (router) | 239,483 | 0.005987 |
| graduate:split | sell RSPL in the pool's window (router) | 158,386 | 0.003960 |
| graduate:holders | buy RHLD out (graduation) | 643,537 | 0.016088 |
| graduate:holders | buy RHLD in the pool's window (router) | 272,507 | 0.006813 |
| graduate:holders | buy RHLD again in the pool's window, above the graduation price (router) | 238,327 | 0.005958 |
| graduate:holders | dump 150000000 RHLD under half the graduation price (router) | 172,807 | 0.004320 |
| graduate:holders | buy RHLD in the pool's window after the crash (router) | 288,522 | 0.007213 |
| graduate:holders | buy RHLD back above the graduation price in the window (router) | 253,276 | 0.006332 |
| graduate:holders | buy RHLD in the window after that lift (router) | 237,555 | 0.005939 |
| graduate:holders | sell RHLD in the pool's window (router) | 158,332 | 0.003958 |
| graduate:holders | exact-out buy of 5000000 RHLD in the window (RawSwapper) | 241,898 | 0.006047 |
| graduate:combo | buy RCMB out (graduation) | 643,202 | 0.016080 |
| graduate:combo | buy RCMB in the pool's window (router) | 273,583 | 0.006840 |
| graduate:combo | buy RCMB again in the pool's window, above the graduation price (router) | 239,487 | 0.005987 |
| graduate:combo | sell RCMB in the pool's window (router) | 158,350 | 0.003959 |
| graduate:zero | buy RZRO out (graduation) | 638,051 | 0.015951 |
| graduate:zero | buy RZRO in the pool's window (router) | 253,595 | 0.006340 |
| graduate:zero | buy RZRO again in the pool's window, above the graduation price (router) | 236,451 | 0.005911 |
| graduate:zero | sell RZRO in the pool's window (router) | 155,538 | 0.003888 |
| fund:raw | transfer 30000000 RWAL to the RawSwapper | 39,753 | 0.000994 |
| fund:raw | transfer 30000000 RHLD to the RawSwapper | 39,753 | 0.000994 |
| fund:raw | transfer 30000000 RSPL to the RawSwapper | 56,853 | 0.001421 |
| pool:wallet | buy RWAL (router) | 160,709 | 0.004018 |
| pool:wallet | sell RWAL (router) | 158,386 | 0.003960 |
| pool:split | buy RSPL (router) | 160,689 | 0.004017 |
| pool:split | sell RSPL (router) | 158,350 | 0.003959 |
| pool:holders | buy RHLD (router) | 160,314 | 0.004008 |
| pool:holders | sell RHLD (router) | 158,268 | 0.003957 |
| pool:combo | buy RCMB (router) | 159,769 | 0.003994 |
| pool:combo | sell RCMB (router) | 158,450 | 0.003961 |
| pool:zero | buy RZRO (router) | 156,817 | 0.003920 |
| pool:zero | sell RZRO (router) | 154,590 | 0.003865 |
| raw:wallet | exact-out buy of 2000000 RWAL (RawSwapper) | 146,411 | 0.003660 |
| raw:wallet | exact-out sell for 100 rUSDC of RWAL (RawSwapper) | 151,439 | 0.003786 |
| raw:holders | exact-out buy of 2000000 RHLD (RawSwapper) | 146,896 | 0.003672 |
| raw:holders | exact-out sell for 100 rUSDC of RHLD (RawSwapper) | 150,543 | 0.003764 |
| lp | add outside liquidity to the open RSPL pool (RawSwapper) | 203,239 | 0.005081 |
| lp | buy RSPL through the outside liquidity (router) | 160,744 | 0.004019 |
| lp | remove half the outside liquidity (RawSwapper) | 128,613 | 0.003215 |
| sync:wallet | syncPoolFees RWAL | 81,048 | 0.002026 |
| syncBatch | syncPoolFeesBatch RSPL, RZRO, RWAL | 114,698 | 0.002867 |
| collect:wallet | collectCreatorFees RWAL | 71,825 | 0.001796 |
| collect:split | collectCreatorFees RSPL | 114,214 | 0.002855 |
| release:split:1 | Split release to payee 1 | 110,678 | 0.002767 |
| release:split:2 | Split release to payee 2 | 93,578 | 0.002339 |
| release:split:3 | Split release to payee 3 | 93,578 | 0.002339 |
| collect:holders | collectCreatorFees RHLD | 236,664 | 0.005917 |
| collect:combo | collectCreatorFees RCMB | 381,976 | 0.009549 |
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
- **Bids share ticks until the price reaches a new low.** Each window buy places its bid from half the pool's
  reference, the lowest price any window buy has started from, so every buy that starts at or above it adds a position
  on ticks an earlier bid opened (salts 2 and 3 here on the graduation bid's range; after a crash, every later bid on
  the crash bid's range), and only a buy from a new low opens a new range. Each new range initializes two ticks, which
  is where the crash buys' extra gas goes: the fork measured 77,241 to 79,718 more than the same buy after the window
  on existing ticks, and 125,678 to 128,208 on new ones (V14-SPEC §5: +78k and +121k to +124k, before the reference's
  own storage write).
- A token priced at a tiny fraction of a USDC unit per wei rounds coarsely in the sqrt price: in RHLD's pool (USDC is
  currency1) the swaps left 1,204,534 wei (1e-12 tokens) of rounding with the pool in all; in the other pools 3 to 6 wei.
- Gas: `createToken` is 1.63M to 2.03M (v1.3's was 3.2M to 3.4M: no launch pair to deploy); the sell-out buy with the
  pool's opening, the full-range add and the first bid is 638k to 660k (v1.3's 240k to 286k); a router buy or sell after
  the window about 155k to 161k; a window buy 236k to 240k when its bid lands on ticks an earlier bid opened (253k to
  256k for the lift back, which crosses the graduation bid's top), 254k to 291k for the first buy after graduation
  (which also writes the pool's first fee balances), 286k to 289k when it opens new ticks and moves the reference;
  `syncPoolFees` 81k; `collectCreatorFees` 39k (release only) to 382k (Combo); the suite's deploy 12.1M. Against
  `82d410d`, window buys cost about 200 gas less (`lockHeld` is no longer written and refunded), the crash buys about
  3,500 more (they write the reference), and the exact-out window buys 43,000 less (their bids now share the crash
  bid's ticks instead of opening their own).

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
- **Live timing.** Arc Testnet made 1,000 blocks in 510 s, so a 20-block window lasts about 10 s, and a receipt takes 1
  to 3 s (v1.3's live run; its RPC answers in about 35 ms from here). Sent one by one, the scenario tokens' eight
  window transactions would have needed 8 to 24 s: the crash case could have missed the window. Back to back, each
  batch goes out in a fraction of a second (an estimate and a send per transaction), so the first batch should land 1
  or 2 blocks after graduation and the second a receipt later, about 3 to 8 blocks after it even at 3 s a receipt. On
  the fork, anvil mined each batch whole in one block, at 1 and 3 blocks after graduation, and an in-flight kill and
  restart still landed the second batch at 8. The checks use the landed block either way (a late buy must pay no
  surcharge and place no bid), and the final step fails if the above-graduation (cap), crash or lift-back case is
  missing in either orientation. Live, the first batches landed 1 to 3 blocks after graduation and the second 5. The
  batches' minimums assume nobody else trades these pools meanwhile; if someone does, a buy can revert on its minimum,
  which stops the step (a re-run re-checks what landed).
