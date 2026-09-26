# Claude review #9: launchpad v1.4 with snipe fees placed inside the buy (2026-09-25)

Independent adversarial pass (a separate Claude session, read-only, Foundry PoCs in its own worktree
`.claude/worktrees/v14-review3`, 39 tests in `contracts-v14/test/review9`) over branch `v14` at `6a49fea`: option A,
each window buy's snipe fee placed as a bid inside that buy. Verdict: no High, no Medium; one Low (a sniper who splits
a window buy gets part of his surcharge back), three informational notes, eight spec and NatSpec errors.

**What was done about it:**
- **L1 (chunked refund): fixed in two steps.** First (`82d410d`) with the reviewer's own change: a window buy's bid
  started from the cheaper of the price just before the buy and the graduation price. Porting the PoCs, the reviewer
  found that cap partial: after a dump under half the graduation price inside the window, chunks lifting the price
  back placed bids at up to half the graduation price, above the crashed market (22% to 34% of the surcharge back
  after a dump to about 6% of graduation; a front-run then took up to 2,669 of a 4,500 USDC bid). Now every window bid
  starts from the lowest price any window buy has started from (the pool's `bidRefTick`, the graduation price to begin
  with), which only ever moves down: a chunked sniper gets back no more than one buy does, at graduation and after any
  crash, and bids still follow a crash down. The trade-off: a hard dump inside the window with a buy after it lowers
  every later window bid (deeper under the market, never above it). The invariant run checks that every bid starts
  from the reference, that the reference never rises, and that no bid starts above half the graduation price.
- **I1 (sandwiching the buy that places a bid): closed by the same rule** (a front-run cannot lift the reference, so
  the back-run takes nothing from the bid, before or after a crash); the site never sends a buy without a minimum out.
- **I2 (griefing is cheap late in the window) and I3 (gas, bid ticks): accepted**, written into V14-SPEC §5 and §10
  with the measured numbers; Deepen pool v1.4's cap must be a running total, never a loop over bids.
