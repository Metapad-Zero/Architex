# Launchpad v1.4: the Arc Testnet rehearsal

This is the Arc Testnet rehearsal of V14-SPEC §11. It deploys the v1.4 suite with its own Foundry script, then drives
every part of it through real transactions against Uniswap's own v4 PoolManager on Arc Testnet
(`0x8366a39CC670B4001A1121B8F6A443A643e40951`). Five tokens are launched, bought inside and after the curve's snipe
window, graduated into Uniswap v4 and traded there, and every fee is synced, collected and paid out. The books are
checked to the unit after every transaction.

**Status, 2026-09-25: built, and proven end to end on a local anvil fork of Arc Testnet at `f9649d4`, which includes
`v14` at `39a78b4`: the owner's option A (a buy's snipe fee becomes a bid inside that buy, and `lock` is gone), with
every window bid placed from half the pool's reference, `bidRefTick`: the lowest price any window buy has started from,
the graduation price to begin with (Claude review #9's L1 and its residual). Nothing has been sent to Arc Testnet or
mainnet.** The live run waits for the two security reviews in progress.

| Fork dry run (Run A, rUSDC) | Transactions | Checks | Gas | USDC at 25 gwei |
| --- | ---: | ---: | ---: | ---: |
| deploy (the Foundry script) | 7 | 36 | 12,134,866 | 0.303372 |
| drive (5 tokens, 5 graduations) | 90 | 1,685 | 25,298,323 | 0.632458 |
| **total** | **97** | **1,721** | **37,433,189** | **0.935830** |

Every check passed, before and after each merge (option A, the graduation-price cap, then the reference), and **no
contract behaviour contradicted the spec**. The pool window's transactions now go out back to back, without waiting for
receipts, so the window's cases land in a few blocks whatever the RPC's latency (below). "USDC at 25 gwei" is what Arc
Testnet charges (a 20 gwei base fee plus the node's 5 gwei tip, so 1M gas is 0.025 USDC); the fork's own gas prices
mean nothing (below).

Run B, on Arc's own USDC, was built and typechecked. On the fork it deploys, passes every deployment check and launches
its token, then stops at its first USDC transfer, as it must: Arc's USDC is a precompile that a fork cannot execute. It
only runs live.

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

On the fork Run B deployed (12,114,246 gas), passed its 34 deployment checks, approved (55,438 gas; Arc's USDC keeps
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
`GAS_CAP` (2 USDC of gas for Run A's progress file, 1 for Run B's).

**Order matters.** Deploy Run A first, as the burner's next transaction, so it lands at nonce 272 and reproduces the fork
run's addresses and orientations (check `--preview` first). Run B's deploy then comes 97 nonces later; Run B opens no
pool, so its orientation does not matter.

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

### Results, by step

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

### What the run showed

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

### Gas per transaction

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
  missing in either orientation. The batches' minimums assume nobody else trades these pools meanwhile; if someone does, a buy can
  revert on its minimum, which stops the step (a re-run re-checks what landed).
