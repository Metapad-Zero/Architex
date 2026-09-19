# Grok Build red-team review #1 — launchpad spec v1 (2026-09-19)

Read-only adversarial review of LAUNCHPAD-SPEC.md v1 and the frozen ABI. Accepted findings are folded into spec v1.1.

## Ranked findings

### 1. Critical — Graduation that uses `USDC.balanceOf(launchpad)` drains every other live curve

**Claim.** All curves share one USDC pot. “Transfer all of the curve’s real USDC” is ambiguous; `balanceOf(this)` takes every other curve’s float, over-seeds the graduating pool, and insolvency-reverts the rest.

**Attack.** Curve A has raised 8,000 USDC, curve B 4,000. A sells out. Implementation does `usdc.transfer(pair, usdc.balanceOf(address(this)))` then `pair.mint(DEAD)`. A’s pool opens with ~12,000 USDC / 200M tokens instead of ~8,000 / 200M. B’s next sell reverts (empty pot) or, if it doesn’t, later graduation of B sends 0 USDC and `sqrt(T * 0) - 1000` underflows in `ArchitexPair.mint` — B never graduates.

On Arc this is worse: native 18-dec USDC and ERC-20 6-dec USDC are **the same balance**. A forced native send (`SELFDESTRUCT` on Paris, or a payable mis-call) inflates `balanceOf` by `value / 1e12`. Mixing `address(this).balance` (18-dec) with ERC-20 amounts (6-dec) is a 10¹² error.

**Spec change.** Seed amount **must** be `uint256 usdcSeeded = uint256(curve.virtualUsdc) - VIRTUAL_USDC_0` for **that** token. Transfer exactly `POOL_SUPPLY` tokens and exactly `usdcSeeded` USDC. Never `balanceOf` on either token. Never native `address.balance`. Document Arc’s two-decimal trap in the spec, not just in `CONTRACTS-SPEC.md`.

---

### 2. Critical — `createToken` → `buy()` under OpenZeppelin `nonReentrant` bricks the anti-snipe buy

**Claim.** Spec requires a reentrancy guard on `createToken`/`buy`/`sell` **and** an in-transaction first buy. OZ `ReentrancyGuard` reverts on nested `nonReentrant`.

**Failure.** `createToken(..., initialBuyUsdc=1e6, ...)` calls `buy()`. Both are `nonReentrant`. Every creator first buy reverts. `initialBuyUsdc=0` still works, so this ships as “launches work, anti-snipe doesn’t.”

**Spec change.** Guard only the **external** entry points. `createToken` calls internal `_buy` that assumes the guard is already held. `initialBuyUsdc==0` skips `_buy` and ignores `minTokensOut` (do not hit `ZeroAmount`).

---

### 3. Critical — `launchpadPull` destination / `from` are underspecified and will mis-account the curve

**Claim.** The interface cannot steal by itself (`sell` has no `from`), but the token method is god-mode `transferFrom` without allowance. One wrong `to`/`from` sells the 200M pool reserve on the curve and makes graduation revert forever.

**Failure.** `launchpadPull` lives on `LaunchToken`. `_transfer(from, address(this), amount)` credits the **token contract**, not the launchpad. After enough sellbacks, the launchpad’s remaining balance is `POOL_SUPPLY` while `tokensSold` has decreased. Later buys pay out of the 200M reserve. The graduating `transfer(POOL_SUPPLY)` then reverts. Curve is stuck; last buy can never complete.

A `_buy`/`_sell` that passes user-supplied `from` (or `to`) would pull strangers’ tokens. Frozen `sell(token, tokensIn, minUsdcOut, to)` is safe **only if** the implementation hardcodes `from = msg.sender`.

**Spec change (implementation rules, ABI unchanged).**
- `launchpadPull` is callable only by the launchpad, only from `sell` / `_sell`.
- `_transfer(from, launchpad, amount)` where `from == launchpad.msg.sender` (the trader), never `address(this)` (the token), never `to`, never a parameter.
- `tokensIn <= balanceOf(from)` and `tokensIn <= tokensSold`.

---

### 4. Critical — Any callback between `markGraduated()` and `pair.mint(DEAD)` lets a first minter DoS or steal the seed

