# Security tooling

Architex has **no third-party audit**. This is the mitigation until there is one: static
analysis and fuzzing on every change, symbolic execution on the highest-value contracts
before mainnet moves, and a checklist of free third-party scans once contracts are deployed
and verified. None of this is a substitute for an audit — it catches known bug classes, not
novel logic errors in the launchpad's bonding-curve math.

## 1. Static analysis + linting — runs on every push/PR (`.github/workflows/contracts-security.yml`)

| Tool | What it catches | Run locally |
| --- | --- | --- |
| [Slither](https://github.com/crytic/slither) (Trail of Bits) | 80+ vulnerability detectors: reentrancy, unchecked calls, access control, arithmetic | `bun run contracts:slither` |
| [Aderyn](https://github.com/Cyfrin/aderyn) (Cyfrin) | Rust/AST-based, different detector set than Slither, catches what Slither's dataflow model misses | `bun run contracts:aderyn` |
| [Solhint](https://github.com/protofire/solhint) | Style + basic security lint (`solhint:recommended`), fast, catches missing zero-address checks etc. | `bun run contracts:solhint` |

Config: `.solhint.json` (natspec/gas nitpicks turned off — signal over noise), `slither.config.json`
(fails CI on `high`/`critical` only; `medium`/`low` are reported, not blocking). Run all three:
`bun run contracts:security`.

**Footgun:** `slither . --json <path>` silently under-scans (skips newly-added files, with no
error) if a file already exists at `<path>` from a previous run — always `rm -f` the JSON output
path immediately before invoking it with `--json`. Plain `slither .` (console output, no `--json`)
is unaffected. CI does this already (`contracts-security.yml`); do it too in any ad-hoc local run.

**Baseline (2026-09-20, 49 contracts incl. interfaces and the fee-distribution plugins, ~1350
nSLOC):** Slither found 0 high, 24 medium, 58 low (mostly `calls-loop` in the read-only
`ArchitexLens` batch views and `timestamp` comparisons in AMM math — expected in a Uniswap V2
design, not bugs). The 2 mediums added by `WeightedSplitDistributor` are the same false-positive
classes as the rest of the codebase: a `require(amount != 0)`-style strict-equality check
(idiomatic, not attacker-influenced state) and an implicitly-zero-initialized `uint256 sum` local
(Solidity zero-initializes by default; the explicit `= 0` Slither wants is a style preference,
not a correctness issue). Aderyn flagged 4 "high" findings (none from the plugins) that are
**verified false positives** against this code, not blind tool output:

- *Arbitrary `from` in `transferFrom`* (`TestToken.sol:47`) — the standard ERC-20 `transferFrom`
  override, protected by `super`'s allowance check; testnet-only contract regardless.
- *Unprotected initializer* (`ArchitexPair.initialize`, `LaunchToken.initPair`) — both are
  guarded (`if (msg.sender != factory) revert Forbidden()` at `ArchitexPair.sol:106`; `onlyLaunchpad`
  + one-shot guard at `LaunchToken.sol:40-42`). Aderyn's detector only recognizes OpenZeppelin's
  `Initializable` modifier, not custom guards.
- *Unchecked return value* (`SeedPools.sol:52`, `ArchitexLaunchpad.sol:217`) — slippage is already
  enforced by the callee (`minTokensOut` / router min-amounts); the ignored return is cosmetic.
- *Contract locks Ether* (`ArchitexLaunchpad`) — `receive()`/`fallback()` both unconditionally
  `revert()` (`ArchitexLaunchpad.sol:115-116`); the contract never accepts ETH at all.

Re-verify this reasoning after any change to `ArchitexPair.initialize`, `LaunchToken.initPair`,
or the launchpad's fallback handlers — the guards are what make these findings false positives,
not the absence of the pattern Aderyn looks for.

## 2. Invariant fuzzing — for every change to `ArchitexPair`/`ArchitexFactory`

| Tool | Style | Run |
| --- | --- | --- |
| Foundry invariant tests | Already in `contracts/test/ArchitexInvariant.t.sol`; runs with `forge test` | `bun run contracts:test` |
| [Echidna](https://github.com/crytic/echidna) (Trail of Bits) | Coverage-guided fuzzer, independent engine from Foundry's — explores different call sequences against the same properties | `bun run contracts:echidna` |

Echidna properties (`contracts/test/echidna/EchidnaArchitexPair.sol`, config `echidna.yaml`):
`k` (reserve0 × reserve1) never decreases, LP total supply always matches tracked holder
balances, and the pair's on-chain token balance always covers its reported reserves. These
mirror the Foundry invariant test's properties under a second, independently-implemented fuzzer
— the point is two different tools disagreeing would be a signal, not redundant coverage.

Not yet written: launchpad-side invariants (solvency: `USDC held == accrued fees + curve float`,
already proven in the Foundry fuzz/invariant suite per `docs/launchpad/TESTNET-DEPLOY.md`) ported
to Echidna. Add if the launchpad contract changes before mainnet.

## 3. Symbolic execution — manual, before any mainnet deploy or contract change

[Mythril](https://github.com/Consensys/Mythril) does bounded symbolic execution — it can prove
"no input reaches this integer overflow" rather than just sampling like a fuzzer, but it's slow
(minutes per contract) and doesn't scale to CI-on-every-commit. Run manually before a mainnet
deploy or after any change to the contracts that hold funds:

```bash
bun run contracts:mythril   # ArchitexPair, ArchitexRouter, ArchitexLaunchpad
```

Reports land in `reports/security/mythril-*.md`. `MYTHRIL_TIMEOUT` env var controls the
per-contract execution timeout (default 600s).

**`ArchitexPair.sol` baseline (2026-09-20):** 1 High, 32 Low — **all verified false positives**:

- The High finding ("integer underflow") is on `contracts/ArchitexPair.sol:106`, flagging the
  compiled `msg.sender != factory` comparison itself — the access-control check that gates
  `initialize()`. Address inequality compiles to a `SUB`+`ISZERO` at the EVM level, which
  Mythril's generic underflow detector flags without understanding that the result only feeds a
  boolean branch (`revert Forbidden()`); wraparound semantics of the subtraction don't change
  whether the two addresses are equal, so there's nothing to exploit.
- The 32 Low findings are almost entirely the same class ("this issue is reported for internal
  compiler generated code") on trivial view functions (`decimals()`, `symbol()`, `DOMAIN_SEPARATOR()`,
  `MINIMUM_LIQUIDITY()`, etc.) plus two "state access after external call" findings on `skim()`,
  which carries the `lock` reentrancy guard shared with `mint`/`burn`/`swap`/`sync` (verified at
  `ArchitexPair.sol:291`) — the exact pattern from audited Uniswap V2, not a new exposure.

**`ArchitexLaunchpad.sol` baseline (2026-09-20):** completed in ~3 minutes (well under the 400s
budget, so not a timeout truncation) and reported no findings at any severity. Caveat: this is
the highest-complexity contract of the three (bonding-curve math, graduation, fee accounting)
and Mythril's default search strategy has a bounded exploration depth — a clean run means it
didn't find a violation *within that budget*, not a proof there is none. The curve math already
has 152 passing Foundry unit/fuzz/invariant tests and two red-team reviews
(`docs/launchpad/GROK-REVIEW-1.md`, `GROK-REVIEW-2.md`); this Mythril pass is one more data point
on top of that, not a replacement for it.

**`ArchitexRouter.sol` baseline (2026-09-20):** re-run at a 1200s budget still finished right at
the timeout boundary (20 min, no findings) — same pattern as the first 400s attempt. This is
**Mythril's path explosion on loop-heavy code**, not a red flag: the router loops over
arbitrary-length multi-hop swap paths, and symbolic execution's state space grows with every
extra path length it has to consider, so it doesn't converge to "exhausted" the way `ArchitexPair`
did. Two things make this an acceptable known limitation rather than a blocker:

1. The router never holds funds between transactions — it's a pass-through that calls
   `ArchitexPair.swap`/`mint`/`burn` directly, so the pair's own (successfully-scanned,
   invariant-fuzzed) accounting is what actually protects reserves.
2. `contracts/test/ArchitexRouter.t.sol` and the fork suite (`LaunchpadArcFork.t.sol`) already
   exercise multi-hop swaps, slippage, and deadline paths against real bytecode.

Don't keep raising the timeout chasing full symbolic coverage here — it won't converge.

**Closed 2026-09-20** with Foundry invariant fuzzing instead of more Mythril budget:
`contracts/test/ArchitexRouterInvariant.t.sol` wires three tokens into two pairs (A/B, B/C) so
every call can multi-hop, and fuzzes `addLiquidity`/`removeLiquidity`/both swap directions through
the router — the exact path-explosion surface Mythril couldn't exhaust. 128,000 calls per run,
including ~25,600 multi-hop exact-in and ~25,600 multi-hop exact-out swaps, 0 failures. Three
invariants: the router never ends a call holding a balance of any token (it's a pure pass-through),
`k` never decreases for either pair, and each pair's on-chain balance always covers its reported
reserves.

## 3b. Launchpad v1.3 — review record (2026-09-21)

v1.3 (docs/launchpad/V13-SPEC.md) adds creator fees routed to plugins, a separate launch-pool suite, a dividend
token and four reference plugins. Everything below ran on the final code unless noted.

**Adversarial reviews.** Three independent Claude reviews (money flow and accounting; plugin trust boundaries;
the dividend token), Grok #3 (`docs/launchpad/GROK-REVIEW-3.md`), a final Claude review of everything changed
after them, and Grok #4 (`GROK-REVIEW-4.md`). What they changed:
- **Holder dividends could be sniped** (Grok #3 High): any design that releases a matured lump to whoever holds
  at release time stays snipeable, so dividends now accrue second by second inside `LaunchToken`
  (StakingRewards-style); a buy, claim and sell in one transaction earns exactly 0, and the stream pauses while
  nobody holds. Confirmed closed by Grok #4 and the final review.
- **Buyback & burn could be farmed** by chaining one run per block (Medium): spending is paced to 0.25% of the
  USDC-side reserve per hour, so front-running it means holding for ~3 h (0.5% creator fee) up to ~49 h (10%).
- **Fee destinations that can never pass fees on** (Low): `createToken`, Split and Combo refuse USDC, the router,
  the pair factory, any launch token and any launch pair (a new `isLaunchPair` registry: fees sent to a pair can
  be skimmed by anyone); plugin data sent to a non-plugin reverts `DataForNonPlugin`.
- **Curve trades had no deadline** (Low): `buy`/`sell` take one and revert `Expired`.
- Stale stream views, buyback dust (`MIN_RUN_USDC`), and every accepted limit written into V13-SPEC §9.
Nothing above Low was left open. Each finding and decision is in V13-SPEC §9 and the commit history.

**Static analysis** (final code): Slither 0 High; the v1.3 Mediums are the same verified false-positive classes as
§1 (`receive`/`fallback` revert so nothing locks ether; `nonReentrant` on every flagged reentrancy with state
written before untrusted calls; fees computed from a floored gross that rounds in the pool's favour;
Uniswap-V2 `== 0` checks and `== 0` checks on computed amounts). `LaunchToken` has no Mediums. Aderyn: the same
four High false-positive classes, same instances (`ArchitexLaunchpad.initialize` is deployer-only, one-shot and
checks its wiring; `LaunchToken.initPair` is launchpad-only and one-shot).

**Symbolic execution** (Mythril, 1200 s execution budget): `ArchitexLaunchpad` 0 findings; `LaunchToken` 0;
`BuybackBurnPlugin` 0; `HolderDistributionPlugin` 5 Low, all expected (it calls the configured launch token it was
handed, after `_requireConfigured`, inside `nonReentrant`); `LaunchPair` 0 and `LaunchPairFactory` 0 (run before
the review fixes, which did not touch them); `LaunchRouter` 3 Low (deadline checks on `block.timestamp`, a
constructor read from the launchpad).

**Tests.** 611 Foundry tests on the final code, including invariant suites for the launchpad (the launchpad's
USDC equals its books; tracked eligible supply equals the balance formula) and the plugins; 79 end-to-end tests
of the real plugins against the real launchpad, launch pools and router (every trade checked against fees
computed from the spec; whole-system USDC conservation after every step); an independent per-holder shadow model
of the dividend stream; mutation checks (the stream's tests catch 11 of 12 token mutants, the survivor being
equivalent).

**Testnet rehearsals** (docs/launchpad/V13-REHEARSAL.md): the whole suite deployed on Arc Testnet with a mintable
test USDC and with real test USDC; five tokens (one per plugin) taken through graduation, pool trades,
collections, buybacks and claims; the books checked after every transaction. Second run on the reviewed
contracts: 90 transactions, 1,424 checks, 0 failures; deployed bytecode equal to the local build.

## 3c. Deepen pool: round-5 review record (2026-09-23)

Deepen pool (V13-SPEC §2.3) had an independent Claude review, which writes proof-of-concept tests, and Grok #5.
Grok cleared it. The Claude review found one High that also applies to the Buyback & burn plugin already on
mainnet:
- **H1: one transaction could make a run spend the whole pot at a pushed price.** Both plugins took their pool cap
  from the pool's whole USDC reserve, and `LaunchPair` charges nothing to add or remove liquidity. Push, park the bag
  as liquidity, run, unpark, sell: +153,179 USDC (Deepen pool) and +154,893 USDC (Buyback & burn v1) on a 200,000 USDC
  pot, zero blocks held, all fees paid. **Fixed in Deepen pool** before its deploy: the cap is 0.25% of the locked
  part of the pool, the share owned by LP at `0x…dEaD`, which adding or removing liquidity does not move. **Buyback &
  burn v1 is immutable**; no mainnet token uses it, and the builder has paused it for new launches. Its tests keep
  asserting that it pays, so it is not listed again by accident.
- The review's other notes were documentation (an existing LP loses about `n²/R` against holding per run, not
  nothing) and three informational checks that held.

## 4. Third-party scanners — after mainnet deploy + Etherscan-equivalent verification

These need a **deployed, verified contract address** and most need an account on their site —
account creation on your behalf isn't something I'll do, so this is a checklist for you once
section 1 of `docs/GO-LIVE.md` is done:

- [ ] [De.Fi Scanner](https://de.fi/scanner) — multi-chain risk score, honeypot/tax checks. Free,
      no login for a single scan.
- [ ] [PreAudit.org](https://preaudit.org) — security + tokenomics scan (check Arc/chain-5042
      support first; if unlisted, it may only take the flattened source, not a live address).
- [ ] [ContractAudit.io](https://contractaudit.io) — AI-assisted scan of verified source.
- [ ] [Hashlock AI Audit](https://hashlock.com) — AI-assisted scan of verified source.

None of these are a substitute for a human third-party audit (the Beta chip and risk disclosure
in the app stay until there is one) — they're free signal to publish alongside the "no audit yet"
disclosure, and cheap badges if they come back clean.
