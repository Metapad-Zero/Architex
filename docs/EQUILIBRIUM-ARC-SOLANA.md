## Arc ↔ Solana integration rehearsal

Two live environments exchanging the bytes they actually published, with each half of the ledger
read from its own chain. **This is local evidence. No EQUILIBRIUM token, mint, manager,
transceiver, pool or transfer exists on Arc mainnet, Arc testnet, Solana devnet or mainnet-beta,
nothing was funded or broadcast, and no public route is open.** One development guardian key is
substituted into both core bridges, which is precisely why a passing run is not a route proof.

It is the join between the two existing rehearsals: `contracts-equilibrium/test/NttRehearsal.t.sol`
(Arc–Base, one process) and [the Solana spoke](EQUILIBRIUM-SOLANA.md) (one chain, modelled hub).

What it proves is that the route works, not that a launch can be sold across it: it runs straight
through, in one process, with nothing paid for. [Durable launch fulfilment over this
route](EQUILIBRIUM-ARC-SOLANA-FULFILLMENT.md) drives the same two environments underneath a paid,
recoverable job reached over HTTP, and then interrupts it.

### What it adds over those two

The spoke rehearsal could not fail its own reconciliation. It derived Arc circulating supply and
custody from the measured spoke supply against the fixed issuance, because there was no Arc hub to
read, and its record says so (`modelledHubSide: true`). Its peer addresses were generated per run.

Here the hub is real and observed:

| | Spoke rehearsal | This rehearsal |
| --- | --- | --- |
| Hub custody and circulating | derived from the spoke against a constant | read from an Arc ERC20 and its locking manager |
| Arc peer addresses | generated placeholders | the manager and transceiver this run deployed |
| Inbound bytes | constructed by the script "as Arc would have sent them" | taken from the Arc receipt Arc wrote |
| Outbound bytes | decoded and asserted, then discarded | delivered to the Arc transceiver, which released custody |
| Reconciliation | a guard on the script's own arithmetic | two independent observations compared, able to disagree |

### The two environments

| Side | What is real | What is substituted |
| --- | --- | --- |
| Arc | An Anvil fork of Arc testnet (`5042002`, Wormhole `71`) carrying the **deployed Wormhole core bridge** at `0xBB73cB66C26740F31d1FabDC6b7A46a038A300dd`, with the actual pinned `NttManager` and `WormholeTransceiver` (`lib/ntt`, `c636cc15b07969e4b44de7e466c999c07e7387a9`) deployed onto it in locking mode | guardian set 0's single key; the chain is a local fork |
| Solana | The actual pinned NTT manager and transceiver (`lib/ntt-svm`, `1a2a92ef7f289972b2d00dd1d58077d139fe68d7`) and the actual mainnet core bridge binary on a `solana-test-validator` ledger, burning mode | guardian set 0's single key; the cluster is local |

Arc testnet's guardian set 0 really does hold one key (`0x13947Bd48b18E53fdAeEe77F3473391aC727C638`),
and the SVM fixture's guardian set 0 holds one key too. The harness overwrites the Arc one with the
same development key the SVM fixture carries, so a VAA signed once verifies on both. That is the
whole mechanism by which real published bytes can cross, and it is also the whole reason this is
not a public route: on a real route the live Guardian set signs, and it did not sign anything here.

Anvil is used rather than a second forge test because a forge test's chain exists only inside the
test process and cannot exchange messages with a validator running beside it. The contracts are the
same artifacts `FOUNDRY_PROFILE=equilibrium forge build` produces for the Solidity fork test. The
guardian substitution is the same one `WormholeSimulator` makes, written over `anvil_setStorageAt`
instead of a cheatcode and read back through `getGuardianSet` before the run proceeds.

`NttManager` and `WormholeTransceiver` both call `TransceiverStructs` as an external library. Forge
links that automatically; deploying the same artifact over RPC does not, so the harness deploys the
library and splices its address into the `__$…$__` placeholders itself.

### What the rehearsal runs

`scripts/solana/integrate.ts`, in order. Every step reconciles both observed ledgers afterwards.

1. **Negative mint authority.** A burning manager is offered a mint whose authority is still an
   ordinary keypair, and refuses it (`InvalidMintAuthority`). This has to run before the real
   `initialize`, because the config is a PDA of the program and there is exactly one chance to
   offer it a mint it should reject. The refused attempt is confirmed to have created no config.
   The spoke rehearsal read this constraint from the pinned source; here it is executed.
2. **Real peers on both sides.** Arc registers the Solana manager program id and the transceiver's
   emitter PDA; Solana registers the Arc manager and transceiver addresses. No placeholders.
3. **Arc → Solana.** Arc locks the tokens and publishes one message. The bytes are read out of the
   `LogMessagePublished` event, checked field by field against the debit, signed once and posted
   through the core bridge on the validator, then validated, redeemed and released. Arc custody and
   the SPL mint supply are read separately and compared at each point, including while the message
   is in flight.
