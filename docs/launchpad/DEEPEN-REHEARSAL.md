# Deepen pool: the Arc Testnet rehearsal

This is the last step before the owner deploys the Deepen pool plugin (V13-SPEC §2.3) to mainnet themselves. The
plugin was deployed live on Arc Testnet (chain 5042002) against the existing v1.3 rUSDC suite, and driven through real
transactions across every burn share, on the curve and in the pool, with the books checked to the unit after every
transaction. The round-5 review's H1 attack was then reproduced live and lost, matching the local `forge` result to
the unit.

It ran on 2026-09-25 from the dev burner `0x7212fA4Fe663d063A7a83dA0467d592ed3A51D46`, driven by
`scripts/deepen-rehearsal.ts` on the contracts at `bd8a8e1`. The plugin's deployed code equals the local build byte
for byte (`scripts/verify-bytecode.ts`, immutables and the metadata hash masked). Nothing already deployed changed:
the Deepen pool works against the launchpad, launch router and launch pairs exactly as they are on mainnet.

**Every check passed.** One check failed on its first attempt and was the script's expectation, not the contract; it
is described under "The two corrected checks" and was fixed and re-checked without re-sending any transaction.

| Phase | Transactions | Checks | Gas | Cost (USDC) |
| --- | ---: | ---: | ---: | ---: |
| deploy the plugin | 1 | 18 | 2,110,960 | 0.052774 |
| curve phase (4 tokens) | 29 | 276 | 15,715,942 | 0.392899 |
| pool phase (4 tokens) | 23 | 235 | 3,755,183 | 0.093880 |
| H1 attack (fresh token + Settler) | 8 | 59 | 5,738,820 | 0.143471 |
| **total** | **61** | **588** | **27,320,905** | **0.683023** |

