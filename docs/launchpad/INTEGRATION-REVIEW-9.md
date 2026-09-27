# Integration review #9b: launchpad v1.4 with Uniswap's periphery and aggregators (2026-09-25)

An independent Claude session, integration lens, over branch `v14` at `6a49fea` (snipe fees placed as bids inside the
buy): Uniswap's V4Quoter and V4Router (upstream v4-periphery 1.0.3), multi-hop and multi-swap unlocks, every payment
style, gas and gas estimation, events for indexers, and the routing allowlist. 70 tests in its own worktree
(`.claude/worktrees/v14-grok9`, `contracts-v14/test/integration9`). Verdict: compatible; no High or Medium; one Low
(window-buy gas depends on tick state other trades change).

**What was done about it:**
- **Low 1 (gas drift): reduced and documented.** The bid reference is now the pool's lowest window price
  (`bidRefTick`, Claude review #9's follow-up), so most window bids land on ticks an earlier bid opened and a buy
  landing first no longer moves the next bid; `lockHeld` is written only when its rounding changes (the reviewer's
  second fix, removing a write-and-refund from every window buy). The coarser bid grid was not taken (it would put
  bids up to 22% deeper). V14-SPEC §5 has the measured table and the headroom guidance for integrators.
- **Informational 1 to 4:** the gas table (§5), the indexer rules (§9), the allowlist submission notes and the
  aggregator notes (§12) are in V14-SPEC; "quotes equal fills through the V4Quoter and V4Router" is a §11 invariant.
- The integration tests become permanent tests in `contracts-v14/test/integration9`, rerun against the current hook.

---

## Verdict

**Compatible.** Adding the bid inside afterSwap breaks nothing in Uniswap's quoting, routing or settlement, in any flow I tested.

- **Quotes:** the V4Quoter's quote equals the V4Router fill to the unit, fee and bid included, for all four swap kinds, both USDC sort orders, and inside and after the window.
- **No trace:** a quote leaves no state behind.
- **Pre-swap tick:** the transient tick is the right one for every swap, including several swaps in one unlock and interleaved pools.
- **Payment styles:** every one I tried settles correctly.

The only real integration cost is gas. A window buy uses 1.5x to 2.1x the gas of a normal buy, and how much depends on tick state that other trades change. So a gas estimate taken a moment earlier can come up 16% to 25% short. No High or Medium. I found no security issues.

181 tests pass: the 111 existing plus 70 new, which also pass with `--no-isolate`. All new code is in `contracts-v14/test/integration9/`. Nothing tracked was changed or committed.

## Findings

### Low 1: window-buy gas depends on state other trades change

The bid's ticks come from the pre-buy tick, snapped to 200-tick steps. Whether those ticks and their bitmap words already exist changes with every price move of about 2%.

Evidence is in `EstimateDrift.t.sol` and `GasProfile.t.sol::test_gas_windowBuysByTickState`, in both USDC orders:

- **Another buy lands first** (`test_anotherBuyLandingFirstRaisesTheGasABidNeeds`): an estimate of 266.0k to 266.8k needs 310.7k to 313.3k (+16.4% to +17.8%). Headroom of +10% and +15% runs out of gas; +20% succeeds.
- **The bid also opens a new bitmap word** (`test_anotherBuyLandingFirstCanAlsoOpenANewBitmapWord`): it needs 329.0k to 331.6k (+23.3% to +24.6%). +20% fails; +25% succeeds.
- **Limit copied from a receipt** (`test_aLimitCopiedFromAReceiptIsTooLow`): a window buy's receipt is 240.1k to 240.9k but it needs 266.0k to 266.8k, 10.8% more. Every window buy gets a 19,900 refund because `lockHeld` goes 0, then the fee, then 0.
- **Time alone only lowers gas** (`test_theWindowClosingOnlyLowersTheGas`): 319k to 320k in the last window block drops to 218k in the next. `eth_estimateGas` does include the bid correctly; the drift comes from state, not from the block number.
- **A cheap griefing variant I tripped over:** a sell pays no surcharge. Placed just before someone's window buy, it moves that buyer's bid onto new ticks, adding up to about 60k gas. Nuisance only, and only against tight limits; nobody loses funds.

Only the 20-block window is affected, and the cost is failed transactions, not lost funds.

Fixes:
- **Coarser bid grid (hook change):** snap the bid top further from the price onto a coarser grid, for example multiples of 2,000 ticks, or give each pool a fixed far tick. The typical window buy would then cost the "existing ticks" figure (+79k receipt, +101k limit) instead of +121k to +142k, and estimates would stop drifting. The trade-off: bids sit up to one coarse step further below half the pre-buy price. That needs your call and the security reviewer's.
- **Drop the `lockHeld` round trip (hook change, behaviour unchanged):** pass the snipe fee to `_placeBid` in memory and write `lockHeld` only when the leftover changes. This saves about 20k of gas limit and about 2k of receipt per window buy. It is an estimate from the measured 19,900 refund; I did not run a modified hook.
- **Integration note regardless:** while `snipeBpsOf(token) > 0`, re-estimate right before sending and use at least 30% headroom (or +200k). Never size a limit from a previous window buy's receipt.

### Informational 1: the spec §5 gas figure is too low

§5 says a window buy costs "about 80,000 more gas … a little more for new ticks". Measured against a buy after the window:

| Bid lands on | Receipt | Gas limit |
|---|---|---|
| Existing ticks | +78k to +79k | +101k to +102k |
| New ticks (the usual case) | +121k to +124k | +146k to +149k |
| New ticks and a new bitmap word | +139k to +142k | +164k to +167k |
| The pool's first bid (no graduation bid) | +170k to +173k | +196k to +199k |

### Informational 2: events are enough, with rules an indexer must follow

Every trade rebuilds exactly from logs and matches the real balance changes (`EventReconstruction.t.sol`, all three tests). The rules:

- **The Swap event is pool-side.** On a buy its USDC is net of the platform, creator and snipe fees (in the window, as little as 10% of what the trader paid). On a sell it is gross. Its `fee` field is always 0.
- **Trader amounts come from PoolTrade:** a buy paid `usdcAmount`; a sell received `usdcAmount − platform − creator`.
- **Pairing:** each Swap is followed by its own PoolTrade before the next Swap in that pool, including multi-swap transactions.
- **Window buys** emit ModifyLiquidity (sender = hook) and then BidLocked between the two. BidLocked's USDC equals the snipe fee within 2 units of rounding.
- **The hook's claim mint and burn** are the PoolManager's ERC-6909 `Transfer` events. ERC-20 indexers cannot mistake them for USDC transfers.

Generic v4 indexers will see these pools as 0% fee and will undercount buy volume.

### Informational 3: notes for the Uniswap allowlist submission

Nothing in the v4 sources rules the hook out. The flags 0x28EC pass `isValidHookAddress`, with no liquidity-return deltas. What needs explaining:

- **Both swap return-delta flags:** fees are always in USDC, with the exact formulas.
- **The liquidity add inside afterSwap:** only in the first 20 blocks; always below the price and out of range; added after the swap, so it cannot change that swap's output; reproduced exactly by the quoter.
- **The surcharge:** up to 90%, with the total capped at 99% (88.5% surcharge at a 10% creator fee). It is time-bounded and readable through `snipeBpsOf`.
- **`PartialFill`:** exact-in buys and exact-out sells revert when a price limit stops them. The Universal Router, V4Router and V4Quoter use extreme limits, so they never hit it.
- **Dust reverts (`FeesExceedAmount`):** a buy under 30 raw USDC units in the opening block, or under 3 after the window.
- **Closed pools** make PositionManager mints revert with `WrappedError(ClosedPool)`; this affects LP screens, not routing.
- **Donations refused, initialize restricted, no admin or upgrade path, fees fixed.**

### Informational 4: notes for aggregators

- **Quoter-based routing works as-is.**
- **Off-chain simulators (KyberSwap, 0x)** must implement: the per-token creator fee from `launchOf`; the 50 bps platform fee; the block schedule from `openBlock`; the rounding (each component rounded up; exact-out gross-up with the platform fee split first); and the 99% cap. They should take the bid in as a state change from events.
- **Stale quotes are safe in the window.** A quote landing one block later fills at least 4.6% better (`test_aQuoteFromAnEarlierWindowBlockNeverFailsItsFill`).
- **Large dumps after a busy window** cross bid top ticks at about 11k gas each: 278.6k vs 164.6k for 10 bids.

## What works (all in both USDC orders)

- **Quoter vs router (`QuoterRouterParity`):**
  - all four kinds after the window, in the opening block, mid-window, in the last window block, at the fee cap, and with no graduation bid in an open pool;
  - hook state is unchanged by quoting;
  - the result doesn't depend on who asks;
  - the V4Quoter and the Architex router's own quotes agree.
- **Multi-hop and multi-swap (`MultiHop`):**
  - exact-in OTHER→USDC→TOKEN (in and after the window) and TOKEN→USDC→OTHER;
  - exact-in A→USDC→B with both pools in their windows;
  - exact-out in all three shapes;
  - four swaps in one unlock, each bid from its own starting tick in a different tick bucket;
  - buy, sell everything, buy again in one unlock;
  - window buys interleaved across two of our pools.
- **Payment styles (`PaymentStyles`):**
  - settle first (OPEN_DELTA), take before settle, router pays from its own balance;
  - `sync` before the swap and `settle` after it;
  - ERC-6909 claims as input and output (exact in, exact out, sell);
  - prepaying the maximum and taking the refund on an exact-out buy.

## Gas (receipt gasUsed / gas limit needed; USDC low, then high)

| Case | Receipt | Limit | V4Quoter gasEstimate |
|---|---|---|---|
| Plain unhooked v4 hop | 113.8k / 113.7k | 114.9k / 114.8k | 37.9k / 37.4k |
| Buy after the window | 161.9k / 161.8k | 164.8k / 164.7k | 77.3k / 76.8k |
| Window buy, existing ticks | 240.9k / 240.1k | 266.8k / 266.0k | 176.2k / 175.0k |
| Window buy, new ticks | 283.4k / 285.9k | 310.7k / 313.3k | 218.7k / 220.8k |
| New ticks and a new word | 300.9k / 303.4k | 328.8k / 331.4k | 236.2k / 238.3k |
| Pool's first bid | 332.2k / 334.7k | 361.1k / 363.7k | 267.5k / 269.6k |
| Window exact-out buy, new ticks | 281.5k / 284.9k | 308.8k / 312.3k | 216.2k / 219.1k |

A window buy is 2.1x to 2.9x a plain hop.

From memory, and not verified here: Uniswap's router budgets roughly 80k gas per hop plus 31k per initialized tick crossed, and aggregators use similar per-hop figures (roughly 100k to 150k). So a window buy is one to two extra hops' worth.

- **Routes skipped for cost?** Not plausibly: on Arc this is a fraction of a cent, far below even the last block's 4.5% surcharge.
- **Reverts under tight gas limits?** Yes, as described in Low 1.

## What the spec should say

- **§5:** replace the cost sentence with the table above, and add the gas-limit guidance from Low 1.
- **§9:** the indexer rules from Informational 2.
- **§2 and §12:** the simulator requirements, dust minimums and `PartialFill` behaviour, plus an allowlist submission paragraph covering Informational 3.
- **§11:** add "quotes equal fills through Uniswap's V4Quoter and V4Router" as an invariant.

## Test setup notes

- **V4Router copy:** V4Router pins `pragma 0.8.26`, and this profile compiles only 0.8.28. So `PeripheryV4Router.sol` is upstream v4-periphery 1.0.3 copied verbatim, except the pragma, import paths and contract name (diff checked). V4Quoter is imported directly.
- **PositionManager could not be compiled** here, so the closed-pool behaviour above comes from reading the code.
- **Gas measurement:** forge 1.8.1 runs tests in isolation by default, so each call is its own transaction and the numbers are real per-transaction figures. The installed forge returns a five-field gas struct where this forge-std declares six, so the tests read it through a local interface.

## Files

In `/Users/angusdurrie/Development/arc-dex/.claude/worktrees/v14-grok9/contracts-v14/test/integration9/`:
- `Integration9Base.sol`
- `PeripheryV4Router.sol`
- `QuoterRouterParity.t.sol`
- `MultiHop.t.sol`
- `PaymentStyles.t.sol`
- `GasProfile.t.sol`
- `EstimateDrift.t.sol`
- `EventReconstruction.t.sol`

Run them with `FOUNDRY_PROFILE=v14 ~/.foundry/bin/forge test --match-path 'contracts-v14/test/integration9/*' -vv`.
