## Durable launch fulfilment over the Arc–Solana route

The [Arc–Solana integration rehearsal](EQUILIBRIUM-ARC-SOLANA.md) proved the route: two live
environments exchanging the bytes they actually published, with each half of the ledger read from its
own chain. This is what it takes to fulfil a *launch* across that route — a paid job that resumes
after a crash and does not charge, issue, debit or credit twice when anything retries.

**This is local evidence. No EQUILIBRIUM token, mint, manager, transceiver, inventory or transfer
exists on Arc mainnet, Arc testnet, Solana devnet or mainnet-beta, nothing was funded or broadcast,
and no public route is open.** The settlement and quote assets are fixture tokens and one development
guardian key is substituted into both core bridges, which is precisely why a passing run is not a
route proof.

Run it with `bun run equilibrium:solana:build` once, then `bun run equilibrium:arc-solana:fulfill`.
It uses its own port (4142) and its own journal (`output/equilibrium/arc-solana-fulfillment.sqlite`),
so it does not disturb `equilibrium:server` or the local rehearsal. The record it writes is
`output/equilibrium/arc-solana-fulfillment.json`.

### What this adds over the integration rehearsal

The rehearsal ran straight through. A launch cannot assume it will.

| | Integration rehearsal | This harness |
| --- | --- | --- |
| Who drives the route | a script, in order, in one process | a durable job the HTTP service resumes |
| Payment | none | a signed x402 quote settled through EIP-3009, once |
| A worker that dies mid-step | not exercised | the store is closed and reopened; the sweep finishes with no client request |
| Retrying a step | not exercised | every step is observed from chain state before anything is resubmitted |
| Conflicting requests | not exercised | refused before a quote can be paid, and again by the issuance factory on chain |
| Conservation | asserted between script stages | a gate on every step that would record a transfer, refusing to record one the two chains disagree about |

### How each step is made observable

A restarted worker holds nothing but the job row. So every step's plan is derived from the job,
persisted before anything is submitted, and answered afterwards by a read a fresh process can make.
That is the whole design; the interesting part is that the chains do not all offer the same help.