- **Spec and NatSpec errors: all corrected** (§5's sandwich, griefing, pump and gas claims, F-1, the status line, §11,
  and the interface's `graduationTick`, graduation-bid and `bidCount` notes). V14-REHEARSAL.md's lock prose is fixed on
  its branch.
- The PoCs become regression tests in `contracts-v14/test/review9`, turned to assert the fix where they proved L1/I1.

---

**Verdict:** No High and no Medium. The transient tick, the bid placed inside the swap and the claims books all hold under PoC. There is one Low: a sniper who splits his window buy gets up to three quarters of his own surcharge back, which contradicts §5's F-1 claim. There are also three Informationals and eight spec or NatSpec errors.

**Where:** the PoCs are in `/Users/angusdurrie/Development/arc-dex/.claude/worktrees/v14-review3/contracts-v14/test/review9/`. The folder is untracked; nothing else was touched and nothing was committed. `FOUNDRY_PROFILE=v14 ~/.foundry/bin/forge test` now runs 150 tests, all passing: the 111 existing ones plus 39 new ones, each run with USDC at both sort positions.

## High
None.

## Medium
None.

## Low

**L1: splitting a window buy gets back part of the buyer's own surcharge.**
- **PoC:** `ChunkedRefund.t.sol`, tests `test_aChunkedSniperGetsPartOfHisSurchargeBack` and `test_aMillionInFiftyChunks`.
- **Cause:** each buy's bid is placed from half the price just before that buy.
  - When one buyer's own buys lift the price more than 2x, his later bids sit above where his dump ends.
  - The dump, one block after the window, sells into them.
- **Numbers:** share of the surcharge back with 50 buys instead of 1, all in one transaction:

| Total bought (USDC) | Block 10 | Block 15 | Block 19 |
|---|---|---|---|
| 20,000 | 0% | 0.1% | 0.6% |
| 50,000 | 1.9% | 5.3% | 8.9% |
| 100,000 | 8.4% | 16.3% | 23.2% |
| 250,000 | 24.0% | 37.1% | 46.9% |
| 1,000,000 | 53.0% | 67.1% | 75.9% |

  - 1,000,000 at block 5: 33.0%.
  - In USDC, 1,000,000 at block 10 gets 238,626 more back (780,900 against 542,274).
  - The sniper still loses on the round trip. What he recovers is surcharge that §5 promises stays as liquidity.
  - Review #7 measured 4.7% to 13.7% for curve snipers. These figures are in Argus's F-1 range (27% to 90%), but only for snipes several times the pool's 25,000 USDC.
  - A crowded window works the same way: independent buyers' bids stack at rising prices, and the first dump after the window takes them.
- **Fix, if F-1 must hold:** place a window buy's bid from the cheaper of the pre-buy price and the graduation price.
  - In `_afterSwap`: `_placeBid(l, key, _cheaperOf(l, _tickBeforeBuy, l.graduationTick))`, where `_cheaperOf` takes the higher tick when USDC is currency0 and the lower one otherwise.
  - A test-only copy with this change (7 lines of diff) is `CappedLaunchHook.sol`, checked in `CappedFixCheck.t.sol`:
    - the refund is gone (945,249 back with 1 buy or 50);
    - the front-run in I1 takes nothing from the bid;
    - bids still follow a crash down, and nothing waits;
    - the core invariant run passes.
  - Of the existing tests, only `LaunchpadV14.t.sol::test_eachWindowBuyPlacesItsOwnBidFromThePriceBeforeIt` changes result, by design.
  - **Trade-off:** above graduation, bids stay at half the graduation price instead of following the price up.
- **Otherwise:** keep option A and correct §5 with these numbers.

## Informational

**I1: the buy that places a bid can be sandwiched, but only victims with almost no slippage limit are exposed.**
- **PoC:** `WindowHarvest.t.sol`:
  - `test_theSlippageAVictimMustAcceptForHisBidToBeTaken`
  - `test_frontRunningALargeLateWindowBuy`
  - `test_frontRunWithAChunkedPump`
  - `test_aPumpAndDumpAloneLosesAtEveryBlockOfTheWindow`
- **Threshold:** at block 19, a back-run reaches the victim's bid only if the victim accepts 36% to 43% of his quoted tokens.
  - That holds for victims of 5,000 to 100,000 USDC.
  - The pumps needed are 15,014 to 30,438 USDC.
- **A 100,000 USDC victim with no minimum out, at block 19:**
  - pumps of 50k, 100k and 200k take 1,675, 3,014 and 3,746 of his 4,500 bid (its loss at the final price: 617, 1,999 and 3,088);
  - a 400k pump split into 50 buys takes 4,095;
  - the attacker's best result is +89,383, which is less than the same trades make after the window (+95,568). This held in every configuration: the pump's own surcharge costs more than the bid gives back.
- **An attacker alone:** 50,000 USDC in comes back as:

| Block | 0 | 5 | 10 | 15 | 18 | 19 |
|---|---|---|---|---|---|---|
| Back (USDC) | 4,726 | 15,938 | 27,358 | 38,593 | 45,179 | 47,347 |

  Always a loss.
- **Fix:** none needed. L1's cap makes this 0. The site should never send `minTokensOut = 0`.

**I2: the surcharge deters griefing only early in the window.**
- **PoC:** `GriefAcrossWindowEnd.t.sol`, test `test_undoingAPushLateInTheWindowNeedNotPayTheSurcharge`.
- **Scenario:** a 100M-token push down before carol's 5,000 USDC buy, then bought back. It costs:
  - 85,840 in the opening block;
  - 8,599 at block 19, undone inside the window;
  - 7,835 at block 19, undone at block 20, with no surcharge at all;
  - against 8,307 entirely after the window.
- Carol's bid lands at 44% of where it would have.
- The real cost is what carol gains from the lower price, so griefing never pays.
- **Fix:** none; correct the spec.

**I3: gas** (`BidGas.t.sol`, measured with storage cold).
- **Overhead per window buy:**
  - +173k to +176k gas for the pool's first bid (new ticks);
  - +93k for a bid on existing ticks;
  - the V4Quoter estimates about 301k gas for a whole window buy.
- **Distinct-tick griefing:**
  - 40 dust bids spread over distinct ticks cost the attacker about 108k gas each;
  - a later 300M-token dump costs 578,627 gas against 155,573, about 10.6k per bid crossed.
- **Position count:** 100 buys of 0.001 USDC make 100 bid positions for about 10.1M gas and 0.1 USDC. Nothing iterates over bids today. Deepen pool v1.4's cap (§7, "USDC in the hook's locked positions") must be a running total, never a loop over bids.

## What holds
- **The transient tick** (`TransientTick.t.sol`):
  - One unlock ran 10 swaps across two pools opened in the same block: exact-in and exact-out buys, sells, a partial fill stopped by a price limit, and a "sell everything". Every bid came from its own swap's pre-swap tick.
  - Dust exact-out buys whose snipe fee rounds to 0 place nothing and do not disturb the next buy.
  - **By code:** the tick is written only when the swap is a buy and the window's rate is not 0. It is read only when the snipe fee is not 0, which implies the same condition in the same block.
  - Only the PoolManager's own swap math runs between the two callbacks. A foreign hook that nests a swap into our pool runs a complete pair of our callbacks.
  - The compiled hook uses TLOAD/TSTORE through dedicated transient helpers, and nothing is ever `delete`d.
- **Delta settlement:**
  - The hook's USDC delta nets to 0 inside each swap (mint, add, burn, then the PoolManager's credit).
  - The swapper's own deltas are untouched: Uniswap's V4Router logic, through its prebuilt `MockV4Router`, handled exact-in and exact-out buys with SETTLE_ALL and TAKE_ALL.
  - The V4Quoter's exact-in and exact-out quotes, and our router's quote, equal the fill and leave no bid.
  - Pay-first integrators also work (`WindowBuyFlows.t.sol`).
