# Claude review #7: launchpad v1.4 (2026-09-25)

Independent adversarial pass (a separate Claude session, read-only, Foundry PoCs in its own worktree) over branch `v14`
after Grok #7's router fix: the v1.4 launchpad, the Uniswap v4 hook, the v1.4 token and the v4 router (V14-SPEC.md).
Verdict: no High and no way to steal or drain funds; one Medium, two Lows.

**What was done about it** (all on branch `v14`; the PoCs, turned into regression tests that now assert each attack
fails, are in `contracts-v14/test/review7`):
- **M1 (a dust donation freezes `lock()`): fixed.** The hook refuses every donation (`beforeDonate`, permission bits
  `0x28CC` to `0x28EC`, so the hook address is re-mined), and every bid is a fresh position (`salt = ++bidCount[token]`)
  that has no fees; a bid that would take any token reverts (`BidNotOneSided`). An invariant now checks that `lock()`
  never reverts and no donation lands.
- **L1 (fees paid out of the PoolManager's USDC before the trader pays; Grok #7's Medium): fixed.** Every fee is the
  hook's ERC-6909 USDC claims (`mint`); no USDC moves during a swap. The launchpad pulls them with
  `syncPoolFees(token)` (permissionless, batch form too) and `collectCreatorFees` syncs first (best effort, so a failed
  release never blocks paying out what the launchpad already holds). `accrueTradeFees` now always reverts.
- **L2 (pushing the price before `lock()` parks the bid lower): fixed.** The bid is anchored to the graduation price
  alone; while the price is under the bid's top, `lock()` places nothing and the claims wait (V14-SPEC §10).
