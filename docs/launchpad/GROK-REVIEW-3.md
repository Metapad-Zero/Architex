# Grok Build red-team review #3 — launchpad v1.3 (2026-09-21)

Read-only pass over `git diff main..v13` at 1516533 plus the in-progress holder drip, against V13-SPEC.md.
Verdict: testnet yes; mainnet after finding 1.

**What was done about it** (details in V13-SPEC.md §9 and the commits after c508af3):
1. High, holder-stream snipe: fixed by moving the stream into LaunchToken with continuous per-second accrual
   (a buy, claim and sell in one transaction earns exactly 0; the stream pauses while nobody holds) — d749421.
2. Low, Combo remainder to the last entry: accepted (at most entries − 1 units per collection), §9.
3. Low, curve buy/sell without a deadline: fixed, both take a deadline and revert Expired — 21e33e9.
4. Low, tokens sent to a plugin strand their dividends: accepted and documented, §9.

---

## Findings

### 1. High — A one-token buy takes a matured holder-fee stream

`contracts/plugins/launch/HolderDistributionPlugin.sol:158` (`_releasable`), `:100` (`dripAndClaim`), and `contracts/launchpad/LaunchToken.sol:106` (`isExcluded`), `:116` (`eligibleSupply`), `:124` (`distribute`).

Not accepted by §9. It contradicts D21. The plugin tests encode the outcome (`test_noEligibleSupply_holdsAndReleasesOnceThereAreHolders`, `test_drip_longAfterTheEndReleasesEverythingAtOnce`).

The curve inventory and the launch pair are excluded from dividends, so a normal "everyone sold" state is `eligibleSupply() == 0`. While that is true, `drip` pays nothing and does not move `lastDrip`, so the clock runs. Once `block.timestamp >= streamEnd`, the next `drip` pays the entire `unreleased` balance to whoever holds at that moment. `distribute` uses the balances inside the call. `dripAndClaim` drips and pays the caller in the same call.

**Empty eligible set.** Creator fee is 10%. Traders have generated 10,000 USDC of creator fees, someone has collected them, and 24 hours have passed. Every holder has sold back to the curve or the launch pool, so `eligibleSupply()` is 0 and `unreleased` is still 10,000 USDC.

1. Buy exactly 1 token (`1e18` wei). At the opening pool (25,000 USDC × 200,000,000 tokens, 10% creator fee) that buy costs **142** raw USDC units. At the start of the curve it costs **10** raw units.
2. In the same transaction, call `dripAndClaim(token)`. Eligible supply is now one token, so the whole 10,000 USDC is distributed to the buyer and claimed.
3. Sell the 1 token. The pool round trip loses **31** raw units (0.000031 USDC).

The buyer keeps about **10,000 USDC**. Nothing in that transaction is a same-block collection of new fees: D21 only stops the deposit block. This is the later catch-up.

**Against a real holder.** Alice is the only eligible holder, with 10,000,000 tokens, and 1,000 USDC has matured. The bot buys 5,000,000 tokens from the pool (gross **716.23 USDC** at a 10% creator fee), calls `dripAndClaim`, and sells. Share of the pot is one third, **333.33 USDC**. Trading loss is **142.51 USDC**. Net is **+190.82 USDC**, with no inventory left. At a 0% creator fee the same trade nets about **+327 USDC**.

Token A's stream cannot pay token B's holders. The loss is that token's creator-fee pot.

**Fix.** Three changes, all small:

- In `LaunchToken`, checkpoint balances and allocate `distribute` from the previous block's balances, so the buying transaction earns nothing.
- While `eligibleSupply()` is 0, advance `lastDrip` to now and push `streamEnd` out by the paused time. An empty period must not become `due = unreleased`.
- Cap one `drip` at a single block of the linear rate (`unreleased * blockTime / window`). A 24-hour gap is paid forward, not in one call.

A sole holder who actually holds for the window still receives the fees. A bot can no longer take the backlog in one transaction.

### 2. Low — Combo gives rounding dust to the last entry

`contracts/plugins/launch/ComboPlugin.sol:154` (`_split`).

Not in §9.