The whole rehearsal cost 0.683023 USDC of gas, under the 1.5 USDC budget. The burner's native balance fell from
5.155897 to 4.472875 USDC, exactly the recorded gas and nothing else. rUSDC (the launchpad's test USDC) is minted
freely by the burner, so it is not part of the gas.

## Addresses

The plugin, the attacker contract and the five test tokens are new; everything else is the reused v1.3 rUSDC suite
(`deployments/arc-testnet-v13-rehearsal.json`). Recorded in `deployments/arc-testnet-deepen-rehearsal.json`.

| Contract | Address |
| --- | --- |
| **DeepenPoolPlugin** (new) | `0x47052294674cD6A4962A56a38E03B8F888FbAAeD` |
| Settler (H1 attacker, `contracts/test/review2/CapInflationSettle.t.sol`) | `0x62cd6dB5ac18CB954C1B8025ECf1C4cCe8172953` |
| ArchitexLaunchpad | `0xCEbf26B8d49963860B09851a1d27C73fd4b6DC37` |
| LaunchPairFactory | `0x171b4969F54b896EBD518eC5D857181D9766B78D` |
| LaunchRouter | `0xd4561e380219F6BFb798b52A1F9bcB8445d8CE52` |
| ComboPlugin (reused, for the Combo entry) | `0x3F6a480dBb609256A8EdF943456Afec1f565f0c8` |
| rUSDC (TestToken "Architex Rehearsal USD", 6 decimals) | `0x309297011592BA9a157204e57EB0AF2175D8ceed` |

Plugin deploy transaction: `0xfbf370d50ace5c943ce93972acda3ed37e904f57eb0b6ddfafd62835167de721`.

| Token | Setup | Address | Launch pair |
| --- | --- | --- | --- |
| DPD | default burn share (empty data, 5,000), 2% creator fee | `0x4a074Bf1CFc55ac3c77965ad342F07042bb1F7aC` | `0x8B878f9add8893231b9Af139710A4728ee3edAd2` |
| DP0 | burn share 0 (all liquidity), 1% creator fee | `0xed732Ad6950e9534F854fF12efeF71b8045fA050` | `0xacF09F0CcD98e8831EA8EDA33f729E90471cc404` |
| DPF | burn share 10,000 (all burn), 1% creator fee | `0x6a98B9C7A473377e7AD795B74057Fc025Edaee9F` | `0x430C4d870A2d992bB385Ae249Ca4628C87577036` |
| DPC | Combo of Deepen pool (burn share 2,500, forwarded as its data, 70%) and a plain wallet (30%), 2% creator fee | `0x0773622FeFADF42579099439aD25B793f03455cD` | `0x0531bA9EBe58ede00eC6334EF5Aaa0731efBf519` |
| DPT | the H1 target: default burn share, 1% creator fee, graduated, pot 200,000 rUSDC, never run before the attack | `0xF53697059050788D08965C1507CD7aaC3Bfa7982` | `0x3E5Fd073B021a72644421C5240738Ea3E89C114D` |

The Combo's plain-wallet entry `0xDCFD7eD0884EEFd17F8F4e1eb4F713B6ccB391bd` is the last 20 bytes of a hash of a
label; nobody holds a key for it, and it only ever receives fees.

## Results

Every step is a group of one or two transactions (a lazy rUSDC mint precedes some). The check count is per step; they
sum to 588.

| step | transaction(s) | gas | USDC | checks | result |
| --- | --- | ---: | ---: | ---: | --- |
| deploy:deepen | deploy DeepenPoolPlugin | 2,110,960 | 0.052774 | 18 | pass |
| approve | approve deepen | 46,266 | 0.001157 | 5 | pass |
| create:d1 | mint rUSDC + createToken DPD | 3,273,156 | 0.081829 | 11 | pass |
| buy:d1 | buy DPD (curve) | 98,470 | 0.002462 | 5 | pass |
| sell:d1 | sell DPD (curve, half) | 95,922 | 0.002398 | 4 | pass |
| collect1:d1 | collectCreatorFees DPD | 107,812 | 0.002695 | 9 | pass |
| run1:d1 | deepen run DPD (curve) | 255,856 | 0.006396 | 16 | pass |
| topup:d1 | onFees DPD (50) | 51,475 | 0.001287 | 9 | pass |
| create:d0 | mint rUSDC + createToken DP0 | 3,236,865 | 0.080922 | 13 | pass |
| buy:d0 | buy DP0 (curve) | 98,470 | 0.002462 | 5 | pass |
| sell:d0 | sell DP0 (curve, half) | 95,922 | 0.002398 | 4 | pass |
| collect1:d0 | collectCreatorFees DP0 | 94,132 | 0.002353 | 11 | pass |
| run1:d0 | deepen run DP0 (curve) | 251,056 | 0.006276 | 18 | pass |
| topup:d0 | onFees DP0 (50) | 68,575 | 0.001714 | 11 | pass |
| create:dfull | mint rUSDC + createToken DPF | 3,256,729 | 0.081418 | 15 | pass |
| buy:dfull | buy DPF (curve) | 98,470 | 0.002462 | 5 | pass |
| sell:dfull | sell DPF (curve, half) | 95,922 | 0.002398 | 4 | pass |
| collect1:dfull | collectCreatorFees DPF | 94,132 | 0.002353 | 13 | pass |
| run1:dfull | deepen run DPF (curve) | 251,056 | 0.006276 | 20 | pass |
| topup:dfull | onFees DPF (50) | 68,575 | 0.001714 | 13 | pass |
| create:dcombo | mint rUSDC + createToken DPC | 3,397,469 | 0.084937 | 21 | pass |
| buy:dcombo | buy DPC (curve) | 98,470 | 0.002462 | 5 | pass |
| sell:dcombo | sell DPC (curve, half) | 95,922 | 0.002398 | 4 | pass |
| collect1:dcombo | collectCreatorFees DPC | 177,889 | 0.004447 | 18 | pass |
| run1:dcombo | deepen run DPC (curve) | 255,856 | 0.006396 | 22 | pass |
| topup:dcombo | onFees DPC (50) | 51,475 | 0.001287 | 15 | pass |
| graduate:d1 | buy DPD out (graduation) | 239,809 | 0.005995 | 9 | pass |
| poolbuy:d1 | buy DPD (launch router) | 129,288 | 0.003232 | 5 | pass |
| poolsell:d1 | sell DPD (launch router) | 132,335 | 0.003308 | 5 | pass |
| collect2:d1 | collectCreatorFees DPD | 80,452 | 0.002011 | 15 | pass |
| run2:d1 | deepen run DPD (pool) | 364,044 | 0.009101 | 24 | pass |
| graduate:d0 | mint rUSDC + buy DP0 out (graduation) | 275,875 | 0.006897 | 9 | pass |
| poolbuy:d0 | buy DP0 (launch router) | 129,288 | 0.003232 | 5 | pass |
| poolsell:d0 | sell DP0 (launch router) | 132,335 | 0.003308 | 5 | pass |
| collect2:d0 | collectCreatorFees DP0 | 80,452 | 0.002011 | 15 | pass |
| run2:d0 | deepen run DP0 (pool) | 299,958 | 0.007499 | 24 | pass |
| graduate:dfull | mint rUSDC + buy DPF out (graduation) | 275,875 | 0.006897 | 9 | pass |
| poolbuy:dfull | buy DPF (launch router) | 129,288 | 0.003232 | 5 | pass |
| poolsell:dfull | sell DPF (launch router) | 132,335 | 0.003308 | 5 | pass |
| collect2:dfull | collectCreatorFees DPF | 80,452 | 0.002011 | 15 | pass |
| run2:dfull | deepen run DPF (pool) | 221,326 | 0.005533 | 24 | pass |
| graduate:dcombo | mint rUSDC + buy DPC out (graduation) | 275,875 | 0.006897 | 9 | pass |
| poolbuy:dcombo | buy DPC (launch router) | 129,288 | 0.003232 | 5 | pass |
| poolsell:dcombo | sell DPC (launch router) | 132,335 | 0.003308 | 5 | pass |
| collect2:dcombo | collectCreatorFees DPC | 150,529 | 0.003763 | 18 | pass |
| run2:dcombo | deepen run DPC (pool) | 364,044 | 0.009101 | 24 | pass |
| create:atk | mint rUSDC + createToken DPT | 3,256,044 | 0.081401 | 17 | pass |
| graduate:atk | buy DPT out (graduation) | 239,809 | 0.005995 | 9 | pass |
| topup:atk | mint rUSDC + onFees DPT (200,000) | 99,841 | 0.002496 | 15 | pass |
| deploy:settler | deploy Settler | 1,155,401 | 0.028885 | 2 | pass |
| attack | mint rUSDC to the attacker + Settler.attack | 987,725 | 0.024693 | 16 | pass |
| **total** | **61 transactions** | **27,320,905** | **0.683023** | **588** | **all pass** |

Transaction hashes are in `deployments/arc-testnet-deepen-rehearsal.progress.json` (gitignored) and were printed by
the driver; the deploy hashes are in the deployment record.

## What each step proves

Every transaction is simulated first (a revert costs nothing) and checked at its receipt's block against the block
before it. Six invariants are checked after every transaction that touches the plugin:

1. **previewRun equalled what the run offered.** `previewRun` at the block before equals an independent pacing model
   at that block's time (the offer and its split into the burn and deepen sides). For a pool run, `previewSplit` also
   equals the model's split.
2. **The plugin's rUSDC balance covers the sum of every token's `usdcHeld`.** Never short, at any step.
3. **The plugin holds no launch token and no LP**, before or after each step.
4. **LP at `0x…dEaD` never falls and rose by exactly the run's reported `liquidity`.** Checked on every pool run.
5. **The token's total supply fell by exactly `tokensBurned`** (the run's `burn`).
6. **The launchpad's books balance** (V13-SPEC §6.1): launchpad USDC == `pendingFees` + Σ `pendingCreatorFees` +
   Σ live curve floats, summed over every token on the launchpad (this rehearsal's and the suite's own).