| Step | Effect | What makes a retry safe |
| --- | --- | --- |
| `payment:arc` | EIP-3009 `transferWithAuthorization` | the token consumes the nonce, so the *chain* refuses the second submission |
| `canonical:arc` | `EquilibriumIssuanceFactory.issue` | keyed by the step's operation hash, which the factory binds to the issuance parameters and will not rebind |
| `manager:arc` | a locking NTT manager, its transceiver, the Solana peers and the launch's allowances | registered in `EquilibriumRouteRegistry` only once all of it is wired, so a half-built leg reads as absent and the contracts it left behind are referred to by nothing |
| `pool:arc` | pool inventory and the rest of the Arc allocation | one `EquilibriumDistributor.place` call: both move together or neither does |
| `manager:solana` | the derived mint, the burning manager config, the transceiver and the Arc peers | every account is a PDA or derived from the operation, and the observation requires the *last* one written, so an interrupted leg resumes from whichever part is missing |
| `debit:solana` | the hub manager's `transfer` | **not idempotent.** The core-bridge sequence is read and persisted before submitting; an unpublished sequence means it never happened, and a different payload at that sequence fails the step closed rather than locking a second allocation. The sequence is re-read immediately before the transfer, so the window between the observation and the lock is closed too |
| `credit:solana` | post the VAA, validate, redeem, release the mint | keyed by the NTT manager-message digest, which the spoke's own inbox item and replay guard use. The redeem and the release are separate transactions and the manager's inbound rate limit lives between them, so a delivery it is holding is [recorded as a claim](#a-claim-the-destination-will-not-release-yet) rather than retried |
| `pool:solana` | inventory and the rest of the Solana allocation | one Solana transaction, so it is atomic, and the holder's funded token account is only reachable together with the rest |

### A claim the destination will not release yet

A bridge can answer a third thing. Besides "the effect landed" and "it did not", the pinned manager
can hold an authenticated delivery: a transfer over the peer's inbound rate limit is voted into an
inbox item and stamped `ReleaseAfter(now + 24 hours)` against the Clock sysvar, and
`release_inbound_mint` refuses until that boundary passes.

Both of the obvious readings are wrong, and expensively so.

- Read as an **absence**, it becomes the runner's licence to submit — and absence is exactly what
  authorizes locking or minting again. On this route the release would merely revert, but the same
  mistake with `revert_when_not_ready` off is a transaction that succeeds and delivers nothing.
- Read as a **result**, the launch is reported fulfilled while the recipient holds nothing.

So it is recorded as what it is. `Step.claim` carries the destination's own handle for the claim — on
Solana the manager-message digest its replay guard is keyed by — with the bound amount, the account
the program will release to, the boundary the program wrote, and the chain clock that boundary was
last read against. `queuedAt` keeps the first sighting, because how long this launch has been waiting
is the figure a customer is owed; the clock reading is refreshed on every observation.

What follows from the record:

- The step stays `prepared` and the job `partial`, so nothing downstream treats the allocation as
  delivered and the free record says `fulfillment: incomplete` beside a settlement that is complete.
- The job stays in the unattended sweep. A claim is the one kind of unresolved step where retrying
  later is progress rather than a repeat of the same failure, because the boundary will pass.
- The route's own submission stops after the redeem it landed rather than attempting a release the
  manager is holding. Failing there would fail a step that submitted something, and the runner takes
  a step that submitted nothing *out* of the sweep — so the one retry that would have succeeded would
  never run.
- A second observation reporting a different reference, amount or recipient under the same step fails
  the step closed. Either it is this launch's delivery or it is a claim this launch should not be
  waiting out; only the first is safe. The boundary and the clock are expected to move and are
  recorded rather than compared.
- Conservation does not change. A queued allocation is locked on Arc and not minted on the spoke,
  which is what `pendingToSpoke` already means — a queue is an explanation, not an accounting event.
  The free record reports the queued figure next to the conservation figure, never inside it.
- When the claim is finally released, its record is stamped `releasedAt` and kept. The delay is part
  of what happened to the customer's launch, and it is gone from the chain once the claim releases.

`spokeClaim` in `server/equilibrium/solanaRoute.ts` is the whole decision, and it is pure: an inbox
item, the chain's clock, and the plan it is supposed to satisfy. The amount and the recipient are
checked there rather than only at release, so a claim addressed elsewhere is refused instead of
waited out.

### Addresses that are recoverable but not predictable

Every Solana address a step owns has to satisfy two things at once, and an earlier version of this
code satisfied only the first.

It must be **recoverable**, because the account is how the observation decides whether the effect
already happened. A mint generated at random and held in memory is lost with the process that held
it, and a lost mint address is an unobservable issuance — the precise condition under which a launch
issues its supply twice.

It must equally be **unpredictable or unsignable**, because the job id is public: the 402 response
returns it and the step ids are fixed strings. The first version derived an ed25519 keypair from
`keccak256(operation:label)`, which made the inventory holder's signing key a public function of the
job id. Anyone who had merely asked for a quote could move the pool allocation after `pool:solana`
succeeded.

The two properties are met separately:

- **The spoke mint** is a random 32-byte secret generated when `manager:solana` is prepared and
  persisted inside that step's plan. The plan is written to the journal before anything is submitted,
  so a restart reads the secret back and finds the same mint; `publicJob` never projects a step's
  prepared bytes, so the secret does not reach any response, the job list or the harness record.
  Because a re-derivation necessarily draws a different secret, `planMatches` excludes this field —
  the persisted value is the authoritative one, exactly as it is for the debit's recorded sequence.
- **Each inventory holder** is an address with no private key: on Solana a program-derived address
  under an `equilibrium-inventory` seed the pinned NTT manager does not declare, so no program can
  sign for it either; on Arc the last twenty bytes of the operation hash. Both are still a public
  balance read, which is all the observation needs.

### The conservation gate

No step past the point where both ledgers exist is recorded complete unless the two of them
reconcile. The figures come from different places and neither is calculated from the other: the
issuance and the custody balance from the Arc token and its locking manager, the spoke supply and
custody from the SPL mint and the manager's custody account. The two in-flight counters come from the
job's own recorded steps, because a message in flight is not a chain fact.

This is what connecting the launch to the *observed* route buys. A debit that locked the wrong amount,
a credit that minted more than the hub holds, or a mint whose authority let someone else issue
alongside the launch all surface here as a failed comparison — and the step is not recorded, so
nothing downstream treats the allocation as delivered.

### What the harness exercises

Each of these is a checkpoint in the record, with the refusal or the observed figures attached.

- **Quote.** An unpaid request answers 402 with a `PAYMENT-REQUIRED` header and the bound plan.
  Nothing is issued and nothing is charged.
- **Request conflicts.** A different payload under the same payer and requestId is refused
  `identity_conflict`; a Base destination is refused `route_closed`. Both before a quote exists to pay.
- **Failed payment.** An authorization signed by another key, one for less than the quoted total, and
  one whose window has closed are each refused, and the authorization nonce is still unconsumed on
  chain afterwards. A refused payment is a refusal, not a partly fulfilled launch.
- **A queued credit.** The spoke's inbound rate limit for the Arc peer is set below the Solana
  allocation, so the pinned manager holds this launch's own delivery. The redeem lands, the mint does
  not, and the job records the claim: its digest, the bound amount, the custody account it is
  addressed to, and the boundary the manager wrote against the Clock sysvar. The launch stays
  `partial` with the charge settled and readable on its own, and the free record reports the queued
  figure next to the conservation figure rather than folded into it.
- **The early release refused.** Releasing the claim before that boundary is refused by the program,
  not by the adapter. The unattended sweep reaches the job, finds the claim still held, submits
  nothing, and keeps the claim's first sighting while refreshing the clock it was last read against.
- **A spoke restart with the claim outstanding.** The validator is killed with `SIGKILL` and its
  ledger reopened: the claim comes back with the same boundary. The Arc fork stays up throughout, so
  the custody backing the claim is a live read of a chain that never restarted.
- **The boundary passing.** The spoke's accounts are dumped at `finalized` commitment and the ledger
  rebuilt at a new genesis under a validator whose `CLOCK_REALTIME` is offset past the manager's
  24-hour duration. Every seeded account is compared byte for byte against the dump, including this
  launch's claim and its boundary, before anything is released.
- **An interrupted release.** The release is submitted and then reported unresolved, which is what a
  worker that dies between sending an effect and recording it leaves behind. The release *did* land —
  the record shows the observed SPL supply against the observed Arc custody while the job still calls
  the step prepared.
- **Unattended recovery.** The journal is closed and reopened and the sweep finishes the launch with
  no client request and no signature, crediting nothing twice. The delivered claim keeps the delay it
  waited out, both ledgers reconcile, and the released claim resubmitted to the manager is refused.
- **Replay.** The identical paid request re-sent answers 200 with the same settlement transaction and
  no new effect. The settled authorization resubmitted straight to the token is refused
  `AuthorizationAlreadyUsed()`.

`server/equilibrium/__tests__/solanaFulfillment.test.ts` covers the same families against a ledger
double that enforces those uniqueness rules and counts how many times each irreversible thing
happened. Its debit is deliberately non-idempotent, like the hub's.

### Costs

Arc network fees are reported in the launch's own six-decimal atoms. Arc's native gas asset is USDC
at eighteen decimals, so that is a unit conversion and not an exchange rate. A leg is several
transactions and no receipt covers the whole of it, so the worker measures its own native balance
across the leg and records the figure at the commit point, where a restarted observer reads it back.
Allowances are taken there too, which is what lets the debit and each placement be a single
transaction whose receipt is the whole of its cost.

Fees spent on a leg attempt that never reached the commit point are attributed to nothing, because
nothing identifies them. That is the price of a leg that cannot be built atomically.

### What this does not establish

- **Any public route.** Nothing exists on Arc mainnet or testnet, Solana devnet or mainnet-beta.
- **Real settlement.** `EquilibriumPaymentFixture` is an EIP-3009 token this run deploys. The
  signature path, the EIP-712 domain and the once-only nonce are real; the balance it moves is not.
  Arc testnet USDC cannot be used, because the payer this harness signs for holds none of it.
- **Guardian authentication.** One development key is substituted into both core bridges. The real
  Guardian set signed nothing.
- **An unassisted 24-hour wait.** The spoke's clock is moved by rebuilding its ledger at a new
  genesis under an offset `CLOCK_REALTIME`; the claim, its boundary and the release are the pinned
  manager's own, and the rebuilt accounts are proved byte-identical, but the passage of time is a
  fixture and the record labels it as one. The fixture is macOS-only — it interposes
  `DYLD_INSERT_LIBRARIES` — so on another host the harness stops at the boundary, writes the evidence
  it did reach with `complete: false`, and says which prerequisite is missing.
- **The return leg.** A launch only crosses towards the spoke. Burning a representation back to Arc
  custody, including the hub's own queue, is exercised in the [integration
  rehearsal](EQUILIBRIUM-ARC-SOLANA.md#the-24-hour-delayed-return-on-the-spoke).
- **Any venue or AMM.** The inventory steps place pool tokens and quote inventory into a per-operation
  holder and deliver the rest of each allocation to the request's recipient. Opening a market adapter
  is separate work.
- **Solana fees as launch cost.** They are paid in SOL by the operator's fee payer and reported as a
  zero launch cost rather than converted into the customer's asset, because there is no honest
  conversion. The record says so.
- **More than one launch at a time.** The pinned SVM manager keeps one config PDA per deployed
  program, so one program instance backs one mint. A second concurrent launch would put two issuances
  behind one set of custody figures; the spoke leg's observation refuses a config bound to another mint
  rather than proceeding.