**Claim.** After `markGraduated()`, transfers **to** the pair are legal. `ArchitexPair.mint` is public. The pair lock does not protect the launchpad. If `feeTo` (or a token hook) runs in that window, an attacker mints first.

**Attack (DoS, atomic, capital returned on revert).** `feeTo` is a contract. Graduation order is `markGraduated` → fee transfer → move 200M + ~8,750 USDC → `mint(DEAD)`. In the fee callback:
1. Mint 1,001 wei of each token (`sqrt(1001²)-1000 = 1`, `totalSupply = 1001` with `MINIMUM_LIQUIDITY`).
2. Donate and `sync()` **> 8,750e6 × 1001 ≈ 8.76M USDC**.
3. Launchpad `mint`: `liquidity = min(T * ts / r0, S * ts / r1) = 0` → `InsufficientLiquidityMinted`. Whole buy reverts; donation reverts with it.

Repeat on every graduation attempt. Cost is 0. Same pattern with a skim in that window: balances already on the pair, `skim(attacker)` steals the seed, mint then reverts.

**Spec change.** Hard sequence, no other external calls in between:
1. Pull buyer USDC; pay `feeTo` (**before** `markGraduated`).
2. `require(pair.totalSupply() == 0)`.
3. `token.markGraduated()`.
4. `token.transfer(pair, POOL_SUPPLY)`; `usdc.transfer(pair, usdcSeeded)`.
5. `liquidityLocked = pair.mint(DEAD)`.
6. `curve.graduated = true`; emit `Graduated`.

`LaunchToken` is OZ ERC-20 (no hooks). Do not add any. Assert `totalSupply()==0` still, as defense in depth.

---

### 5. High — Exact-fill gross is always 1 USDC-wei **above** the `usdcIn` that triggers it

**Claim.** Spec says never over-charge and never leave dust. The two fee formulas disagree by 1 wei, so a “just enough” last buy either over-pulls or reverts.

**Numbers.** Full-curve exact-fill from `VIRTUAL_*_0`:

| | USDC-raw | USDC |
|---|---|---|
| `net = ceil(k / (VT0-CURVE_SUPPLY)) - VU0` | 8,749,999,991 | 8,749.999991 |
| `fee = ceil(net * 50 / 9950)` | 43,969,850 | 43.969850 |
| exact-fill gross | **8,793,969,841** | 8,793.969841 |
| min `usdcIn` whose **normal** `tokensOut ≥ remaining` | **8,793,969,840** | 8,793.969840 |

That +1 wei repeats at every remaining I sampled (1 wei, 1e18, half curve, full curve).

If `buy` `transferFrom`s exact-fill gross: allowance/balance of `usdcIn` → revert, graduation does not run. A fuzz that buys in 1-wei steps hits this on the last wei (`min usdcIn=1`, exact-fill gross=`2`) and **never sells out**. If it pulls gross without a cap, it violates the ABI (`usdcSpent` may be less than `usdcIn`, never more).

**Spec change.** `usdcSpent = min(usdcIn, net + fee)` and **always ≤ `usdcIn`**. Still set `tokensOut = remaining`. Put the 1-wei shortfall on the **fee**, not `net`. `quoteBuy` must be the same code path (including this cap and the `graduates` flag).

---

### 6. High — `tokensSold` is not specified as **net**; sells that don’t decrement it graduate early at the wrong price

**Claim.** Remaining is `CURVE_SUPPLY - tokensSold`. If sells don’t decrement `tokensSold`, a round-trip then a second buy “sells out” with ~half the USDC.

**Attack.** Buy 400M, sell 400M back, `tokensSold` still 400M, virtual reserves ≈ start. Next 400M buy hits remaining=0, graduates with ~2,187 USDC / 200M tokens. Opening price ≈ ½ of the promised 0.00004375. 400M unsold tokens sit on the launchpad forever. Pool vs curve 1e-6 check fails.

**Spec change.** `tokensSold` is net: `+= tokensOut` on buy, `-= tokensIn` on sell. `tokensIn <= tokensSold`. `virtualUsdc` never drops below `VIRTUAL_USDC_0`. Graduation only when `tokensSold == CURVE_SUPPLY` after the exact-fill buy (not a separate mcap check).

---

### 7. High — Same-tx fee transfer to `feeTo` is a kill switch for **all** curves (USDC blocklist + reverting receiver)