- **Open-pool tick cap (informational; Grok #7's Low): fixed.** A bid runs `BID_SPAN_TICKS` (92,200) down from its top
  instead of to the extreme tick the full-range position uses.
- **Sniper refunds, the unbounded creator exemption, approval-free sells, no unlocking inside an unlock, the dust
  split:** written into V14-SPEC §5 and §10 as measured.
- **Spec errors:** all corrected (§3 permissions and fee path, §4 the PoolKey, §5 the cap, the anchor and the refund
  numbers, §7 Deepen v1.4 and `pairOf`).
- **Not taken:** the defensive "take and burn any token fee `modifyLiquidity` returns". With donations refused and
  every bid a new position, a hook position never has fees; the hook reverts instead of absorbing an unexpected token
  delta, so any future mistake shows up as a revert rather than a silent burn.

---

I found no High in v1.4 and no way to steal or drain funds. There is one Medium (anyone can cheaply stop the pool's snipe fees from being locked), two Lows and some informational notes. Everything is proven with Foundry PoCs.

**Verdict:** ready for an Arc Testnet rehearsal once M1 is fixed. Fix it first because the fix changes the hook's permission bits, so the hook address has to be re-mined.

All PoCs are in `/Users/angusdurrie/Development/arc-dex/.claude/worktrees/v14-review/contracts-v14/test/review/` (untracked, nothing else touched, nothing committed). Helpers are in `ReviewBase.sol`. `FOUNDRY_PROFILE=v14 forge test` runs 58 tests, all passing, and every PoC runs with USDC as both currency0 and currency1.

## M1 (Medium): a dust donation permanently stops `lock()` while the token trades at or above its graduation price
**PoC:** `LockDonationFreeze.t.sol`, `test_donationFreezesLockWhileAboveGraduationPrice`. Supporting: `LockDoSExtras.t.sol`, `test_anyDustDonationAccruesToTheFullRangePosition`.

- **Cause:** the hook has no `beforeDonate`, so anyone can donate to the pool. `_lockBid` re-adds to the same position (owner hook, salt 0) whenever the price is at or above graduation, and v4 folds a position's accrued fees into the caller's delta on every `modifyLiquidity`. The hook only pays the USDC side, so the unpaid token fee ends the unlock in `CurrencyNotSettled`, every time.
- **The attack:** inside one unlock, sell 100M tokens to push the price into the graduation bid's range, donate 1 token, then buy the 100M back.
  - Cost: 86.23 USDC plus 1 token (about 0.000125 USDC). That is at a 0% creator fee; at 10% it is roughly 1.75k USDC.
  - The price ends at the same tick. Every later `lock()` reverts, including after 1,000 more blocks of trading.
  - The 4,500 USDC of opening-window snipe fees in the PoC, and any later ones, sit idle in the hook instead of becoming the bid.
- **No curve snipe needed:** without a graduation bid, an attacker first calls the permissionless `lock()` on a tiny held amount to create the position, then bricks it. The freeze lifts only when the price falls below graduation, and the bid then lands lower.
- **Worse for Deepen pool v1.4:** the full-range position is always in range. A plain 1-token donation, with no price push, already leaves 0.999999999999999999 token owed to it. Any future function that re-adds to it (spec §7 says Deepen v1.4 will) would be bricked for good by one dust donation.
- **Fix:**
  - Enable `beforeDonate` and always revert (flags go from 0x28CC to 0x28EC).
  - Give every bid a fresh position with `salt = bytes32(++bidNonce[token])`.
  - Defensively, use `modifyLiquidity`'s `feesAccrued`: take any positive token fee and burn it, and count USDC fees into `lockHeld`.

## L1 (Low): the hook pays fees out of the PoolManager's own USDC before the trader has paid
**PoC:** `FeeFloat.t.sol`, `test_bigOpeningBuyRevertsThroughRoutersThatPayAfterTheSwap` and `test_afterTheWindowABigBuyStillNeedsFloatAboveItsFees`.

- **Cause:** `afterSwap` calls `poolManager.take` to the launchpad and to itself, but our router and the Universal Router settle after the swap.
- **Numbers:** with the PoolManager holding 24,999.99 USDC, a 30,000 USDC opening-block buy through `ArchitexV4Router` reverts with `ERC20InsufficientBalance`: the hook's 27,000 USDC snipe `take` exceeds the 24,850 left. The same swap paid in advance fills (20.47M tokens). Outside the window, at a 10% creator fee, a 239,095 USDC buy still reverts.
- **Where it bites:**
  - It can bite on a thin testnet PoolManager during the rehearsal.
  - Integrators that sync before swapping and settle after will fail.
  - It ties every swap to physical USDC transfers: if Circle blocklists the launchpad, every v1.4 pool freezes, sells included; if it blocklists the hook, no curve can graduate.
- **Fix:** in `afterSwap`, record fees as ERC-6909 claims with `poolManager.mint(address(this), usdcId, amount)` instead of `take`. Add a permissionless `sweep(token)` that burns the claims, takes the USDC and calls `accrueTradeFees` / credits `lockHeld`.

## L2 (Low): pushing the price down just before `lock()` parks the bid far below half the graduation price
**PoC:** `BidPlacement.t.sol`, `test_pushThenLockParksTheBidFarBelowHalfTheGraduationPrice`.

- **The attack:** sell a 300M-token bag, call `lock()`, buy the bag back. This needs real tokens between the two unlocks.
- **Numbers:** cost 154.39 USDC. The bid's top lands 25,200 ticks below graduation (8.0% of the graduation price) instead of about 7,000 ticks (≈49.7%), with 4,500 USDC locked there.
- **Impact:** no profit for the attacker, since the bid sits under the market. It is griefing of the buy support.
- **Fix:** anchor the bid to the graduation tick only. If the current tick is at or past that edge, return and keep the USDC held until the price recovers.

## Informational
- **Open-pool tick cap:** `LockDoSExtras.t.sol`, `test_openPoolTickCapBlocksLock`. Every bid shares its far tick (-887200 or 887200) with the full-range position. Parking 20,966,766 USDC in a narrow USDC-only position there makes `lock()` revert with `TickLiquidityOverflow` until it is removed. Expensive, but the USDC is only parked, not spent. Moving the bid's far edge off the min/max usable tick avoids it.
- **Sniper refunds:** `SniperRefund.t.sol`. A creation-block curve sniper who holds through graduation and then dumps gets part of his own surcharge back from the bid: 0 bps at 5k USDC, 474 bps at 20k, 1,370 bps at 100k. That answers the spec's "is half enough?" with numbers.
- **Unbounded creator exemption:** `LaunchTxGraduation.t.sol`. The creator can take all 800M tokens surcharge-free for 25,125.63 USDC and graduate in the launch transaction. This is the spec's [proposed] exemption working as written.
- **Approval-free sell:** the router can move any holder's tokens without approval (a v1.3 design carried over). Any contract that relays arbitrary calls to non-token targets can be drained with `router.sell`.
- **No graduation inside an unlock:** a graduating buy, and `lock()`, revert with `AlreadyUnlocked` if called from inside a v4 unlock.
- **Dust split:** the snipe share can sit up to 2 units under its rate, because platform and creator round up first. The total fee is exact.

## What holds
- **Fees:** `FeeFuzz.t.sol` ran 3,000 runs per sort order across all four swap types, creator fees 0 to 10% and window blocks 0 to 25. In every run USDC was conserved and each fee was at least its rate on gross. Sells never paid the surcharge, the launchpad's books equalled its USDC, and the hook's USDC equalled `lockHeld`. Round trips never profit.
- **Rest of the fee path:** the `PartialFill` guard is exact, nothing can swap while skipping the hook, and no route evades the snipe fee.
- **Graduation:** `GraduationArb.t.sol`. The pool opens at the curve's price to about 1e-9. Buying the last X curve tokens and dumping them into the pool loses 1.40, 75.90, 844.93 and 3,517.17 USDC for 1M, 20M, 100M and 400M tokens. I found no way to make graduation revert, and nobody else can initialize the pool.
- **Invariants:** `V14Invariant.t.sol`, 25,600 random calls mixing curve trades, all swap types, `lock()`, donations, outside LPs and fee collection. The books stayed exact, the hook's USDC equalled `lockHeld`, the full-range position never shrank, and the closed pool refused every outside add.
- **Arc and licensing:** I found no native/ERC-20 USDC double count, since `settle` with value reverts while the ERC-20 is synced. No BUSL file compiles into the hook, launchpad, router or token.

## Spec errors
- **§3:** there is no `beforeRemoveLiquidity`. Closed pools accept liquidity only from the hook itself, not "the launchpad and listed liquidity plugins"; no plugin path exists.
- **§5:**
  - Pushing the price before a lock does move the bid, downward (L2), and `lock()` can be frozen (M1).
  - The fee cap is "at most 99%", not "under".
  - The no-refund claim holds only at window close, not after graduation.
- **§4:** the launchpad does not record the PoolKey; the hook derives it.
- **§7:**
  - Deepen v1.4 needs a hook entry point and must use fresh positions (M1).
  - `pairOf()` now returns the shared PoolManager, so no plugin may treat it as a per-token pool: `balanceOf(pairOf)` is all of Uniswap's USDC on Arc.
