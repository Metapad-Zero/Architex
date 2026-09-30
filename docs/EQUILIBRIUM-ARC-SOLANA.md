## Arc ↔ Solana integration rehearsal

Two live environments exchanging the bytes they actually published, with each half of the ledger
read from its own chain. **This is local evidence. No EQUILIBRIUM token, mint, manager,
transceiver, pool or transfer exists on Arc mainnet, Arc testnet, Solana devnet or mainnet-beta,
nothing was funded or broadcast, and no public route is open.** One development guardian key is
substituted into both core bridges, which is precisely why a passing run is not a route proof.

It is the join between the two existing rehearsals: `contracts-equilibrium/test/NttRehearsal.t.sol`
(Arc–Base, one process) and [the Solana spoke](EQUILIBRIUM-SOLANA.md) (one chain, modelled hub).

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
10. **Eventual rate-limit release.** A return delivery over the hub's inbound limit is queued rather
    than released, early completion is refused (`InboundQueuedTransferStillQueued`), the fork's
    clock is advanced past the 24-hour duration, the queue entry is completed exactly once and a
    second completion is refused (`InboundQueuedTransferNotFound`). The clock advance is the run's
    only clock fixture and is labelled as such.
11. **A claim left in flight.** With the spoke's inbound limit lowered, a final Arc debit is queued
    on the Solana side and refused early release. The run ends with that claim outstanding, and the
    two observed ledgers still reconcile: the hub holds exactly the backing for a representation
    that has not been minted.

### Clock fixtures

Exactly one, and the record carries it in `clockFixtures`: the Arc fork's time is advanced by
`86401` seconds with `evm_increaseTime` so the hub's inbound queue can be released. Nothing else
about the delay is simulated — the queue entry, its timestamp, the early refusal and the release
are the pinned manager's own behaviour. Every clock manipulation in the script goes through one
helper that records it, so none of them can be quiet.

### What is not executed

- **The Solana side of the eventual rate-limit release.** The pinned SVM program hard-codes
  `RATE_LIMIT_DURATION = 24 hours` and reads it against the `Clock` sysvar. Unlike the EVM manager,
  where the duration is a constructor parameter, it cannot be shortened without changing the pin,
  and `solana-test-validator`'s clock tracks the host: `--warp-slot` did not bring a validator up
  on this host. What the run does establish on that side is that the claim is queued with a release
  timestamp, refused early, retained rather than dropped, and backed by observed Arc custody the
  whole time. The equivalent release **is** executed on the hub.
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
Solana toolchain for the one-time program build. Ports and ledgers are its own:
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