**Claim.** Spec: fees move to `feeTo` in the same transaction, `feeTo` never zero. Arc USDC **reverts** on blocklisted `from`/`to`. One bad `feeTo` stops every `createToken`/`buy`/`sell`/`graduation` until `feeToSetter` rotates it. If `feeToSetter` is `address(0)` or the Ledger is unreachable, that is permanent.

**Attack / failure.** Circle blocklists `feeTo`. Or `feeTo` is a contract whose `USDC.transfer` path reverts. Every trade reverts. This is not theoretical: Arc documents runtime blocklist enforcement on `0x3600…0000`.

`setFeeToSetter(0)` is allowed by the ABI. Spec only requires **nonzero** for `setFeeTo`.

**Spec change (no ABI change).** Wrap the fee transfer in `try/catch`; on failure, skip (or credit an internal `pendingFees` mapping). Trading must not depend on `feeTo`. Reject `setFeeTo` ∈ `{0, launchpad, usdc, factory}`. Either reject `setFeeToSetter(0)` or call it an irreversible renounce in NatSpec. For testnet, an EOA `feeTo` you watch is acceptable; not for mainnet.

---

### 8. High — `fee = usdcIn * 50 / 10_000` (floor) is 0 for every buy under 200 USDC-wei

**Claim.** Spec says rounding always favours the curve and 0.5% cannot be skipped. Floor fee on the **input** favours the trader vs the platform.

**Numbers.** `usdcIn < 200` ⇒ `fee = 0`. 10,000 buys of 199 wei take ~7.27e23 token wei (~727k tokens) and pay **0** fee. Not a drain of curve USDC (`net` still increases `virtualUsdc`). Round-trip still loses (sell of 1 wei after a 1-wei buy returns 0). Practical MEV of fee-evasion is gas-bound, but it falsifies the fee invariant and any indexer that assumes 50 bps.

Sells: `fee = gross * 50 / 10_000` is also 0 when `gross < 200`.

**Spec change.** `fee = ceil(usdcIn * FEE_BPS / 10_000)` **or** `require(fee > 0)` (min buy 200 wei). Keep exact-fill as `ceil(net * 50 / 9950)`. Same ceil on sell gross.

---

### 9. Medium — Donation + `sync()` cannot brick `mint`, but it **does** break the 1e-6 opening-price promise

**Claim.** Spec requires both “works if USDC was donated and `sync()`ed” and “pool price equals curve final price within 1e-6.” Those contradict.

**How `ArchitexPair.mint` actually behaves** (`_totalSupply == 0`):

```
amount0 = balance0 - reserve0;  // deltas, not balances
amount1 = balance1 - reserve1;
liquidity = sqrt(amount0 * amount1) - 1000;
_update(full balances);         // reserves include the donation
```

Donate `D` USDC and `sync()` (`reserves = (0, D)` or `(D, 0)`). Graduation transfers `T=200e6·1e18`, `S≈8.75e9`. Deltas `(T, S)` — mint **succeeds**. Final reserves `(T, S+D)`. Opening price `= (S+D)/T`.

Relative error vs 1e-6: `D / S`. **`D = 1e6` (1 USDC) ⇒ ~1.1e-4**, 100× the budget. `D = 8,750` USDC ⇒ price ~2×. Attacker’s USDC is a gift to whoever sells into the pool; it is not theft. Do **not** revert when `D > 0` — that would let an 8,750 USDC donate+sync **permanently brick** graduation (`totalSupply` still 0, but a revert-on-donation check would fire forever; synced funds cannot be `skim`med).

Router `addLiquidity` **does** revert here (`quote` → `InsufficientLiquidity` on a zero reserve). Direct `mint` is the right call. `kLast` is 0 on first mint even if `factory.feeTo != 0`; protocol-fee mint does not run. `MINIMUM_LIQUIDITY=1000` vs `sqrt(T·S)≈1.322875654851959243e18` is fine.

**Spec change.** Keep direct `mint(DEAD)`. Do not revert on donated USDC. Promise 1e-6 **only if** the pair’s USDC `balanceOf` was 0 before the two graduation transfers. Optional: `skim` **unsynced** excess to `DEAD` before transferring (synced excess cannot be skimmed).

---

