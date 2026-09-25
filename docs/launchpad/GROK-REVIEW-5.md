# Grok Build red-team review #5: Deepen pool (2026-09-22)

Read-only pass over the Deepen pool plugin at `7da9b3b` (`contracts/plugins/launch/DeepenPoolPlugin.sol`, its
interface, deploy script and V13-SPEC §2.3). Verdict at the time: deploy as is.

**What was done about it:** the verdict did not stand. An independent Claude review in the same round found a High
(H1): with the cap taken from the pool's whole USDC reserve, one transaction could push the price, park the bag as
liquidity, run, unpark and sell, taking a 200,000 USDC pot for +153,179 USDC net. This review's JIT-liquidity check
added liquidity without first pushing the price, which is why it lost. The fix (cap from the locked part of the
pool) and the round-6 reviews of it are in SECURITY.md §3c and `GROK-REVIEW-6.md`. The hold-time table below is still
right for a trader who only trades.

---

**Deploy Deepen pool to Arc mainnet as it is.** Nothing in the new plugin lets a caller take a token's USDC, stick a pot so `run` reverts forever, or get paid for front-running sooner than the hours in V13-SPEC §2.3. §9 does not need a new line.

The check below is an integer model of `LaunchRouter`'s quotes, `LaunchPair.mint`, and `DeepenPoolPlugin`'s split, buy size, add, and clock. It reproduces the branch's own published pool results to the raw unit, including the 1% / default-share cases: 50 one-second runs lose **12,633,350** on 2,000 USDC at a 0% creator fee and **52,437,890** at 1%; a run every 10 minutes loses **9,866,538** over 6 hours and makes **33,727,796** over 12 hours. Forge was not run.

## Front-running the runs

A full cap is 0.25% of the USDC reserve. With fees taken out of the buy, one cap lifts the price by about **0.25% × (1 + burnBps / 10,000)** after the fee haircut: **0.3737%** at burn share 0, **0.3706%** at 5,000 (measured on the post-buy reserve of a fresh ~25,000 USDC pool after a 2,000 USDC entry), and **0.4981%** if the whole cap burns. The cheapest round trip, a 0% creator fee, costs 1%. One run loses at every share. Fifty runs a second apart still lose, which is the case the matched vectors cover.

The shortest hold at which a 1 USDC long, with a run every 10 seconds and a pot that never runs out, first shows a positive balance:

| burnBps | c = 0 | 0.5% | 1% | 2% | 5% | 10% |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 3.025 h | 7.086 h | 11.186 h | 19.519 h | 45.578 h | 93 h (still −6,953 at 90 h, +107 at 93 h) |
| 2,500 | 2.222 h | 5.481 h | 8.781 h | 15.497 h | 36.678 h | 75.781 h |
| **5,000** | **1.689 h** | **4.408 h** | **7.167 h** | **12.794 h** | **30.633 h** | **63.911 h** |
| 7,500 | 1.306 h | 3.642 h | 6.011 h | 10.853 h | 26.261 h | 55.222 h |
| 10,000 | 1.019 h | 3.064 h | 5.142 h | 9.392 h | 22.950 h | 48.583 h |

That is the §2.3 table, to the tenth of an hour it is printed in. The first strictly positive result at the default share and a 1% fee is **8 raw units** (0.000008 USDC) at 7.167 h. At the printed 7.2 h the same 1 USDC long is ahead by **132 raw units**; a 2,000 USDC long is still behind by **1,214,734**. A 20,000 USDC long does not turn positive until **8.572 h**, and a 100,000 USDC long until **10.117 h**. Hourly full caps are slower, not faster: the same 1% default turns positive at **8 h** lumped, against **7.167 h** dripped. Each cap is small enough that lumping does not beat the drip the spec uses.

**Outside top-ups.** The table already assumes the pot never limits a run. A gift into `onFees` (`DeepenPoolPlugin.sol:134`) reaches that case and does not go past it: the offer is still `min(held, budget)`, and the budget is still one cap per hour (`:159`, `:392`). A pot filled only by the token's own creator fee spends less whenever fees arrive slower than the cap, so the hold is longer. The creator fee charged on the run's own buys does not raise the rate either. It accrues on the launchpad and, once collected, sits until a later block's prorated budget.

**Combo with Buyback & burn, both pots full** (the worst case, worse than a Combo splitting one fee stream). A 1 USDC long, default burn share, runs every 10 seconds, first goes positive at:

| c | measured | §2.3 |
| --- | --- | --- |
| 0 | 0.153 h | 0.2 h |
| 0.5% | 1.322 h | 1.3 h |
| **1%** | **2.506 h** | **2.5 h** |
| 2% | 4.928 h | 4.9 h |
| 5% | 12.631 h | 12.6 h |
| 10% | 27.111 h | 27.1 h |

At the printed 2.5 h and 1%, the balance is still **−41 raw units**. Running Buyback first or Deepen first is the same result at a 10-second grid. The fuzz bound used in the tests (90% of `2 × (0.5% + c) / (0.25% × lift) − 1`) stays a loss; the cached counterexample `(c=8, size=7.406132 USDC, hold=1,055 s, 8 runs)` loses **2,906**. §2.3 already accepts this pairing and tells the builder not to offer it. The "about 2.4×" sentence is a loose summary of that table: at 1% the cut is 7.2 h to 2.5 h, and at a 0% fee it is steeper (1.7 h to 0.15 h) because each plugin's free first cap covers most of a 1% round trip. The hours themselves are right.

