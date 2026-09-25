# Claude review #8: launchpad v1.4 after the review #7 fixes (2026-09-25)

Independent adversarial pass (a separate Claude session, read-only, Foundry PoCs in its own worktree
`.claude/worktrees/v14-review2`, 130 tests in `contracts-v14/test/review8`) over branch `v14` at `5c09bb3`: the claims
design, release and sync, donations refused, fresh anchored bids. Verdict: no High; one new Medium, introduced by the
L2 fix (the anchored bid can be placed above a crashed market and harvested).

**What was done about it:** pending the owner's choice of fix for M1 (see the end of this file once decided). The
spec corrections that do not depend on it are made.

---

**Verdict:** No High. There is one new Medium, and the L2 fix introduced it: after a crash, anyone can place the waiting snipe claims above the market with a push inside one transaction, then sell into them at a profit. Everything else in 525c4cc and 5c09bb3 held up under PoC.

**Where the PoCs are:** `/Users/angusdurrie/Development/arc-dex/.claude/worktrees/v14-review2/contracts-v14/test/review8/`. The folder is untracked; nothing else was touched and nothing was committed. `FOUNDRY_PROFILE=v14 ~/.foundry/bin/forge test` now runs 202 tests, all passing: the 72 existing ones plus 130 in review8. Every PoC runs with USDC on both sides of the pair (currency0 and currency1), and the numbers came out the same in both.

## Medium

**M1: the anchored bid can be placed above a crashed market in one transaction and harvested.**
- **PoC:** `AnchoredBidHarvest.t.sol`, tests `test_harvestAtAQuarterOfGraduation`, `test_harvestAtATenthOfGraduation`, `test_harvestWithATenPercentCreatorFee` and `test_harvestWithNoTokensToStart`.
- **Cause:** `_lockBid` decides `ok` from the current tick. Once the market is below the bid's top, an honest `lock()` returns 0 and the opening-window claims wait. In one transaction, anyone can:
  1. make an exact-out buy with a price limit just past the top;
  2. call `lock()`;
  3. sell back down to where the price started.
  
  The bid lands above the real market and buys the seller's tokens at above-market prices.
- **Numbers**, with 18,000 USDC of claims waiting and a 0% creator fee:

| Market price | Round trip without `lock()` | Round trip with `lock()` |
|---|---|---|
| 1/4 of graduation | −53.51 USDC | +1,479.62 USDC |
| 1/10 of graduation | −99.41 USDC | +5,405.87 USDC |
| 1/10, 10% creator fee (17,700 waiting) | −2,204.50 USDC | +2,220.77 USDC |
| 1/10, attacker holding only USDC | −99.41 USDC | +3,682.81 USDC |

  - The USDC-only attacker holds no tokens and gets his 20k USDC capital back in the same transaction.
  - The premium is about C × (1 − √(market / top))², less the pool fees on the push.