Each non-final entry gets `amount * bps / 10000` floored. The last entry gets whatever is left. For a 50/50 combo and `amount = 3` raw units, the first entry gets 1 and the last gets 2. For `amount = 1`, the first gets 0 and the last gets 1. A run of tiny collections (small trades, or a 1% fee on dust) pays the last destination more than its basis points. The creator chooses the order, so this is mispricing, not an outside attacker.

**Fix.** Give each entry `floor(amount * bps / 10000)` and distribute the leftover one unit at a time from the largest remainder. The slices must still sum to `amount`.

### 3. Low — Curve buys and sells have no deadline

`contracts/launchpad/ArchitexLaunchpad.sol:326` (`buy`) and `:337` (`sell`). The launch router does take a deadline (`LaunchRouter.sol:90` and `:112`).

Not in §9.

A curve transaction signed with a loose `minTokensOut` or `minUsdcOut` can sit in the mempool and execute later at a moved price. Slippage still caps the damage. The pool path cannot do this.

**Fix.** Add the same `deadline` check the router uses, and revert `Expired` when `block.timestamp > deadline`.

### 4. Low — Tokens sent to a reference plugin strand their dividends

`contracts/launchpad/LaunchToken.sol:106` (`isExcluded`).

Not in §9. §9 covers USDC sent straight to a plugin, not the token itself.

The launchpad, the launch pair, `0x…dEaD`, and `address(0)` are the only excluded accounts. Split, Buyback & burn, Distribute to holders, and Combo are not. Any launch tokens transferred to those contracts earn USDC. `claimFor(plugin)` pays the plugin, not the caller. None of the four plugins credits that USDC to `unreleased`, `held`, or `totalReceived`, so it sits in the plugin forever. Buyback burns tokens it holds, which drops the balance and leaves any dividends already accrued stuck the same way.

Normal collection does not send tokens to the plugin. This is donations and mistaken `to` addresses.

**Fix.** Reject those plugin addresses in `distribute`'s earning set, or add a `recover` on each plugin that attributes unexpected USDC to the token being rescued. Excluding them in `LaunchToken` is the small change. The plugin addresses are not known at token construction, so the practical fix is: `claimFor` of a fee plugin is documented, and Buyback's `run` claims before it burns.

## Verified

Checked by reading the contracts and replaying the integer formulas. Forge was not run. The drip's weighted-average schedule was not re-derived. `cache/fuzz` and `cache/invariant` still show red Holder runs from the in-progress edit.