The burner's own side is checked on its native balance with the gas added back: on rUSDC that balance must move by
the gas alone, and the rUSDC balance by the traded amount.

| Step | What it proves |
| --- | --- |
| `deploy:deepen` | The plugin deploys from the local artifact against the launchpad, wires to it and to rUSDC, declares `IArchitexFeePlugin` and ERC-165 (and rejects `0xffffffff`), and its constants match the spec (`CAP_BPS` 25, `RUN_INTERVAL` 3600, `MIN_RUN_USDC` 3, `DEFAULT_BURN_BPS` 5,000, `LP_RECIPIENT` `0x…dEaD`). The deployed code equals the local build byte for byte. |
| `create:*` | `createToken` registers the plugin, the creator fee and the hook decision. The plugin is configured for the token with the intended burn share (`burnBpsOf`: 5,000 default, 0, 10,000, 2,500 via the Combo), its totals start at zero, and `BurnShareSet` is emitted. A second `onLaunch` reverts `AlreadyConfigured` (write-once). For DPC: the Combo stored the allocation, configured the Deepen entry through its forwarded data (`burnBpsOf` 2,500), and the Deepen plugin emitted `Configured` with the creator. |
| `buy:*`, `sell:*` | Curve buys and sells equal `quoteBuy`/`quoteSell` and an independent model of V13-SPEC §5 (both fees from the USDC side, rounded up). The curve state and the books move exactly. |
| `collect1:*` | `collectCreatorFees` (permissionless) pays the accrued fee to the token's plugin. For the direct-Deepen tokens the Deepen pot (`usdcHeld`) rises by exactly the fee, with `FeesReceived` from the launchpad. For DPC the Combo forwards 70% to the Deepen plugin (`FeesForwarded`, `viaHook`) and 30% to the wallet; the Deepen pot rises by exactly its slice, proving the Combo path configures and pays the plugin. |
| `run1:*` | A curve run: the whole offer buys through the launchpad and everything held is burned, whatever the burn share (before graduation there is no pool). The offer is `min(usdcHeld, full cap)`, the cap 0.25% of the curve's virtual USDC (about 22.09 rUSDC of the first run). `previewRun` before equals the model; supply fell by exactly the tokens bought; `lastRunAt` and `nextRunBlock` are set; a second run in the same block reverts `AlreadyRanThisBlock`. |
| `topup:*` | `onFees` called directly by the burner, a non-launchpad caller: `FeesReceived` names the burner, the pot and the plugin's rUSDC both rise by exactly the amount. Anyone may deliver fees for a configured token. |
| `graduate:*` | The sell-out buy graduates the token, seeds the pool with 200M tokens and about 25,000 rUSDC, and mints every LP token to `0x…dEaD`. The plugin holds no LP. |
| `poolbuy:*`, `poolsell:*` | Launch-router trades equal the router quote and a constant-product model, moving the reserves exactly. They accrue the creator fees the pool run then spends. |
| `run2:*` | A pool run, checked to the unit against a full off-chain model of both sides (the burn-side buy, then the deepen-side split, buy and add at the reserves that buy leaves). The four burn shares behave as the spec says: DP0 (0) adds only and burned 0 tokens; DPF (10,000) burned only and added no liquidity (`liquidity` 0); DPD (5,000) and DPC (2,500) did both. LP at `0x…dEaD` rose by exactly the reported `liquidity`, supply fell by exactly `tokensBurned`, and the plugin kept no token or LP. |
| `attack` | The H1 attack, live: it loses (see below). |