### 10. Medium — Blocking only transfers **to** the USDC pair is enough to keep `pair.totalSupply()==0`; it does not block parallel markets and it does break USDC-hop router paths (intended)

**Claim.** Pre-graduation, `to == pair` is sufficient to stop first-depositor inflation. You cannot get launch tokens onto the USDC pair: user `transfer`, `transferFrom`, `buy(..., to=pair)`, and another pair’s `swap(..., to=usdcPair)` all go through `_update(from,to,value)` with `to=pair`.

It does **not** block:
- USDC donations / native-USDC force-sends onto the pair (`sync`/`skim`).
- A `token/EURC` (or any non-USDC) pair: `addLiquidity` and swaps are allowed. That is a parallel market and an arb vs the curve / vs the post-grad USDC pool. Spec explicitly allows “all other transfers.”
- Flash-borrowing donated USDC from the USDC pair if it was synced (token reserve is 0, so you cannot flash the launch token).

It **does** revert, by design:
- Router `path = [token, USDC]` and any hop that sends the launch token **to** the USDC pair.
- `addLiquidity(token, USDC)` before graduation.
- `buy(..., to=pair)`.

**Spec change.** Override OZ 5.1 `ERC20._update` (not v4 `_beforeTokenTransfer`): `if (to == pair && pair != address(0) && !graduated) revert PairLockedUntilGraduation();` Do not block `from==pair` (post-grad swaps). Do not block `to==address(0)`. Call `initPair` before any external call after token deploy; factory `createPair` is trusted. Document: no Token→USDC router trade until `graduated`; other pairs are allowed and will be arb’d.

---

### 11. Medium — Frozen ABI will mis-price the UI unless the spec writes the exact view formulas

**Claim.** `spotPrice` / `marketCap` / `progressBps` comments are not implementable without guessing scale. `Trade` does not carry `tokensSold`. `curvesPage` is unbounded.

**Formulas that match the comments at sell-out** (`vu≈11,666,666,658`, `vt=266,666,667e18`, mcap `$35,000`):

```text
spotPrice   = virtualUsdc * 1e36 / virtualTokens     // 1e18-scaled USDC-raw per whole token
                                                 // ≈ 43.75e18 at graduation
marketCap   = virtualUsdc * CURVE_SUPPLY / virtualTokens   // USDC 6-dec; ≈ 3.5e10
progressBps = tokensSold * 10_000 / CURVE_SUPPLY     // MUST multiply first; else always 0
```

`Trade.usdcAmount` is **gross paid** on buys (fee included) and **gross leaving the curve** on sells (seller receives `usdcAmount - fee`). Say that. Say virtual reserves in the event are **post-trade**.

`curvesPage(start, count)`: clamp `count` (Lens uses this pattern; frontend asks for 50). Unknown token → `UnknownToken()`, not a zero struct. `liquidityLocked` = `mint`’s return value, not `balanceOf(DEAD)` (that is +1000).

No `deadline` on `buy`/`sell`/`createToken` (ABI frozen). Defense is tight `minTokensOut` / `minUsdcOut` only. Sub-second Arc blocks can share `block.timestamp`; do not use timestamp for uniqueness.

**Spec change.** Write the three formulas in Solidity. Document Trade semantics. Clamp paging. Define `liquidityLocked`.

---

### 12. Medium — Creator same-tx buy stops same-tx snipes only; the graduating buy is not sandwichable **on the pool**, but the next block is

**Claim.** `createToken` + `_buy` is enough against `TokenCreated`-backrun in the **same** transaction. It is not enough if `initialBuyUsdc=0` (explicitly allowed). Curve buys in later txs are ordinary priority-gas sandwiches; `minTokensOut` is the only defense (no deadline).

The sell-out buy graduates and `mint`s in the same tx. Nobody can insert a pool swap in between **unless** finding 4’s callback exists. After the tx, the pool is public. Extra USDC on the pair (finding 9) is instant arb: sell tokens into a USDC-heavy pool.

**Spec change.** Keep the in-tx first buy. Frontend already explains it. Do not claim MEV protection beyond that tx. Optional: document that `initialBuyUsdc=0` is a sniper invitation.

---

### 13. Low — `name` / `symbol` / `metadataURI` are unbounded in charset (length only)