4. **Refusals on the spoke.** The same VAA re-validated, the same claim released twice, and a body
   that does not match its signature are all refused. Replays are submitted from an unrelated
   funded account, so a refusal is the program rejecting the message and not the cluster rejecting
   a duplicate transaction signature.
5. **Solana → Arc.** Solana burns the representation and publishes its own message. The posted
   account is decoded field by field — not scanned for the payload prefix, because a VAA assembled
   with the wrong sequence is refused for a reason that has nothing to do with the transfer — and
   the resulting VAA is delivered to the Arc transceiver, which unlocks real custody.
   **Round-trip conservation is then observed on both chains**: hub custody back to zero, hub
   circulating back to the full issuance, spoke supply zero. Neither figure is derived from the
   other.
6. **Refusals on the hub.** The same Solana VAA delivered twice (`TransferAlreadyCompleted`), the
   same payload re-signed from an unregistered emitter (`InvalidWormholePeer`), and one flipped bit
   in the signed body (`InvalidVaa`).
7. **Unregistered emitter, on an undelivered message.** Run against a message the spoke has not yet
   seen, so the refusal is `InvalidTransceiverPeer` rather than the message account already
   existing — which would prove something weaker.
8. **Spoke restart.** The validator is `SIGKILL`ed between a claim being approved and credited,
   after the approval has finalized. While it is down **the Arc fork stays up**, so the backing for
   the un-credited claim is read live from a chain that did not crash. The same ledger reopens with
   the claim intact, credits it exactly once, and refuses the repeat.
9. **Hub restart.** The Arc node is killed and reopened from an `anvil_dumpState` snapshot written
   to disk. Custody, the registered peers, the guardian substitution and the consumed-VAA set all
   survive, and the delivery from step 5 is still refused. The snapshot is a **harness** mechanism
   for restarting the fork; it is not a property of Arc.
10. **Eventual rate-limit release on the hub.** A return delivery over the hub's inbound limit is
    queued rather than released, early completion is refused (`InboundQueuedTransferStillQueued`),
    the fork's clock is advanced past the 24-hour duration, the queue entry is completed exactly
    once and a second completion is refused (`InboundQueuedTransferNotFound`).
11. **A claim held by the spoke's own inbound limit.** With the spoke's inbound limit lowered, an
    Arc debit is queued on the Solana side and refused early release (`CantReleaseYet`). The
    boundary the manager wrote is read back and the gap to a `Clock` sysvar reading taken just after
    it is measured, so the delay under test is the program's figure rather than the harness's. The two observed ledgers reconcile with the claim outstanding: the hub holds exactly
    the backing for a representation that has not been minted.