- **No DoS of window buys** (`WindowBuyNeverReverts.t.sol`, 10,000 fuzz runs per sort order):
  - inputs: any creator fee, any block of the window, prior dumps of up to 700M tokens, exact-in buys from 0.001 to 5M USDC, exact-out buys with and without price limits;
  - no buy reverted; each one's bid landed on the USDC side of the price it left;
  - `BidNotOneSided`, clamping and `liquidity == 0` are unreachable at any price a pool can reach.
- **Accounting:** after every fuzzed swap, the hook's claims equal pendingPlatform + pendingCreator + lockHeld, and lockHeld is 2 or less.

## Spec errors
1. **§5, "nothing to sandwich":** false now. The bid is placed from the price just before the buy that pays it, and that buy can be sandwiched (I1).
2. **§5, "has to be undone with a buy that pays the surcharge… about 86,000":**
   - That figure is the opening block's. A push down is a sell, and can be undone after the window (I2).
   - The scenario is this commit's `review7/BidPlacement.t.sol::_griefCost`, not review #8's.
   - The hook's header NatSpec repeats the claim.
3. **§5, "50,000… came back as 4,726":** true for block 0 only. At block 19, 47,347 comes back.
4. **§5, F-1 ("not paid back out of his own surcharge"):** contradicted by L1.
5. **§5, "about 80,000 more gas":** measured +93k, and +173k for the pool's first bid.
6. **§11, "V14-REHEARSAL.md":**
   - The file is not in this tree; it lives on branch `v14-rehearsal`.
   - There, its prose still describes `lock()` steps: lines 113-117, 251, 282-285 and 323-324.
   - Its script was already updated in e7363f0.
7. **The status line at the top** says "reviewed twice"; there have now been four reviews.
8. **`IArchitexLaunchHook` NatSpec:**
   - `graduationTick` is described as "the reference for locked bids"; it is now the reference for the graduation bid only.
   - The graduation bid is described as placed "when the curve collected snipe fees"; it is also placed for leftover USDC.
   - `bidCount` counts "one per buy in the pool's snipe window"; a window buy whose snipe fee rounds to 0 places none.

§10 is accurate, and §11's new invariants hold under the fuzzing above.

## Not proven
- **Transaction ordering on Arc:** the sandwich numbers assume the attacker can place trades around the victim.
- **The real Universal Router bytecode:** I tested V4Router's logic through Uniswap's prebuilt MockV4Router instead.
- **Uniswap's routing allowlist:** whether it accepts a hook that adds a position inside afterSwap is unknown.
- **Arc's gas price and block gas limit:** the gas findings are in gas units, not USDC.