A creator who also receives the creator fee is the case §2.3 already describes (a smaller `c`). On a direct Deepen pot the fee accrues back to that pot. On a Combo, the other entries receive their share of the fee on the run's buys. That share is the creator's own configuration, paid out of a gift they invited. It does not open a path for anyone else.

## Taking the pot, or freezing it

**JIT liquidity loses.** On a fresh pool (~25,000 USDC, 200M tokens), an attacker who adds `M` times the pool, lets one run spend `min(pot, the new cap)`, pulls their LP, and buys back the tokens they are short, loses in every cell tried. One example: `M=100`, burn share 5,000, unlimited pot, so the run spends the inflated cap (**6,312.50 USDC**). Flattening costs **1,072 USDC**. The same shape with the pot capped at 1,000 USDC loses **33.7 USDC**. Pure deepening and pure burning lose as well. The add is at the pool's own ratio and the new LP is minted to `0x…dEaD` (`DeepenPoolPlugin.sol:373`), so existing LPs keep the tokens and USDC they already had claim to. They only change composition as the counterparty of the buy, then have to repurchase tokens at the higher price the run left behind.

**Nothing can move the pool between the burn buy, the deepen buy, and the mint.** `LaunchRouter.buy` (`LaunchRouter.sol:86`) pulls USDC, calls `accrueTradeFees` (storage only, `ArchitexLaunchpad.sol:234`), pulls the net into the pair, and `swap`s. `swap` has no callback. `LaunchToken._update` (`LaunchToken.sol:297`) does not call out. Circle USDC does not call the recipient. The pair's lock drops between the two buys, but no other transaction can start, and no callee hands control to an attacker. The add then transfers the token and USDC and mints in the same call (`:373`). A callback that swapped between the two buys would be able to take the burn side's price move without holding; that callback is not in the deployed launchpad, router, pair, token, or USDC.

**`sync` before the reads does not let the run spend more than `previewRun` offered.** The offer is taken from `getReserves` (`:158`) and `sync` runs after that (`:323`). Every exit from `LaunchPair` (`mint`, `burn`, `swap`, `skim`, `sync`) leaves balances at or above reserves, and only the pair can move its own tokens. `sync` can only raise the reserve. The offer is therefore at most 0.25% of the pool the buys actually trade against, which is the conservative direction, and it is the same offer `previewRun` returns. An unsynced donation is folded in by that `sync` and becomes a gift to LPs. The donor pays it. `previewSplit` can disagree with the execution after such a donation; the interface says so, and `run` does not take the preview's numbers.

**The mint check matches `LaunchPair.mint` on the real pair.** Graduation mints `sqrt` to `0x…dEaD`, so `totalSupply` stays at least `MINIMUM_LIQUIDITY` (1,000) and the first-mint branch (`LaunchPair.sol:82`) never runs again. `_addAmounts` (`DeepenPoolPlugin.sol:450`) uses the same `min(amount × supply / reserve)` expression as `mint` (`LaunchPair.sol:88`), on reserves the preceding `swap` set equal to balances, and the only calls between that read and `mint` are a launch-token transfer and a USDC transfer. Across reserves from 1,000 USDC to 1e8 USDC and every burn share and creator fee tried, the USDC left unspent from one cap was **at most 4 raw units**, held for the next run, which is the figure §2.3 states. `uint112` overflow would brick `sync` and `swap` together, and it takes more USDC or tokens than exist. A donation cannot get there, and `skim` only removes a surplus above reserves.

**The dust rule does not shorten the bound on a real pool.** At a ~25,000 USDC reserve the cap is 62.5 USDC. Even a 1-second budget is about 0.017 USDC, and at the default 50% each side is still above 3 raw units, so both sides run. The all-burn flip needs the deepen side below 3 while the burn side is at least 3, which on this pool means a burn share so close to 100% that the price lift was already the buyback case. Flipping the other way (the burn side gives way, `DeepenPoolPlugin.sol:407`) lowers the price impact. One run still cannot clear a 1% round trip.

**One token cannot break another's collection.** `onFees` credits only that token and pulls exactly `amount` (`:134`). `run` spends at most that token's `held`. Buys approve the router for that offer alone and `_pulledFromOffer` (`:470`) clears whatever is left. `nonReentrant` covers `onLaunch`, `onFees`, and `run`, so a buy cannot re-enter another token's `run` and overwrite the shared router allowance. There is no callback into `collectCreatorFees` during a run, so a run does not make a collection revert. §9's D10 case stays what it was: a blocklisted plugin, or an `onFees` that reverts for its own reason. This `onFees` does not.

**The `reentrancy-balance` suppression at `DeepenPoolPlugin.sol:339` is the same pattern as the launchpad's.** The read checks that the deepen buy increased this contract's token balance by at least what the router reported. The router, the pair, and the token do not call back into the plugin, `nonReentrant` is held, and `held` is decreased only after both buys return (`:168`). Extra tokens arriving would be burned at the end of the same run, not added.

## Verdict

Deploy to Arc mainnet as is. No code change is required before that deploy.
