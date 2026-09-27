# Grok Build red-team review #6: the Deepen pool cap fix (2026-09-23)

Read-only pass over commit `25dcb73`, which takes Deepen pool's pool cap from the locked part of the pool's USDC
reserve (the share owned by LP at `0x…dEaD`) to close H1. Verdict: safe to deploy.

**What was done about it:**
- The Low (a Combo holding Deepen pool and live Buyback & burn v1): the same finding as the round-6 Claude review.
  Written into V13-SPEC §9; the builder refuses the pairing, and v1 is paused for new launches. An on-chain guard was
  left out (it could only know v1's address).
- The informational (the cap rises by at most 0.25% of a push plus one unit): the wording in V13-SPEC §2.3 and the
  plugin's natspec now says so.

---

Deepen pool at `25dcb73` is safe to deploy. The locked-reserve cap closes the one-transaction drain. One Low remains, and only when the token also runs live Buyback & burn v1.

The model is the pair, the router’s ceil fees, and the plugin, in integers. It reproduces the three pinned Foundry results (`-12,633,350`, `-9,866,538`, `+33,727,796`) and the published headline to the unit.

## Findings

**Low — a Combo with live Buyback & burn v1 still skims one post-push Deepen cap in the same transaction.**

v1’s cap is still the whole USDC reserve, so push, park, run, unpark, sell still drains a v1 pot. Deepen’s cap stays on the locked part, but that push has already been paid for by v1, and the attacker is the LP, so Deepen’s spend at the pushed price is extra profit.

On a fresh pool (24,999.999968 USDC seeded), c = 0, 200,000 USDC in each pot, bag parked, push sized so v1’s cap covers its pot:

| Deepen `burnBps` | v1 alone | Both | Extra from Deepen | Deepen spent |
| --- | ---: | ---: | ---: | ---: |
| 0 | +184,993.49 | +188,457.72 | +3,464.23 | ~3,544 |
| 5,000 | +184,993.49 | +188,488.22 | +3,494.72 | ~3,544 |
| 10,000 | +184,993.49 | +188,518.69 | +3,525.20 | ~3,544 |

The same push with nothing parked loses about 10,428 on v1 alone and still loses with Deepen added. Deepen’s 200,000 pot is not taken. The extra is one locked cap of the pushed pool.

Fix: refuse the deployed Buyback & burn v1 address as a Combo entry at `createToken` (the UI pause does not stop a pasted address). No change to `_capBase` is required for Deepen on its own.

**Informational — “a push of `b` raises the cap by at most 0.25% of `b`” is short by at most 1 USDC unit.**

Across 20,037 pushes the locked cap rose by at most `floor(b × 25 / 10,000) + 1`. The worst is `b = 33`, c = 0: the cap rises by 1 unit and `floor(0.25% × 33) = 0`. A synced donation of 123,456,789 units raises it by 308,642 against `floor(0.25% × D) = 308,641`. Dust pushes from 1 to 100,000 units, c = 0, burn shares 0 / 5,000 / 10,000, parked and not, bottom out at **−2 units**.

Fix: say the rise is at most `floor(b × 25 / 10,000) + 1` unit. The round trip still pays the 0.5% platform fee both ways.

## What was tried, and the numbers

The headline push is 1,410,369.10 USDC into the 1% pool, then park, run at `burnBps` 5,000, unpark, sell:

- Fixed plugin: **−38,543.03 USDC**, spending 3,535.53 (the post-push locked cap). The doc’s 38,543 is that figure.
- Old whole-reserve cap: **+153,178.84** (doc: +153,179), spending the 200,000 pot.
- Live v1 on that same trade: **+154,893.38** (doc: +154,893).

The closest one-transaction result for Deepen alone, over fresh, shrunk (600M and 750M of the float sold back), and grown pools, burn shares 0 / 5,000 / 10,000, creator fees 0 / 1% / 10%, pushes from 1 unit to about 5.6 billion USDC, full and partial parks, synced and unsynced USDC donations, unbalanced extra USDC, and LP gifted to `0x…dEaD`, is **−0.005039 USDC** (1 USDC push, parked, pure burn, c = 0). Doing nothing is 0. A flash-borrowed external bag parked across one run loses at least 0.001938. Two hundred free mint/burn cycles increase the locked USDC by exactly the dust the attacker does not get back (200 units when dead owns the pool), and `200 × 25 / 10,000 = 0` of cap.

`previewRun`’s offer is the pre-sync locked cap. With 50,000 USDC sitting in the pair unsynced, the offer stayed 62,499,999 units and the run spent 62,499,996 after `sync`, inside the documented 4-unit remainder. The curve branch of `_capBase` and `_buyOnCurve` are unchanged by `25dcb73`. A curve push-run-sell loses at least 0.005045 USDC.

`_capBase` cannot revert on a pool this launchpad can graduate. Before graduation it returns `virtualUsdc` and does not divide. After graduation, dead holds the whole first mint (`sqrt(200,000,000e18 × 24,999,999,968) = 2,236,067,976,068,706,190`), including `MINIMUM_LIQUIDITY`, and that balance cannot move, so `totalSupply` stays non-zero. `Math.mulDiv` reverts only on a zero denominator or when the result does not fit in 256 bits. The reserve is a `uint112`, and dead’s balance is at most the supply, so `floor(reserve × dead / 2^256)` is below `supply / 2^144`.

Holding versus parking for a full cap every hour reaches profit on the same hour for every cell checked. A 1-second schedule and a 10-second schedule differ by about a second. On a 1 USDC position (the worst case; larger positions are worse once `burnBps > 0`), every published cell in the §2.3 table matches a run every 10 seconds within 0.05 hour. The largest gap is burn 10,000 at a 5% creator fee: profit starts at 22.95 h against a printed 23.0 h, and the profit at that instant is 12 units. Shrinking the pool to a quarter, or growing it with 30 deepen runs, leaves the c = 0 crossover where the table puts it (3.022 h, 1.689 h, and 1.019 h at burn shares 0, 5,000, and 10,000).

Separate tokens do not share a pot or a pair. `collectCreatorFees` only fills `held` up to the locked cap. A same-transaction claim on Distribute to holders accrues over a zero time delta, so it adds nothing to a Deepen sandwich.

Deepen pool at `25dcb73` is safe to deploy to mainnet.
