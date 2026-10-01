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
| `credit:solana` | post the VAA, validate, redeem, release the mint | keyed by the NTT manager-message digest, which the spoke's own inbox item and replay guard use |
| `pool:solana` | inventory and the rest of the Solana allocation | one Solana transaction, so it is atomic, and the holder's funded token account is only reachable together with the rest |

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
- **An interrupted worker.** The SPL credit is submitted and then reported unresolved, which is what a
  worker that dies between sending an effect and recording it leaves behind. The job is `partial`,
  sweep-eligible, and its settlement is readable on its own. The credit *did* land — the record shows
  the observed SPL supply against the observed Arc custody while the job still calls the step prepared.
- **A spoke restart.** The validator is killed with `SIGKILL` and its ledger reopened mid-launch. The
  Arc fork stays up throughout, so the custody backing the claim is a live read of a chain that never
  restarted.
- **Unattended recovery.** The journal is closed and reopened and the sweep finishes the launch with
  no client request and no signature, crediting nothing twice. Both ledgers reconcile.
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
- **The Solana inbound queue's eventual release, here.** This harness keeps the spoke inbound limit
  at the full issuance so no launch credit is queued, and a durable job does not wait a day for one.
  Both sides of the eventual release — the hub's and the spoke's own 24-hour queue, the latter over a
  rebuilt ledger under an offset validator clock — are executed in the [integration
  rehearsal](EQUILIBRIUM-ARC-SOLANA.md#the-24-hour-delayed-return-on-the-spoke). Binding a queued
  claim into a launch job's own step machinery is separate work.
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
