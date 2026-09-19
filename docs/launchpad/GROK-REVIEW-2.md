# Grok Build red-team review #2 — final Solidity, spec v1.1 (2026-09-19)

Read-only pass on the fixed contracts and tests. Verdict: safe for testnet; mainnet prerequisites listed at the end.

## OPEN issues (ranked)

### 1. Low — `quoteSell` is not the `sell` code path and will quote more USDC than the curve holds

**Claim.** Spec v1.1 requires `quoteSell` to share `sell`’s code path, including `ZeroAmount` and `tokensIn <= tokensSold`. The on-chain view skips both, so it can return a proceeds figure larger than real float.

**Scenario.** Alice buys 100 USDC (`net = 99_500_000`). Curve float is `99.5` USDC. On-chain `quoteSell(token, CURVE_SUPPLY)` returns `usdcOut = 1_310_890_981` (~1,310 USDC) and `fee = 6_587_392`. Execution of that sell panics on `tokensSold` underflow (`ArchitexLaunchpad.sol:261`). Dust is also wrong: `quoteSell(token, 1)` returns `(0, 0)` while `sell` reverts `ZeroAmount`. The TypeScript model already throws `InsufficientSold` / `ZeroAmount`; the ABI view does not.

**Change.** In `quoteSell`, after the graduated check, add the same guards `sell` uses, then return `_calcSell`’s `gross - fee`:

```solidity
if (tokensIn == 0) revert ZeroAmount();
if (tokensIn > uint256(c.tokensSold)) revert ZeroAmount(); // or a named error
(uint256 gross, uint256 fee_) = _calcSell(c.virtualUsdc, c.virtualTokens, tokensIn);
usdcOut = gross - fee_;
if (usdcOut == 0) revert ZeroAmount();
fee = fee_;
```

No other OPEN Solidity issue rose to Low-or-higher. The rest is test/ops, below.

---

## CLOSED table (Review #1 vs this tree)

