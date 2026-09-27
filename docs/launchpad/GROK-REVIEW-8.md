# Grok Build red-team review #8: launchpad v1.4 after the review #7 fixes (2026-09-25)

Read-only pass over branch `v14` at `5c09bb3` (worktree `.claude/worktrees/v14-grok8`), run in parallel with Claude
review #8. Verdict: no High, no Medium, no Low.

**What was done about it:** it missed the Medium Claude review #8 proved with PoCs (after a crash, the anchored bid can
be placed above the market inside one transaction and harvested; see CLAUDE-REVIEW-8.md). Its blocklist correction is
the same as Claude's and is made; its remaining wording notes (§4 step order, §5 clamping) are folded in with the M1
fix, which rewrites §5.

---

I'll review the v1.4 fee-claims and bid-range fixes against the earlier findings, starting with the diff, spec, and prior reviews. No files will be changed.The hook's claim and bid-range changes are the core of this pass. Next I'll read the launchpad, router, and Uniswap's delta rules those changes depend on.The claim and bid paths depend on Uniswap's rounding. I'll check whether a bid can be asked for more USDC than `lockHeld`, and whether that can make `lock` revert.**Verdict:** no High, no Medium, and no Low. The three review-#7 fixes hold. v1.4 is ready for an Arc Testnet rehearsal.

I re-ran `FOUNDRY_PROFILE=v14 forge test`: 72 tests, all passing, both USDC sort orders, against the etched Arc PoolManager. A separate rounding check (outside the repo) covered every 200-tick-aligned bid span and every one-spacing range, plus 2,000 random amounts.

## Findings

None.

## What holds

**Claims.** Every mint and burn moves the hook's USDC claims by the same amount it adds to or removes from `pendingPlatform + pendingCreator + lockHeld`. Swaps mint the fee and credit all three counters. `release` burns exactly the platform and creator counters it zeroes. `lock` burns exactly the USDC the new position took and subtracts that from `lockHeld`. Graduation pays the leftover USDC in, mints it as claims, then locks. The claims are one fungible USDC balance shared by every token. A lock on token B can spend claims that a swap on token A just minted, and the sum still matches, because B only burns up to its own `lockHeld`. Releasing A afterwards still finds enough claims.

`used` does not exceed `lockHeld`. For a USDC-as-currency1 bid the pool rounds liquidity down and the deposit up, and that pair of roundings cannot ask for more than it was given. For USDC-as-currency0 the same held on every aligned range in the tick grid and in the fuzz. When liquidity is at least 1, the deposit is at least 1 raw unit, so a bid cannot be created for free. At this curve's price, 4,500 USDC of claims converts to liquidity that consumes the 4,500 USDC exactly.

**Release, sync, and collect.** `release` is launchpad-only. It zeroes the two counters, burns that many claims, and `take`s the same amount of USDC to the launchpad. If `take` reverts, the whole call reverts and the counters stay. `syncPoolFees` and `syncPoolFeesBatch` book exactly the amounts `release` returns. A second sync of the same token books zero. Booking without receiving would require `release` to return an amount it did not transfer. Receiving without booking would require a successful `release` whose caller skips `_bookPoolFees`. Both callers book in the same call. A direct USDC transfer to the launchpad is still an unaccounted donation, as in v1.3, and no function pays out `balanceOf`.

`collectCreatorFees` calls `release` inside `try/catch`, then snapshots the launchpad's USDC balance, so the USDC from a successful release is already in the balance the plugin is checked against. The plugin must pull exactly the creator amount. Platform fees that arrived in the same release stay in `pendingFees`. The allowance is only the creator amount. The launchpad holds `nonReentrant` across the whole call, and Circle USDC does not call the recipient, so the plugin cannot re-enter `sync`, `buy`, `sell`, or `collect`. An empty `catch` is not a gas grief: `release` reverts with a short error (`AlreadyUnlocked`, or USDC's blacklist revert), and the gas left for an empty catch is far more than copying that error costs.

