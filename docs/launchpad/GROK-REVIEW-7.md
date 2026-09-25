# Grok Build red-team review #7: launchpad v1.4 (2026-09-25)

Read-only pass over branch `v14` at `a535408`: the v1.4 launchpad, the Uniswap v4 hook, the v1.4 token and the v4
router (V14-SPEC.md). Verdict: ready for an Arc Testnet rehearsal of the closed-pool path; no High.

**What was done about it:**
- Medium (a buy's fee is taken out of the PoolManager before the buyer pays in): accepted and written into V14-SPEC §9
  with its size; it can only refuse a buy of several million USDC inside the opening window, never take or skip a fee.
- Low (an open pool's bid can be held off by filling the extreme tick): accepted into V14-SPEC §9; the USDC stays in
  `lockHeld`, closed pools are immune.
- Low (the router assumed a swap consumes its whole input): fixed. The router now pays exactly what the swap consumed
  and takes what it gave.
- The five spec corrections: all made (no remove callback; closed pools take liquidity only from the hook; USDC is the
  ERC-20; the snipe fee moves the reserve path, not the curve's parameters; quotes are the router's own simulation).

---

I'll review the v1.4 launchpad against the spec and the contracts, then try to break fee accounting, graduation, and the snipe lock with an exact-integer model. No files will be changed.v1.4 is ready for an Arc Testnet rehearsal of the closed-pool path. No High is open. One Medium should be fixed or explicitly accepted before mainnet: a buy whose USDC fee is larger than the PoolManager's current USDC balance reverts.

I read `V14-SPEC.md` and the five contracts, traced Uniswap v4's swap, delta, and `sync`/`settle` path against the Arc PoolManager, and ran an exact-integer model of the curve, the fee split, and the bid. `FOUNDRY_PROFILE=v14 forge test` passed all 34 unit tests, both USDC sort orders, against the etched Arc PoolManager. The invariant fuzz was not re-run.

The model did not find a trade that leaves an attacker ahead after fees, or an honest user short of tokens or USDC.

- One-shot graduation seeds **24,999,999,968** USDC. Across 5,000 random buy/sell paths the curve's final spot and the pool's reserve ratio differ by about **10⁻⁹** relative, roughly 10⁻⁵ of a basis point. Sqrt-price rounding is far smaller than one tick.
- On 10 million fee samples the platform fee is never under `ceil(gross × 50 / 10,000)`. The creator fee on the exact-out split is at most **1 wei** under its own ceil, which is v1.3's "platform first, remainder next" rule. The exact-fill cap never bound and never underflowed in 20,000 sequences.
- A locked bid is always strictly below the lower of the current price and the graduation price. Tick-spacing rounding moves it further down, by up to 199 ticks. Pumping before `lock` cannot drag it up into a sell.

## Findings

**Medium — fee `take` runs before the trader pays.** `_collect` calls `poolManager.take` inside `afterSwap`, which transfers USDC out of the PoolManager immediately. The buyer settles only after `swap` returns. If the fee is larger than the PoolManager's USDC balance, the transfer reverts and the buy reverts with it. Nothing is stolen, and the fee is not skipped. During the opening block the fee is up to 99% of the buy, so a buy larger than the PoolManager's entire USDC balance cannot land. Sells are fine: that USDC is already in the pool. Aggregators settle after the swap, so they hit the same revert. Fix: `mint` ERC-6909 claims in the hook instead of `take`, and redeem them in a later call once the surplus is sitting in the PoolManager. On rehearsal, try one buy during the opening block larger than the PoolManager's USDC balance and expect this revert.

**Low — an open pool's `lock` can be blocked by filling the extreme tick.** The bid runs to `minUsableTick` or `maxUsableTick`, the same tick the full-range position uses. `liquidityGross` on that tick caps at `type(uint128).max / 8874` ≈ 3.83×10³⁴. A position one spacing wide at that extreme reaches the cap with **20,966,767 USDC**, and that USDC comes back out on removal because the LP fee is 0 and the range is nowhere near the price. Sandwiching `lock` with that add makes `modifyLiquidity` revert; `lockHeld` stays put, so the USDC is not lost, but it never becomes a bid. Closed pools reject the add. Fix: if the extreme spacing cannot be added, lock the rest of the range on the neighbouring ticks. Saturating a tick near the half-price boundary costs on the order of 10¹⁸ USDC.

**Low — the router's exact-in path assumes the whole input is consumed.** `ArchitexV4Router` always pulls `amountIn` and takes the output delta. A swap that stops at `MIN_SQRT_PRICE + 1` or `MAX_SQRT_PRICE - 1` leaves a token credit, and `unlock` reverts `CurrencyNotSettled`. The sender loses nothing. With a full-range pool, reaching that limit takes more tokens than the curve ever sold. Fix: settle and pull the consumed amount from the delta, and return any surplus.

## Spec corrections

- §3 says `beforeRemoveLiquidity` gates closed pools. The permission is off (`0x28CC` has no remove bit). Removal is safe because v4 keys positions by `msg.sender`, and the hook never removes its own. The callback is not what enforces it.
- §3 and §6 say a closed pool accepts listed liquidity plugins. `beforeAddLiquidity` allows only the hook. That matches §11, where Deepen pool v1.4 is still unbuilt.
- §3 still marks the USDC currency as research. §2 and the code have chosen the 6-decimal ERC-20 at `0x3600…0000`.
- §5 says the snipe fee never changes the curve. It is deducted before `net` is added to `virtualUsdc`, so a buy inside the window moves the price less than the same gross buy after it. The curve parameters stay identical. The reserve path does not.
- §8's quotes are described as the v4 Quoter. The shipped router simulates its own swap and reverts `Quote(uint256)`. That simulation includes the hook fees.

Arc's block time matches the spec: about 500 ms, two blocks per one-second timestamp, so 20 blocks is about 10 seconds.

## Checked, and the attacker does not win

Fees on all four shapes (exact-in and exact-out, buy and sell) land on the USDC side in both sort orders, rounded up, with the snipe only on buys. `PartialFill` fires only when the fee was fixed on the trader's own USDC and the pool did not fill it. A full fill still matches with a protocol fee on, because that fee is part of the input and the specified output stays exact. The hook cannot be skipped: `beforeInitialize` reverts for every caller except the hook, and v4 skips callbacks only when the hook itself is the caller. The hook never swaps. Both deltas are settled: `take` debits the hook, the returned delta credits it the same amount.

Graduation is atomic. The price is taken from the amounts, not from balances, so a donation cannot move it. Leftover tokens are burned. Leftover USDC joins the bid. Another v4 pool can be initialised before graduation and cannot be funded until `markGraduated`, which happens in the same transaction as the seed, with no transfer callback in between.

`lockHeld` is increased only by snipe taken and by USDC the full-range position did not use, and decreased only by what the bid actually took. The hook's USDC balance equals the sum of `lockHeld` unless someone donates. The launchpad's USDC equals `pendingFees + pendingCreatorFees + pendingSnipe + live curve floats` on the same terms. Dividends exclude the launchpad, the PoolManager, the hook, `0x…dEaD`, and address(0). The PoolManager exclusion is what stops pool inventory from earning.

The router pulls sell tokens only from its own `msg.sender`, and only to the PoolManager. Quotes roll back with the `unlock`. A second `unlock` reverts `AlreadyUnlocked`. `sync`, ERC-20 transfer, `settle` with no `msg.value` is the right sequence on Arc: an unsynced `settle` would be read as 18-decimal native USDC, and the code does not do that. Gas is paid by the transaction origin, so it does not move the PoolManager balance between `sync` and `settle`.

The hook's compilation unit does not include `PoolManager`, `Pool`, `Position`, `Lock`, `NonzeroDeltaCount`, `CurrencyReserves`, or `CurrencyDelta`. Every v4-core file it does compile is MIT. `PoolState.getSlot0` matches `StateLibrary`'s slot 6 layout without importing it.