The pool runs were paced small (a few seconds after each token's curve run, so the budget is
`cap × elapsed / 3600`, a few rUSDC of a ~63 rUSDC cap), which is the intended pacing and enough to exercise the add.
The attack token's run got a full cap, since it never ran before the attack.

## The H1 attack, live

The `Settler` from `contracts/test/review2/CapInflationSettle.t.sol` was deployed against DPT, a freshly graduated
Deepen token (1% creator fee, default burn share) whose pot was topped up to 200,000 rUSDC through `onFees` and which
had never run, so its first run got a full cap. The attacker was minted 10,000,000,000 rUSDC (the forge fixture's
amount, so the P&L is comparable) and called `attack(push, park=true, withRun=true, sweep=false)` in one transaction:
push the price with a router buy, park the bag as liquidity, run the plugin, unpark, sell everything.

| Item | On chain (rUSDC) | Local `forge` (`test_S1_deepen_itemised_loses`) |
| --- | ---: | ---: |
| honest first-run offer (0.25% of the locked pool) | 62.499999 | 62.499999 |
| push (router buy) | 1,410,369.097970 | 1,410,369.097970 |
| park, USDC side | 78,585,786.438532 | 78,585,786.438532 |
| peak capital in one transaction | 79,996,155.536502 | 79,996,155.536502 |
| pot spent by the run | 3,535.533900 | 3,535.533900 |
| fees: buy platform | 7,051.845490 | 7,051.845490 |
| fees: buy creator | 14,103.690980 | 14,103.690980 |
| fees: sell platform | 6,950.527457 | 6,950.527457 |
| fees: sell creator | 13,901.054913 | 13,901.054913 |
| fees: total paid | 42,007.118840 | 42,007.118840 |
| **NET P&L (USDC out - in)** | **-38,543.027259** | **-38,543.027259** |

The on-chain attack reproduces the local `forge` result to the unit: a loss of **38,543.027259 rUSDC**, zero blocks
held, all fees paid. The attacker ends holding no token and no LP.

Why it loses, and why one run spent 3,535 rUSDC rather than 62 or the whole 200,000: the cap is 0.25% of the LOCKED
part of the reserve (`reserve × LP at 0x…dEaD / LP supply`; V13-SPEC §2.3, SECURITY.md §3c, the fix for H1). Parking
liquidity does not move the locked part, so it adds nothing to what the run spends (the run spent the same 3,535 rUSDC
with the bag parked as it does with the push alone). The push does move the locked part, but only by about the square
root of the price move: a push of `b` raises the cap by at most 0.25% of `b`, so one run spent at most
`62.499999 × (25,000 + 1,410,369) / 25,000 ≈ 3,588` rUSDC. The 1,410,369 rUSDC push paid the 0.5% platform fee and
the 1% creator fee going in and again coming out, which is the 42,007 rUSDC of fees; the run gave back only 3,535, so
the attacker is down 38,543. Against the pre-fix design (Buyback & burn v1, still live and paused) the same attack
made a 200,000 rUSDC pot pay out at a pushed price for a large profit; here it cannot.

