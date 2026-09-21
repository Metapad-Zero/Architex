# Grok Build red-team review #4 — launchpad v1.3 after the review fixes (2026-09-21)

Read-only pass over `git diff 5b0a7f4 05e7abc` (the token-level dividend stream, buyback pacing, destination
checks, curve deadlines). Verdict: review #3's High is closed; mainnet after two small closures.

**What was done about it:**
- Holder-stream snipe (review #3, High): confirmed closed, with replays below.
- Combo remainder (Low): accepted and written into V13-SPEC.md §9 (at most entries − 1 raw units per collection,
  creator-chosen order).
- A future launch pair as a fee destination (Low): accepted and written into §9. Only the creator chooses a
  destination and could as easily name their own wallet, so no one else's funds move; a pay-time re-check would
  only turn "skimmed" into "stuck".
- The final Claude review found the same future-address case and two stale stream views; `streamRate()` and
  `streamEnd()` now report the stream as of now (0 when ended or paused; the moving end while paused).

---


## 1. High — one-transaction holder snipe — closed

`LaunchToken.sol:230` (`_accrue`), `:288` (`_update`), `:156` (`distribute`). The holders plugin only forwards (`HolderDistributionPlugin.sol:39`).

§3 requires this outcome. §9 does not need to accept it.

Accrual runs before balances change, and only when `block.timestamp` has moved. A buy in the checkpoint transaction is credited with a correction at the post-accrual per-share value, so that buy earns 0. While raw eligible supply is under `1e18`, nothing is added to the per-share value and `end` moves forward by the idle time, so the un-streamed balance stays on the same rate instead of becoming a lump. Arc's own rule is that sub-second blocks share one `block.timestamp`, so a second block inside the same second is the same result.

Replay of the old sequences, in raw USDC units (6 decimals), with `DRIP_PERIOD = 86400`:

**Empty eligible set.** Alice holds 1,000 tokens. `distribute(10_000_000_000)` at t = 0. At t = 1 h she sells all of them and is paid **416,666,666**. The stream still shows **9,583,333,333** undistributed (one unit is rate-floor dust: 416,666,666 + 9,583,333,333 = 9,999,999,999). At t = 25 h a bot buys 1 token (`1e18`), calls `claim`, and sells, all at that timestamp. The bot is paid **0**. Undistributed is unchanged. `streamEnd` is t + 48 h, which is the original 24 h plus the 24 h nobody held. The same bot, if it is the only holder across the next timestamp, is paid **115,740**, which is `10_000_000_000 / 86400`. That is the documented one-second rate, and it requires a new timestamp.

**Against a real holder.** Alice holds 10,000,000 tokens and 1,000 USDC (`1_000_000_000`) has been streaming. A bot buys 5,000,000 from inventory, claims, and sells at the same timestamp. The bot is paid **0**. Alice's claimable is **999,999,999**. If the bot buys at t = 100 s and holds through t = 101 s, its one-third share is **3,858** raw units for that second, and **0** in the buy transaction itself.

**Pause and resume.** A 24 USDC stream. Alice holds 6 h, sells, and 10 h pass with eligible supply 0. Bob then buys. His claim in that transaction is **0**. `streamEnd` is start + 34 h. Holding through that end pays Bob **17,999,999** of the 18 USDC that was left, and Alice nothing more.

**Transfer.** A 96 USDC stream. Alice holds alone for 6 h, then sends her whole balance to Bob. In that timestamp Bob claims **0** and Alice claims **23,999,999**. At 24 h Bob has **71,999,999** and Alice has nothing further. Total paid is 95,999,998 of 96,000,000.

**Excluded round trip.** After 1 h of a 24 USDC stream Alice's claimable is **999,999**. Sending her balance to the pair and back in the same timestamp leaves it at **999,999**. The pair, the launchpad, `0x…dEaD`, and `address(0)` claim 0.

**Graduation.** Alice holds 100 tokens through the first hour of a 24 USDC stream. The graduation transfer is launchpad to pair, both excluded, and Bob buys 10 tokens out of the pair in that same timestamp. Bob claims **0**. One hour later Bob's claimable is **90,909** and Alice's is **909,091**, which is 10/110 and 100/110 of that hour.

A second deposit cannot pull the end forward. 100 USDC at t = 0 and another 100 at 12 h ends at t + 32 h. A 1-raw-unit deposit leaves that end where it is. Depositing 1,000,000 USDC with 1 second left on the stream sets the new duration to **86,399** seconds.

## 2. Accrual review — no open defect

Rounding is down at every step: weighted end, rate, per-share accrual, and each claim. The end never moves earlier than the end already stored; a new deposit either leaves it or pushes it toward now + 24 h. On a fresh stream the end is exactly now + 86,400. Across 2,000 random steps (deposits, transfers, burns to `0x…dEaD`, claims, pauses) the sum of claimable and claimed stayed at or under `totalDistributed`. The largest gap between that sum and `undistributed()` was 4 raw units on about 5.0e13 distributed.

`eligible` moves only when a transfer crosses the excluded boundary, by exactly the amount moved. It starts at 0 with the whole supply on the launchpad, and the graduation transfer does not change it. `uint128` holds the 1e27 supply.

A transfer reverts on the per-share correction only if `perShare * amount` exceeds `int256`. With the minimum eligible supply, that bound is about **1.7e23 whole USDC** distributed per token, cumulative. All USDC in existence is about 1e11. Recycling the same USDC still counts against that cumulative total, and each pass takes the rest of the window, up to 24 h. `_accrue`'s `rate * dt` fits whenever `distribute` succeeded, because the later product is at most the sum that already fit in `uint256`.

Every accrual is a fixed read and write of one packed slot. There is no loop an attacker can lengthen. The extra gas while a stream is active is the cost §3 already states.

Arc documents second-granularity timestamps, shared by sub-second blocks, and CometBFT time is strictly increasing, so `block.timestamp` does not go backwards. A backwards step would revert the pause update and freeze transfers until time caught up. That step is not available on Arc.

## 3. Other fixes, and findings 2–4

### Low — Combo still gives the remainder to the last entry — open

`ComboPlugin.sol:154` (`_split`).

§9 does not mention it.

Non-final entries get `amount * bps / 10000` floored. The last entry gets whatever is left. A 50/50 combo and `amount = 3`: the first entry gets **1**, the last gets **2**. With `amount = 1`: the first gets **0**, the last gets **1**. One hundred collections of 1 raw unit pay the last entry **100** and the first **0**. The creator picks the order. The most extra the last entry can receive on one collection is 4 raw units (five entries). Split is unaffected: it uses cumulative `mulDiv`, so the leftover unit is not pinned to the last payee.

**Fix.** Give each entry `floor(amount * bps / 10000)`, then hand out the leftover one unit at a time from the largest remainder. The slices must still sum to `amount`.

### Low — curve deadline — closed

`ArchitexLaunchpad.sol:352` (`buy`) and `:365` (`sell`). Both revert `Expired` when `block.timestamp > deadline`. A deadline equal to the current timestamp passes. `createToken`'s first buy has no deadline, which §5 requires, because that buy runs inside the launch transaction on an empty curve. Buyback passes `block.timestamp` (`BuybackBurnPlugin.sol:97` and `:104`), so its own buy cannot expire under it. The deadline unit tests passed.

### Low — tokens sent to a plugin — accepted by §9

§9, "Launch tokens held by a plugin," now states the behavior: a plugin is an ordinary holder, `claimFor` pays the plugin, and that USDC is credited to no token. No code change. Buyback still burns the tokens it holds without claiming first; any dividends already accrued to the plugin address stay claimable to the plugin and then sit there. That is the same accepted case. A buy-and-burn inside one `run` earns 0, because both transfers share one timestamp.

### Low — the next launch pair is not a launch pair yet — open

`ArchitexLaunchpad.sol:298` (the `isLaunchPlugin` check), `:227` (plain transfer in `collectCreatorFees`), `LaunchFeePluginBase.sol:100` (`_checkRecipient`, used by Split and Combo), `LaunchPair.sol:147` (`skim`).

§9 does not accept this. §2.1 refuses launch pairs because a plain USDC transfer into one can be taken with `skim`. The check only sees pairs that already exist.

The factory uses `CREATE`. After token A's pair is deployed the factory nonce is public, so the next pair's address is `keccak256(rlp([factory, nonce]))` before anyone launches token B. Token A's creator (or a builder filling in the plugin field) sets that address as the plugin, with empty `pluginData`. It has no code, so it is not a hook target, and `isLaunchPair` is false. Collection of **10,000 USDC** (`10_000_000_000` raw) is a plain transfer to that empty address. The next `createToken` deploys the pair there. Reserves are 0, and the pre-existing USDC balance is still on the address. `skim(attacker)` sends **10_000_000_000** raw USDC to the caller. The same address passes Split and Combo's configure-time check and is paid later by `release` or Combo's transfer.

This token's own pair and its own token address are recorded before the check, so those two are refused. A malicious builder can already name their own wallet, which §2 and D7 allow, so this does not move anyone's curve float. It does defeat the skim check for the one predictable pair the registry does not know yet.

**Fix.** Re-check `isLaunchPair` at pay time, before the USDC moves: in `collectCreatorFees`, in `Split.release`, and in Combo's forward loop. A revert rolls the accounting back, so the fees stay where they were. Sweeping the pair's constructor is not enough, because later collections arrive after the pair exists.

## What holds

- **Dividends.** The six replays above, plus a 256-run fuzz of `testFuzz_oneTransactionSnipeEarnsExactlyZero` and `testFuzz_overlappingHoldersGetTimeWeightedShares`, and the unit tests for the day-long empty-set snipe and the 10 h pause. The cached fuzz failure seed `0x46640d72…` passes on this tree; those cache files are leftovers. Forge's full invariant suite was not re-run.
- **Solvency of the stream.** Claims are floored and the rate is floored, so the token keeps the dust. Excluded accounts accrue nothing. A sole holder of one token, holding for the whole window, receives the deposit minus at most a couple of raw units.
- **Buyback pacing.** `_budget` is `cap * min(now − lastRunAt, 1 h) / 1 h`, or a full cap when `lastRunAt` is 0. One run per block. The next block in the same second has a budget of 0 (`test_nextBlockInTheSameSecondHasNothingToBuy` passed). Idle time past one hour does not stack. A sell-out run does not reset the clock: the following pool run is prorated from it against the pool reserve (that test passed). At a 10% creator fee, a buy of 2 raw units reverts `ZeroAmount` on the curve and in the pool; a buy of 3 returns tokens (that test passed). The old per-block sandwich, replayed by `test_chainAttack_reviewersExampleNowLoses`, spends **44,981,075** raw and the attacker's result is **−208,203,877** raw.
- **Destinations.** `createToken` rejects USDC, the router, the pair factory, the new token, every recorded launch pair, and every existing launch token. `DataForNonPlugin` reverts when `pluginData` is sent to an address that does not declare the interface, including in Combo. The dead address remains allowed. Those unit tests passed.
- **Curve deadline.** Present on `buy` and `sell`, absent on the in-transaction first buy, as §5 says.

## Verdict

**Arc mainnet: after two small closures, not before.** The high issue from review 3 is closed, and the curve, the pool, and the buyback pacing do not have a principal-theft bug in this pass. Before deploy, fix Combo's remainder or add it to §9, and re-check `isLaunchPair` when fees are actually sent (or name the next-pair case in §9). Deploying with those two left open leaves a creator-chosen dust bias and a skim path around the check that was just added. It does not leave the holder-fee pot snipeable.