**Claim.** 1–32 / 1–10 / ≤256 **bytes**, no alphabet, no scheme whitelist. Homoglyph `USDC`, `<script>`, `javascript:`, `data:text/html`, NUL, RTL, `https://evil`. The contract should accept them (permissionless memes). The **frontend brief already treats them as attacker-controlled** (text only, `https:` images, no `dangerouslySetInnerHTML`, always show the address). Duplicate symbols are allowed.

**Spec change.** One sentence: values are untrusted bytes; uniqueness is not enforced; rendering rules live in `FRONTEND-BRIEF.md`. Optionally reject `bytes(name)[i]==0` if you want cleaner explorers. Do not try to HTML-escape on chain.

---

### 14. Info — `uint128` packing is fine; `k` fits `uint256`

`VIRTUAL_TOKENS_0 ≈ 1.067e27` is ~3e-12 of `uint128` max. `virtualUsdc` ends ~1.17e10. `tokensSold ≤ 8e26`. `k0 ≈ 3.11e36` is 122 bits. Use `SafeCast.toUint128` on every write anyway so a bad `usdcIn` reverts the tx rather than wrapping.

`receive() / fallback()` should revert so native USDC is not silently credited (it would still show up in ERC-20 `balanceOf` on Arc).

Worst-case gas (`createToken` + pair `CREATE2` + first buy that graduates + `mint`) must be measured; Arc is 30M gas/block, so this should fit, but it is the unique “two contract deploys + AMM mint” path.

---

## Must fix before testnet

1. Per-curve `usdcSeeded = virtualUsdc - VIRTUAL_USDC_0`; exact `POOL_SUPPLY`; never `balanceOf` / native balance.  
2. External `nonReentrant` only; internal `_buy` from `createToken`; skip buy when `initialBuyUsdc==0`.  
3. `launchpadPull(from=msg.sender → launchpad)`; sell-only.  
4. Graduation sequence in finding 4; `pair.totalSupply()==0`; `getPair` then `createPair` (never the reverse).  
5. `tokensSold` net; `tokensIn <= tokensSold`; `virtualUsdc >= VIRTUAL_USDC_0`.  
6. Exact-fill never pulls `> usdcIn`; `quoteBuy` ≡ `buy`.  
7. OZ 5 `_update` pair lock; `markGraduated` before the two seed transfers.  
8. `progressBps = tokensSold * 10000 / CURVE_SUPPLY`.

## Must fix before mainnet

9. Fee transfer must not be able to revert the trade (`try/catch` or internal accrual).  
10. Ceil fees or min size 200 wei.  
11. Donation+`sync` policy: never revert; 1e-6 only on a clean pair.  
12. `setFeeTo` denylist; `setFeeToSetter(0)` policy.  
13. View/event formulas (finding 11). Measure create+graduate gas.  
14. `receive() payable { revert; }`.

## Nice to have

- Clamp `curvesPage`.  
- Put `tokensSold` in `Trade` (ABI frozen: probably not).  
- Reject NUL in name/symbol.  
- NatSpec: `liquidityLocked` vs `MINIMUM_LIQUIDITY`.  
- Frontend: treat `curves().pair` as empty until `graduated`.

---

## What is actually sound (do not “fix”)

- **Direct `pair.mint(DEAD)`, not the router.** One-sided synced reserves `(0, x)` make `Router.quote` revert; mint-on-deltas does not. This is the correct Uniswap-V2 graduation.  
- **`getPair` then `createPair`.** Pre-create via CREATE2(`token0,token1`) cannot occupy the pair; factory `PairExists` is the only failure, and you skip `createPair` when it exists.  
- **Protocol fee / `kLast` on the graduating mint.** `kLast` starts 0; `_mintFee` is a no-op; `MINIMUM_LIQUIDITY` goes to `DEAD`; all seed LP goes to `DEAD`. Later protocol-fee dilution of DEAD is ordinary V2.  
- **Constants and price continuity (clean pair).** One-shot or 8,794× 1-USDC buys both end at `vu=11,666,666,658`, `vt=266,666,667e18`, raised `8,749.999991` USDC, curve vs pool relative error **~9.6e-10**. Spot ≈ `0.00004375` USDC/token, mcap on 800M ≈ `$35,000`. `8,750/200M` matches.  
- **Round-trip.** Buy 100 USDC → sell all tokens returns `99.0025` USDC (fees). 1-wei buy then sell returns 0. Repeated 1-wei sells extract 0. Ceil on `k/x` favours the curve.  
- **`uint128` / `MINIMUM_LIQUIDITY` / first-mint underflow.** Seed size is nowhere near uint128 or the `sqrt < 1000` failure (`test_mint_revertIfZeroLiquidity` only fires at 1 wei × 1 wei).  
- **Transfer-to-pair lock ⇒ `totalSupply==0` at graduation**, against any attacker who cannot run in the graduation callback. Parallel non-USDC pairs do not credit the USDC pair.  
- **`launchpadPull` is not an ABI theft primitive** — `sell` has no `from`. Theft is implementation-only (finding 3).  
- **Creator in-tx buy** does block same-tx snipes. It does not block the next tx; that is acceptable.  
- **Original MemeDEX “burn unsold + 200M, seed circulating”** was internally inconsistent (users hold circulating). Seeding **200M + raised USDC** and locking LP at `DEAD` is the coherent pump.fun-style model. Do not reintroduce the burn.