## The two corrected checks

Two auxiliary checks in the attack step failed on the first attempt. **Both were the script's expectation, not the
contract.** The contract behaved exactly as the spec and the local `forge` tests say.

- I first asserted the run spends "about the honest offer" (62.5 rUSDC) and "a small part of the 200,000". Both are
  wrong: the push legitimately raises the locked-part cap by about 0.25% of the push, so one run spends about 3,535
  rUSDC, more than the un-pushed 62.5. That is expected and is exactly why the DeepenCapBase tests bound the spend by
  `honest × (reserve + push) / reserve`, not by the un-pushed offer.
- The check that actually matters, that the attack loses (P&L < 0), passed on the first attempt with the correct
  number.

The checks were rewritten to the real invariant, which the run satisfies to the unit: the run spends at most 0.25% of
the pushed locked part (3,535.53 <= 3,588.42), far less than the push it cost to inflate it (3,535.53 << 1,410,369),
and the loss covers the double-charged push fees. The `attack` step was then re-checked against the same mined
transaction, with nothing re-sent, and passed.

The first curve run of the Combo token also flagged one check on an even earlier attempt of the same run: the
write-once probe re-called `onLaunch` on the Deepen plugin with the Combo's array data, which the plugin correctly
rejects as `NonCanonicalData` (it decodes a `uint16` first) before reaching the `AlreadyConfigured` guard. The probe
was corrected to carry the Deepen entry's own data; again the contract was right.

## How to run it

The script holds no key. It reads a testnet-only burner key from `BURNER_KEY`, loaded inline into the process that
needs it, and never prints, logs or writes it. It refuses every chain but Arc Testnet (5042002), so it can never touch
mainnet.

```bash
forge build

# Read-only: wiring, constants and whatever state a drive has reached. No key needed.
bun run scripts/deepen-rehearsal.ts

# Drive it. The key is loaded only into this command's environment.
BURNER_KEY="$(grep '^VITE_DEV_BURNER_KEY=' .env.local | cut -d= -f2-)" \
  MARKDOWN=1 bun run scripts/deepen-rehearsal.ts
```

It deploys one `DeepenPoolPlugin` against the launchpad in `deployments/arc-testnet-v13-rehearsal.json`, confirms the
deployed code equals the local build, and drives the four burn-share tokens and the H1 attack. The burner (which owns
rUSDC) mints the rUSDC each step needs.

**Resuming.** Progress lives in `deployments/arc-testnet-deepen-rehearsal.progress.json` (gitignored): a re-run skips
finished steps, never re-sends a mined transaction, and re-checks a step whose transaction was mined but whose checks
had not passed. Both fixes above were verified this way, re-checking the mined transactions without re-sending them.

Settings: `DEPLOYMENT` (the base v1.3 suite), `RECORD` (the record written), `PROGRESS`, `ARC_TESTNET_RPC`,
`ARTIFACTS` (default `contracts/out`), `GAS_CAP` (USDC of gas the driver may spend, default 1.5), `MARKDOWN=1`.

## Notes from the real chain

- Blocks come about every 0.5 s; receipts arrived within a few seconds. The whole drive spent 5 RPC retries on the
  public node's burst limits.
- Every graduation seeded the same pool, about 24,999.999969 rUSDC against 200M tokens, whatever the token's initial
  buy or curve path: the seed is fixed by the curve at `tokensSold == CURVE_SUPPLY`. This is why the attack's honest
  offer, 62.499999 rUSDC, matches the forge fixture's pool exactly.
- `createToken` with this plugin costs about 3.22M to 3.40M gas; a curve run about 251k to 256k; a pool run 221k (all
  burn) to 364k (a split with the add and the LP mint); a collection into the plugin 80k to 178k (most for the Combo).
  Deploying the plugin cost 2.11M.
- What is left on chain: the plugin holds 198,056.65 rUSDC across the five tokens' pots (mostly DPT's 200,000 pot,
  less the 3,535 its attack run spent). The five pools are graduated and hold about 25,000 rUSDC each plus the small
  adds the pool runs locked at `0x…dEaD`. The burner ended at 4.472875 USDC of native gas.