| # | Review-1 finding | Status | Proof |
|---|---|---|---|
| 1 | Graduation via `balanceOf(this)` drains other curves | **CLOSED** | Seed is per-curve `virtualUsdc - VIRTUAL_USDC_0` (`ArchitexLaunchpad.sol:338–351`). No `balanceOf` / `address.balance` in accounting. Two-curve test: `ArchitexLaunchpadV11.t.sol:227–248`. |
| 2 | `createToken` → `buy()` under OZ `nonReentrant` bricks the anti-snipe buy | **CLOSED** | `createToken` is `nonReentrant` (`:170`) and calls internal `_buy` (`:212–214`). `initialBuyUsdc == 0` skips `_buy` and does not hit `ZeroAmount`. |
| 3 | `launchpadPull` destination / `from` mis-account the curve | **CLOSED** | `LaunchToken.sol:55–56` `_transfer(from, launchpad, amount)`. `sell` hardcodes `from = msg.sender` (`ArchitexLaunchpad.sol:271`). Not callable by others (`LaunchToken.sol:32–33`). |
| 4 | Callback between `markGraduated` and `pair.mint` | **CLOSED** | Fees are accrued, never pushed, so `feeTo` is not in the graduation window. Sequence is `totalSupply()==0` (`:341`) → `c.graduated = true` + `markGraduated()` (`:344–345`) → exact `POOL_SUPPLY` + `usdcSeeded` (`:348–351`) → `mint(DEAD)` (`:354`). LaunchToken is OZ ERC-20 with no hooks. Arc ERC-20 USDC does not invoke `receive`. |
| 5 | Exact-fill gross 1 wei above the triggering `usdcIn` | **CLOSED** | `_calcBuy` sets `usdcSpent = min(usdcIn, gross)` and `fee = usdcSpent - net` (`:388–393`). Pull is `usdcSpent` (`:317`). V2/V4 vectors: spent `8_793_969_841`, fee `43_969_850`, net = seed `8_749_999_991`. Independently: from start, `8_793_969_840` does **not** graduate (`tokensOut = 799_999_999_998_571_428_284_530_612`); `8_793_969_841` does. Across first-buys of 1..8799 USDC, a graduating buy never had `usdcSpent < exact-fill gross`, so the 1-wei shortfall path did not fire for these constants; the identity still holds if it ever does. `usdcSpent < net` would panic in 0.8 rather than over-credit; it is unreachable because exact-fill is only entered when `net_needed <= net_normal <= usdcIn`. |
| 6 | `tokensSold` not net | **CLOSED** | Buy `:308` `tokensSold += tokensOut`. Sell `:261` `tokensSold -= tokensIn` (underflow if `tokensIn > tokensSold`). V1→V3 test leaves `tokensSold == 0` (`ArchitexLaunchpadV11.t.sol:129`). |
| 7 | Same-tx fee transfer is a kill switch | **CLOSED** | `pendingFees += fee` on buy/sell/launch (`:179, :264, :311`). `collectFees` is a separate permissionless call (`:150–156`). Blocklisted `feeTo` test: `ArchitexLaunchpadV11.t.sol:317–346`. `setFeeTo` rejects `0` and the launchpad (`:120–121`); `setFeeToSetter(0)` is documented as irreversible renounce (`:127–129`). Original extra denylist `{usdc, factory}` was dropped in spec v1.1. |
| 8 | Floor fee is 0 under 200 wei | **CLOSED** | `fee = _divCeil(usdcIn * FEE_BPS, 10_000)` (`:375`). V5: `usdcIn=199` → `fee=1`; `usdcIn=1` → `ZeroAmount`. |
| 9 | Donation+`sync` vs 1e-6 price | **CLOSED** | Direct `pair.mint(DEAD)`, no revert on donation (`:354`). Donation tests: `ArchitexLaunchpadV11.t.sol:281–303`. 1e-6 is only claimed on a clean pair (`ArchitexLaunchpad.t.sol:491–527`). |
| 10 | Pair lock via OZ 5 `_update` | **CLOSED** | `LaunchToken.sol:62–65`. `to == pair && pair != 0 && !graduated`. `from == pair` and `to == 0` are not blocked. |
| 11 | View/event formulas | **CLOSED** | `spotPrice` `:490` `virtualUsdc * 1e36 / virtualTokens`; `marketCap` `:499`; `progressBps` `:507` multiplies first. After graduation they still answer (`:488–490`, V2 test `:147–150`). `quoteBuy`/`quoteSell` revert `CurveGraduated` (`:457, :473`). `curvesPage` clamps `count` to 100 (`:437`). `liquidityLocked` is `mint`’s return (`:354`), not `balanceOf(DEAD)`. `Trade.usdcAmount` is gross (`:313` buy / `:266` sell). Unknown token → `UnknownToken()` (`:420`). |
| 12 | Anti-snipe is same-tx only | **CLOSED** (accepted) | In-tx `_buy` kept. No extra MEV claim in the spec. |
| 13 | Unbounded charset | **CLOSED** (accepted) | Length only (`:172–174`). NatSpec says untrusted bytes (`:35–36`). |
| 14 | `uint128` / `receive` / gas | **PARTIALLY CLOSED** | Every `uint128` write uses `SafeCast.toUint128()` (`:199–200, :259–261, :306–308`). `receive`/`fallback` revert (`:111–112`). Gas test exists but only `assertLt(gasUsed, 30_000_000)` (`ArchitexLaunchpadV11.t.sol:259`) — a bound that cannot fail on a 30M block. |

---

## New-bug hunt (fix round)

**pendingFees / float / balance.** Per-trade identity is `Δbalance = ΔpendingFees + Δfloat`, and graduation removes that curve’s float by transferring exactly `usdcSeeded`. `collectFees` writes `pendingFees = 0` before the transfer (`:151–154`), so a reverting `feeTo` rolls back. With honest USDC it cannot exceed holdings or take another curve’s float. The dangerous exact-fill bug (credit uncapped fee, pull capped `usdcSpent`) is what `:393` closed.

**Sell-out brick.** `fee = usdcSpent - net` cannot underflow on this branch: entry requires `net_needed <= usdcIn - ceil(usdcIn * 50 / 10_000) <= usdcIn`. Oversized last buys pull `gross` only (V2 pulled `8_793_969_841` of a `1_000_000e6` offer).

**Free tokens / unpaid USDC.** `usdcIn=1` has `net=0` and `tokensOut=0` → `ZeroAmount`. `net_needed=0` with `remaining>0` would require `virtualTokens <= virtualTokens - remaining`. `sell` pays `gross - fee` after effects and a `msg.sender` pull. `to=address(0)` reverts in OZ ERC-20 / Arc USDC.

**Griefing `createToken`.** Pair squatting is handled (`getPair` then `createPair`, `:188–191`; real test at `ArchitexLaunchpadV11.t.sol:267–277`). Name/symbol/URI are bounded 32/10/256. `_tokens` grows without bound; `curvesPage` is clamped. With `launchFee=0` this is cheap spam, not insolvency.