---

## Tests the implementer must add

1. **Two live curves, graduate A, sell on B.** B’s USDC still `virtualUsdc_B - VU0`. A’s pair reserves use only A’s seed. Native 1e12 wei force-send to the launchpad does not change `usdcSeeded`.  
2. **`createToken` with `initialBuyUsdc>0` and `=0`.** First buy under the same guard; `=0` does not `ZeroAmount`.  
3. **`createToken` that buys out the whole curve** (≈8,793.969841 USDC) in one tx: pair exists, LP at `DEAD`, `totalSupply>1000`, `graduated`.  
4. **Pre-created pair** (predict CREATE token address, `factory.createPair` first). Graduation succeeds.  
5. **Donate USDC + `sync()`; donate without `sync`; `skim` then graduate.** Never revert. Price 1e-6 only in the zero-donation case.  
6. **`factory.setFeeTo(nonzero)` before graduation.** First mint still works; `kLast` set after; no LP to `feeTo` on that mint.  
7. **`pair.totalSupply()==0` at start of graduation.** Cannot `mint` before `markGraduated` (token transfer to pair reverts; one-sided USDC mint underflows).  
8. **Fee-callback attacker** (`feeTo` tries `mint`/`skim`/`sync`/`buy`): must fail if you pay fees **before** `markGraduated`; add a negative test that the bad order is exploitable.  
9. **`launchpadPull`:** only launchpad; `from=trader`; tokens land on launchpad; cannot pull `from=victim`. Wrong-destination test: after sell, `balanceOf(launchpad)` increased.  
10. **Exact-fill:** `usdcIn = min trigger` (8,793,969,840 and `usdcIn=1` with 1 wei remaining) — does not revert, `usdcSpent <= usdcIn`, `tokensSold == CURVE_SUPPLY`, no dust. `quoteBuy` matches.  
11. **Net `tokensSold`:** buy 400M, sell 400M, `tokensSold==0`, `progressBps==0`, no graduation. Then sell out properly.  
12. **Round-trip + dust:** buy then sell ≤ paid; 199-wei buy fee behavior (after you ceil/min-size); 1-wei sell returns 0.  
13. **Solvency invariant (fuzz):** `USDC.balanceOf(launchpad) >= Σ(virtualUsdc - VU0)` over non-graduated curves; `k` non-decreasing on a trade; `tokensSold <= CURVE_SUPPLY`; `virtualUsdc >= VU0`.  
14. **`feeTo` reverts / is a reverting contract.** After the mainnet fix, trades still succeed. Before it, this test documents the DoS.  
15. **Pair lock:** `transfer`/`transferFrom`/`buy(to=pair)` revert until graduation; succeed after. `token/EURC` `addLiquidity` works before graduation. Router `[token, USDC]` reverts before, works after. Flash swap `to=usdcPair` from another pair reverts before.  
16. **Views:** `spotPrice`/`marketCap`/`progressBps` against the formulas above at t=0 and at sell-out (`marketCap ≈ 35_000e6`). `curvesPage` clamps. Unknown token reverts.  
17. **Gas:** `createToken` + create pair + graduating initial buy < 30M, with a published number.  
18. **Casting:** `SafeCast` on all `uint128` writes; a huge `usdcIn` reverts that tx only.