12. **Eventual release on the spoke, and the claim's return to Arc.** The same claim is carried past
    its 24-hour boundary, released, and brought home. See [the delayed
    return](#the-24-hour-delayed-return-on-the-spoke).

### The 24-hour delayed return on the spoke

Step 12 is the half the earlier version of this rehearsal recorded as not executed, because
advancing a Solana validator 24 hours is harder than advancing an EVM fork. Agave's `Clock` sysvar
is the stake-weighted median of the validators' vote timestamps, clamped to 150% of elapsed PoH. It
cannot be set from outside, nothing shortens `RATE_LIMIT_DURATION` without changing the pin, and
`--warp-slot` panics in `solana-test-validator` 2.1.22 before the RPC port opens.

What the clock *is* derived from is `CLOCK_REALTIME` inside the validator's own process: the genesis
creation time, the epoch start timestamp and every vote timestamp. `scripts/solana/clockShift.c` is
a 68-line interposer, built on demand and loaded with `DYLD_INSERT_LIBRARIES`, that offsets that one
source — and only that one. `CLOCK_MONOTONIC` and `mach_absolute_time` are untouched, so PoH, the
timeouts and the validator's scheduling all run at real speed; the single thing that moves is the
date the validator believes it is.

It has to be applied at a genesis. The clamp is measured from the `epoch_start_timestamp` a reopened
ledger brings back with it, so an existing ledger restarted under the offset is pulled straight back
to where it was. A new genesis is only useful if the queue comes with it, so the run dumps every
account the pinned programs wrote — 34 of them, at `finalized` commitment, executable accounts
excluded — and rebuilds the ledger from those bytes with `--account-dir`. Nothing is interpreted or
edited on the way through, and `seedDifferences` compares every rebuilt account against its dump
before anything is released. The claim's release boundary on the advanced ledger is the boundary the
manager itself wrote on the ledger that queued it.

From there the run establishes, all against figures read from the two chains rather than from each
other:

| | What holds |
| --- | --- |
| The delay is the program's | the boundary is measured against a `Clock` reading taken just after the manager took its own, and has to land within 60 seconds of the declared 24 hours |
| Early refusal | `CantReleaseYet`, on the unadvanced ledger, against the manager's own boundary |
| The claim is retained | all 34 seeded accounts byte-identical, same amount, same boundary, across a `SIGKILL` and a ledger rebuild |
| The clock really moved | the spoke's `Clock` sysvar is read on chain and checked to be at least `RATE_LIMIT_DURATION` past the clock that queued the claim |
| Eventual release | the pinned manager releases its own queue entry and mints to the recipient |
| Once only | a second release is refused `TransferAlreadyRedeemed` |
| Authenticated Arc return | the claim is burned, published as a guardian-signed VAA, delivered to the Arc transceiver, and releases real Arc custody |
| Once only after a crash | the validator is `SIGKILL`ed between the burn and the publish; the reopened ledger has not published it unattended, publishes it exactly once, and refuses the repeat `MessageAlreadySent` |
| Replay rejection on the hub | the same VAA redelivered is refused `TransferAlreadyCompleted` |
| Supply | reconciled at every step from the Arc token and its locking manager against the SPL mint and its custody, with the burned-but-unpublished claim carried as `pendingToHub` |

Throughout, the Arc fork stays up. The custody backing a claim the spoke cannot credit yet is a live
read of a chain that never restarted — which is the point of checking the two against each other
across the failure rather than within one process's memory.

### Clock fixtures

Two, and the record carries both in `clockFixtures`:

| Side | Fixture |
| --- | --- |
| Arc | the fork's time advanced `86401` seconds with `evm_increaseTime`, so the hub's inbound queue can be released |
| Solana | the rebuilt spoke ledger's validator process run with `CLOCK_REALTIME` offset `+86460` seconds, as above |

Neither simulates anything about a queue. The entries, their timestamps, the early refusals and the
releases are the pinned managers' own behaviour, and the record keeps three figures apart so none of
them can stand in for another: `delayedReturn.measuredDelaySeconds`, the gap between the boundary the
manager wrote and a `Clock` reading taken just after it took its own;
`delayedReturn.declaredRateLimitDuration`, the constant the pinned program declares; and
`delayedReturn.advancedBySeconds`, the advance the fixture made. The measured gap is deliberately not
computed as `releaseAfter - duration` — that would return the duration whatever the program had
written, and a shortened delay would read as a passing check. It is accepted only within
`measuredDelaySlackSeconds` (60) of the declared duration, which is the slot or two between the two
readings and nothing wider. Every clock manipulation in the
script goes through one helper that records it, so none of them can be quiet.

The Solana fixture needs macOS and `clang`. On a host where it cannot be built, the run says so in
words, records the step as not executed and keeps going, rather than attempting the release against
an unadvanced clock — a refusal there would look like a defect in the manager rather than an absent
fixture.

### What is not executed

- **Guardian authentication.** One development key is substituted into guardian set 0 on both core
  bridges. The real Guardian set signed nothing, in either direction, including the delayed return.
- **Any public route.** See the caveat at the top.

### Reproduce

```bash
git submodule update --init --recursive
bun install --frozen-lockfile
FOUNDRY_PROFILE=equilibrium forge build
bun test src/lib/__tests__/equilibriumArcSolana.test.ts
bun run equilibrium:solana:build   # once; builds the pinned SVM programs
bun run equilibrium:arc-solana
```

Needs `anvil`, `solana-test-validator`, outbound access to `https://rpc.testnet.arc.io`, and the
Solana toolchain for the one-time program build. The spoke clock fixture additionally needs macOS
and `clang`; without them step 12 is recorded as not executed and the rest of the run is unaffected. Ports and ledgers are its own:
`EQUILIBRIUM_ARC_PORT` (default `8645`) and `EQUILIBRIUM_SOLANA_INTEGRATION_PORT` (default `8945`,
faucet `9046`), a fresh temporary ledger directory per run, and `EQUILIBRIUM_SOLANA_KEEP_LEDGER=1`
to keep it. None of these collide with `bun run equilibrium:solana`, which keeps its own port and
ledger, so the two can run side by side.

It writes `output/equilibrium/arc-solana-integration.json`: the fork block and its hash, the
guardian set that was replaced, every deployed address, the full hex of every message that crossed,
the end-state ledger with its reconciliation, the clock fixtures and the list of what was not
executed. That is a local record, not a deployment record.

### What is still missing before a public Arc ↔ Solana route

- **Fresh program ids and a funded deployment** on both sides. The SVM `declare_id!` values are the
  upstream defaults; the Arc addresses here are whatever the fork's deployer nonce produced.
- **The live Guardian set.** Everything above rests on a substituted one-key set.
- **Approved custody** for the SVM upgrade authority, the manager owners and the Arc admin, with a
  tested recovery path, before anything is funded.
- **A devnet/testnet rehearsal** with real Guardian attestation and real finality, at which point
  the fork labels come off one claim at a time and not before.
- **Quote inventory.** NTT moves the canonical token only; the pool and gas assets on both chains
  are a separate decision and stay closed.

See [routes](EQUILIBRIUM-ROUTES.md), [the Solana spoke](EQUILIBRIUM-SOLANA.md) and
[recoverable integration](EQUILIBRIUM-INTEGRATION.md).