- **Solvency (§6.1).** Each curve buy adds `net` to `virtualUsdc` and the fees to `pendingFees` / `pendingCreatorFees`. Each sell removes `gross` from `virtualUsdc` and accrues the same fees. Graduation sends `virtualUsdc - VIRTUAL_USDC_0` and leaves the fees. A 200-step random walk at 0%, 0.5%, 1%, and 10% creator fees never dropped `virtualUsdc` below `VIRTUAL_USDC_0`. Platform fees and one token's creator fees are not another token's float.
- **Exact-fill cannot underpay the curve.** The sell-out branch is only entered when the offered net already covers `net_needed`, so `usdcSpent - net` does not underflow. Spot checks from 1 unit through 100,000 USDC at creator fees 0, 1, 50, 100, 500, 999, and 1000 found no shortfall. The platform/creator split of that fee matches the spec (`ceil` of the platform share, creator gets the rest) and stays inside the fee that was actually pulled.
- **Fees never favor the trader (§6.4).** Curve round trips at 1, 10, 100, 1,000, and 5,000 USDC (0%, 1%, 10% creator fee) all returned less than was paid. 84,148 pool round trips, including dust and skewed reserves, produced no profit.
- **Quotes use the trade path.** `quoteBuy` / `quoteSell` on the curve go through `_calcBuy` / `_sellQuote`, including `ZeroAmount` and `ExceedsSold`. The review-2 `quoteSell` hole is closed. The router quotes are the same arithmetic as `buy` and `sell`.
- **Pool trades cannot skip fees (§6.5).** `LaunchPair.swap` reverts unless `msg.sender` is the immutable router. The router takes both fees in USDC, rounds them up, transfers that sum to the launchpad, then calls `accrueTradeFees` with the same numbers. Direct `swap` cannot be used to trade. There is no flash-swap callback on the launch pair.
- **A plugin cannot stop trading or another token (§6.3).** Buys, sells, and graduation only accrue. `collectCreatorFees` is per token and non-reentrant. A reverting `onFees` rolls that collection back (D10) and does not run inside a trade. The hook bit is stored at launch from ERC-165 and is not read again.
- **Exact pull (§6.2).** The launchpad approves `amount`, calls `onFees`, and reverts unless its USDC balance fell by exactly `amount` and the allowance is 0. Combo repeats that check per slice. Reference `onFees` implementations pull `amount` from `msg.sender` and credit only that token. Two tokens on one plugin do not share `held`, `totalReceived`, or `unreleased`.
- **`onLaunch` cannot be pre-configured.** `pluginOf` is consulted after the curve is stored. An unknown token returns address 0 and is rejected. Configuration is write-once. A nested Combo is not the registered plugin, so it cannot pass `_configure` on Split, Buyback, or Holders.
- **`createToken` fee cap (D22).** `launchFee > maxLaunchFee` reverts before the pull. The first buy is internal `_buy` under the same guard.
- **Graduation.** The seed is that curve's float, not `balanceOf`. `markGraduated` happens before the transfers, and `LaunchToken` has no transfer hook, so nothing can mint on the pair in between. The pair lock blocks token transfers in until then, so a pre-graduation USDC donation cannot mint LP. Synced or not, that donation is locked into reserves whose LP is minted to `0x…dEaD`.
- **`pull`.** The launchpad may only pull into itself, the router only into `pair`, and both sell paths pass `msg.sender` as `from`.
- **Buyback cap (§6.7, §2.2).** One run per token per block, spend limited to 0.25% of virtual USDC or the pool USDC reserve, `minTokensOut` is 0 as specified. An atomic sandwich (buy, `run`, sell) at 0% and 10% creator fee, on the opening pool and on a fresh curve, lost money at every size tried. The best pool result was **−51** raw units. The cap's "sandwich loses money" claim holds for those curves. `held` is decreased by the allowance actually consumed, and a graduating buy that spends less than the offer leaves the rest.
- **Dividend solvency, aside from the snipe.** Magnified accounting with corrections preserves earned dividends across transfers and burns. Excluded accounts accrue nothing. `MIN_ELIGIBLE_SUPPLY` blocks the 1-wei recycle that would overflow `int256`. Sum of claims cannot exceed USDC actually pulled. Reaching the overflow bound still takes on the order of `2^127` raw USDC units even at the minimum eligible supply.
- **Review 2's curve-float and graduation fixes are still in this tree.** `pendingFees` is not pushed during a trade. `collectFees` is non-reentrant.

Accepted and left as specified: §9 third-party pools (fees skipped, `claimFor` plus `skim` on that pool's own dividends), open launch-pool `mint`/`burn` (D17), a broken or blocklisted plugin stranding its own fees (D10), a blocklisted Combo payee failing the whole collection, a blocklisted Split payee blocking only that payee, USDC sent straight to a plugin, custom plugin addresses (D7), and Circle blocklisting the launchpad or a pair (operational, freezes that contract's USDC, not a logic bug). USDC is assumed to be the Arc 6-decimal token: no transfer fee, no recipient hook. The in-repo router transfers the same fee numbers it accrues. `initialize` checks wiring, not bytecode, and only the deployer can call it.

## Verdict

**Arc testnet rehearsal: yes.** Curve launch, graduation, pool buys and sells, Split, Buyback & burn, and Combo can be rehearsed. Script the holder snipe as a case (sell the float down, warp past the drip, buy 1 token, `dripAndClaim`). Do not treat a green rehearsal of the happy path as evidence that Distribute to holders is safe.

**Mainnet: after finding 1 is fixed.** Curve float, pool fees, and the other three plugins do not have a principal-theft bug in this review. Distribute to holders will hand a matured pot to the first buyer until the checkpoint, the pause while nobody is eligible, and the per-block release cap are in. Findings 2–4 should be fixed or written into §9 before mainnet. Keep `feeToSetter` able to rotate a blocklisted `feeTo`, and run the suite against Arc's real USDC before the mainnet deploy. The holder fuzz and invariant cache is still red. That suite needs to be green on the final drip code. The weighted-end formula itself was not part of this review.