**Swaps.** All four shapes settle in both sort orders. A positive hook delta means the pool owes the hook that much USDC and the caller owes it on top. `afterSwap` mints that many claims, which debits the hook, and the PoolManager then credits the hook the same delta. They net to zero, and no USDC moves during the swap. Exact-in buys and exact-out sells fix the fee in `beforeSwap` and revert `PartialFill` if the pool does not fill that USDC. Exact-out buys and exact-in sells charge the fee on the USDC the pool actually took or paid. Sells never add the surcharge. The fee sum is minted, so the split's rounding cannot leave the claims short of the counters.

**Bids.** The range is anchored to the graduation tick. With these reserves the pool opens at tick 366200 when USDC is currency0, and at tick -366201 when the token is. The bids land at [373200, 465400] and [-465400, -373200]: 7000 and 6999 ticks below graduation, about 49.7% of the graduation price, and 92,200 ticks deep. The two sort orders differ by the extra tick the currency0 path adds before it rounds. Both stay beyond half price. The half-open tick test matches the pool: USDC-only when `tick < lower` (USDC is currency0) and when `tick >= upper` (USDC is currency1). On that side the pool's other-token amount is hardcoded to 0, so `BidNotOneSided` does not fire. While the price is past the top, `lock` returns 0 and the claims wait. `lock` reverts `NothingToLock` only when `lockHeld` is already 0.

Tick arithmetic fits in `int24` for every tick `initialize` can return. A bid reaches the extreme tick only if the graduation tick is past ±788000, and the range becomes empty (a bid that can never be placed) past ±880200. This curve is about 400,000 ticks away from either.

**Fees on the hook's positions.** The pool fee is the static 0, so swap fees do not accrue. A protocol fee, if Uniswap turned one on, is taken entirely by the protocol when the LP fee is 0, and it does not credit positions. `beforeDonate` always reverts. The permission mask is `0x28EC` (the donate bit is `1 << 5`). A fresh salt means `Position.update` computes fees on zero prior liquidity, so a new bid is owed nothing even if fee growth were nonzero. The hook never donates or swaps, which is the only way v4 would skip `beforeDonate`.

**Open pools.** The old attack filled the extreme tick for about 21 million USDC, because that tick was shared with the full-range position and is cheap to saturate. These bids end at tick ±465400. Saturating the far boundary now takes about 3.02×10^16 USDC, and the near boundary about 3.01×10^18 USDC. An outside LP can still rest a better bid of their own. They earn no LP fee, and they cannot remove the hook's position.

**Graduation.** The price is the ratio of the amounts, the full-range position and the first bid are added in one unlock, and an outside LP cannot get in between them. Leftover tokens are burned. Leftover USDC joins the bid as claims. `beforeInitialize` refuses every other initializer.

## Spec corrections

- **§10, the blocklist paragraph.** A Circle blocklist rejects both sending and receiving. A blocklisted launchpad stops curve buys, curve sells, graduation, sync, and payouts. Pool trading continues, and the pool's fees stay as the hook's claims until the launchpad can receive USDC again. A blocklisted hook stops graduation, because the launchpad transfers the curve's USDC to the hook and the hook transfers it into the pool. Curve trading, pool swaps, `lock`, and `release` continue: none of those transfer USDC to or from the hook. `release` transfers from the PoolManager to the launchpad.
- **§5, "never reaches the extreme tick."** True for these reserves, as the ticks above show. The code does clamp a bid onto the min or max usable tick when the anchored span would run past it, and it gives up if the near edge is past that tick too. Both of those sit far above this curve's graduation price.
- **§4, step order.** The code burns leftover tokens before it mints the bid's claims. The spec lists the burn after the bid. Both happen in the same unlock, and `LaunchTokenV14.burn` makes no external call, so the outcome is the same.
- **§3 and §11.** `collectCreatorFees` syncs first only when `release` succeeds. §10 already says an `AlreadyUnlocked` failure skips the sync and pays what the launchpad holds. §11's "`lock` never reverts once there is something to lock" holds for this curve. The remaining way for `modifyLiquidity` to revert is `TickLiquidityOverflow` on the bid's own boundary, at the USDC cost above.