- **Why it is new:** at 217d207 the bid's top followed the market down (half the cheaper of the current and graduation price), so any honest `lock()` placed waiting claims below the market. Now no honest `lock()` can place them after a crash, so they sit as a prize, and pushing to half the graduation price is always enough.
- **Scope:** only opening-window claims that were not locked while the price was above the top. No new claims arrive after the window. The graduation bid (curve snipe fees) is not affected.
- **Fix, recommended, prototyped as variant B** (`FixedLaunchHookB.sol`, checked in `AnchoredBidHarvestFixedB.t.sol`):
  - In `_beforeSwap`, record the tick at the start of each block (the first swap's pre-swap tick). `_beforeSwap` stops being `view`.
  - Put the bid's top at half the cheaper of the graduation price and that block-start price.
  - Keep `ok` on the current tick.
  - With this, an honest `lock()` always places the claims below the market, so nothing waits and the §10 limit goes away. A push inside the same block, up or down, moves nothing, and the harvest round trip nets exactly its fees.
  - It passes the full core suite, review #7's suites (including the L2 regression test) and its invariant run unchanged (`FixedHookRegression.t.sol`).
  - What remains: a push to more than twice the target top, held across a block boundary and open to arbitrage.
- **Minimal alternative** (`FixedLaunchHook.sol`, checked in `AnchoredBidHarvestFixed.t.sol`): keep the anchor, and also require `ok` at the block-start tick.
  - This stops the one-transaction harvest, but the claims stay a prize for a two-block push.
  - One core test, `test_aBidWaitsWhileThePriceIsBelowItsTop`, would then need a one-block step before its `lock()`.
- **Until it is fixed:** have a keeper call `lock()` in every opening-window block and right after the window.
- **Clean-up:** the two hook copies and `FixedHookRegression.t.sol` are test-only; delete them once a fix is in `src`.

## Low
None.

## Informational
- **I1: `ok` is stricter than v4 at one exact boundary.** PoC: `BidBoundary.t.sol`, `test_topReachedByASellWaits` and `test_topReachedByABuyLocksOneSided`.
  - When a sell stops exactly on the top (tick == top with USDC as currency0, top − 1 with USDC as currency1), `lock()` places nothing, although v4 would take USDC only (shown with an outside LP).
  - Reached from the other side, it locks one-sided. The claims just wait for the next trade. No fix needed.
- **I2: anyone can add claims to the hook.** PoC: `ClaimsAccounting.t.sol`, `test_claimsSentToTheHookAreOwedToNobodyAndStuck`. 1,000 USDC of claims minted to the hook inside a third party's unlock stay stuck, and no path spends claims the books don't track. Only the equality form of the invariant breaks.
- **I3: plugins can now trade in the pool from inside `onFees`.** PoC: `PluginTradesInOnFees.t.sol`, `test_aPluginBuysInThePoolFromInsideOnFees`.
  - At 217d207 this reverted, because a pool swap called the launchpad's nonReentrant `accrueTradeFees`. Now it lands.
  - The exact-pull check still holds. The NatSpec needs updating, and whoever builds Deepen pool v1.4 should know whether it can rely on this.

## What holds
- **Claims accounting:** every mint is credited and every burn debited to the same token's books. The hook sets no operator or allowance, so third parties cannot burn or move its claims (`test_nobodyElseCanBurnOrMoveTheHooksClaims`), and nothing leaks between tokens (`test_noLeakAcrossTokens`). The existing invariants, rerun at 1,024 runs × depth 300, pass.
- **Release and sync:**
  - `release` pays exactly what it returns, and only the launchpad can call it.
  - Both launchpad entry points hold the reentrancy guard.
  - The release happens before the exact-pull balance reading.
  - I swept gas limits from 30k to 600k (`CollectGasGrief.t.sol`): no call ever succeeds with the release skipped, and the lowest successful limit is 109k.
  - A caught release rolls back entirely.
  - The plugin runs after the release and cannot reach `release` or `syncPoolFees`.
- **Swaps:** only `_collect` changed. Fee math, PartialFill and the router's quote path are untouched. With Uniswap's maximum protocol fee (0.1% each way) turned on for our pool, all four swap kinds settle, PartialFill passes, and fee growth stays 0 (`ProtocolFee.t.sol`).
- **Bids** (`BidMath.t.sol`, 50,000 runs per property):
  - Every range the hook admits is on the tick spacing, inside the usable ticks, at least 6,932 ticks past graduation, and one-sided by v4's own branch.
  - `used ≤ lockHeld` for any amount up to 1e17 at any admissible range.
  - At the real graduation price, any amount of 1 unit or more locks, leaving at most 2 units.
  - Clamping to the extreme tick needs a graduation tick past about ±787,900; every curve graduates near ±366,200.
  - `BidNotOneSided` is unreachable.
  - Outside someone else's unlock, `lock()` cannot be made to revert, short of spending about 3e16 USDC to fill a tick.
- **No other fee accrual to hook positions:** the LP fee is a static 0 (no dynamic flag), a protocol fee goes entirely to the protocol when the LP fee is 0, and donations are refused.
- **Open pools** (`OpenPoolBidTicks.t.sol`): filling a bid tick's liquidity cap costs about 3.0e16 USDC at the far tick and 3.0e18 USDC at the top. Outside LPs and JIT positions sitting exactly on the bid's ticks change nothing.
- **Graduation:** the full-range add never uses more USDC or tokens than it was given (fuzzed from 1,000 USDC to 1B USDC against 10M to 1B tokens), so `_openPool`'s leftover subtraction cannot underflow. The price comes from the amounts. `_sqrtPriceX96` could only overflow if a curve seeded under about 11 USDC, which cannot happen.
- **Licences:** every file the hook compiles is MIT.

## Spec errors
- **§5 and §10:** "pushing the price before a lock cannot move it", "the USDC waits as claims" and "Nobody can withdraw it either way" are all contradicted by M1.
- **§10, USDC blocklist:** a blocklisted launchpad does not stop "only payouts". It also stops curve buys and sells, graduations, launches that pay a launch fee, and syncs (`BlocklistScope.t.sol`, `test_aBlocklistedLaunchpadStopsTheCurvesAndGraduationToo`). The hook half of that paragraph is correct (`test_aBlocklistedHookStopsOnlyGraduation`).
- **§11:** "claims are exactly what it owes" should read "at least" (I2).
- **§10, in-unlock list:** it leaves out `createToken` with a graduating first buy, and `syncPoolFeesBatch`.
- **`IArchitexLaunchpadV14.collectCreatorFees` NatSpec:** it says plugins cannot trade from inside `onFees`, but pool trades now work there (I3).

## Not proven
- The two-block variant of M1 against the fixed hooks: it depends on Arc's transaction ordering and on arbitrage, so it is reasoned only.
- Arc's native versus ERC-20 USDC duality inside the PoolManager: the USDC precompile cannot run in tests, so this is reasoned only.
- The mock USDC blocklist only checks sender and recipient; Circle's also blocks the spender. By reasoning, that changes none of the conclusions.