**Arc-specific.** Dual decimals: accounting never reads `balanceOf` or `address.balance`. ERC-20 USDC transfer does not need `receive` (Arc: “no additional payable/receive changes”). Launchpad `receive`/`fallback` revert, so a normal native send is rejected; Paris `SELFDESTRUCT` can still force native USDC in as a donation (extra sits outside `pendingFees`, cannot be collected, cannot change `usdcSeeded`). Blocklist of `feeTo` cannot freeze trades. Blocklist of the **launchpad** or of a **pair** would freeze that contract’s USDC in/out — Circle operational risk, not a logic bug. `ArchitexPair` still has no `receive` revert; a native CALL-with-value to the pair reverts, `SELFDESTRUCT` can donate.

**Assumptions this depends on:** NativeFiatToken is not fee-on-transfer and has no recipient hook; factory is the real Architex factory.

---

## Missing / too-weak tests

Spec solvency is `balance == pendingFees + Σ(virtualUsdc - VU0)` (equality with no donations). Several tests would not catch a regression of finding 5/7:

| Test | Why it is too weak |
|---|---|
| `LaunchpadInvariantTest.invariant_solvency` (`ArchitexLaunchpad.t.sol:991–1000`) | `assertGe` and **omits `pendingFees`**. Handler never calls `collectFees`. An overstated fee that later drains float would still pass until someone collects. |
| `testFuzz_cappedSellOutNeverOverCredits` | Quotes `gross - 1` and `return`s if that does not graduate. Independent search over first-buys of 1..8700 USDC: **0 hits**. The identity it claims to lock is never executed. |
| `test_vector_V4_smallestSellOutInput` / `test_vector_V5_dust` | Quote only. Never `buy()`. A quote/buy split would still pass. |
| `test_progressBps_afterGraduation` (`ArchitexLaunchpad.t.sol:892–896`) | Asserts `tokensSold == CURVE_SUPPLY`, never calls `progressBps`. |
| `test_reentrancy_buy` | `to` receives LaunchToken (no callback). `fallback` never runs. Guard can be deleted and the test still passes. |
| `test_createToken_pairPreExists` | Does not pre-create the pair. V11’s `test_preCreatedPairDoesNotBlockLaunchOrGraduation` is the real one. |
| `_assertSolvency` | `assertGe` without `pendingFees`. |
| `test_createTokenThatBuysOutTheWholeCurve` | `assertLt(gas, 30_000_000)` and `assertGt(DEAD LP, 1000)`. Publish the actual gas; assert `liquidityLocked == pair.totalSupply() - 0` / DEAD holds all LP. |
| Round-trip fuzz | `assertLe` is correct for “never profit” but never checks the known `99.0025` vector to the unit (V11 V1→V3 does). |

**Still untested (Review-1 list + new):**

1. Equality solvency **with `collectFees` interleaved**, two-plus live curves, including a capped/oversized graduation.
2. Execute V4: `buy(8_793_969_840)` does not graduate and pulls exactly that; `buy(8_793_969_841)` does and pulls exactly that.
3. Execute V5 `buy(199)` and `buy(1)`.
4. `quoteSell(0)`, `quoteSell(1 wei)`, `quoteSell(tokensSold+1)` match `sell`’s revert (today they will fail that assertion).
5. Explicit `tokensIn > tokensSold` on `sell` (today it panics, not a custom error).
6. `SafeCast`: `usdcIn > type(uint128).max` reverts that tx only.
7. Skim unsynced donation, then graduate; 1e-6 holds. Synced donation: 1e-6 **fails** and graduation still succeeds.
8. Negative: `pair.mint` before `markGraduated` reverts (one-sided USDC underflow / pair lock).
9. Native force-send / `SELFDESTRUCT` onto the launchpad does not change `usdcSeeded` (needs Arc RPC; Anvil cannot fake dual-balance USDC).
10. Circle blocklist of the **pair** during the graduating USDC transfer (graduation reverts, other curves live).
11. `createToken` + sell-out with `launchFee > 0`, then `collectFees` — remaining balance equals `pendingFees`.
12. Flash swap `to = usdcPair` from a token/OTHER pair before graduation.
13. Gas of `createToken` + pair + graduating buy **on Arc testnet**, published number.

---

## Verdict

**Safe to deploy to Arc testnet now** — Review-1’s eight testnet must-fixes are in the Solidity, and I did not find a remaining theft or brick on the happy path.

**Before mainnet:** run the suite against `https://rpc.testnet.arc.io` (blocklist, NativeFiatToken `SafeERC20` return data, dual-decimal donations); replace `assertGe` solvency with equality including `pendingFees` and call `collectFees` in the invariant handler; execute V4/V5 rather than only quoting; fix `quoteSell` guards; keep `feeToSetter` un-renounced so a Circle-blocklisted `feeTo` can be rotated; set a non-zero `launchFee`.

