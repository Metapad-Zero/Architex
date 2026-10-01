## Solana spoke: adapter and local validator rehearsal

The Solana side of the EQUILIBRIUM route, exercised against the actual Wormhole NTT programs on a
local validator. **This is local evidence. No EQUILIBRIUM mint, manager, transceiver or pool exists
on devnet or mainnet-beta, nothing was funded, signed for a public cluster or broadcast, and no
public route is open.** It is the SVM counterpart of `contracts-equilibrium/test/NttRehearsal.t.sol`
and carries the same caveat.

The hub side of this rehearsal is modelled. Where that matters below, the observed version is in
[the Arc–Solana integration rehearsal](EQUILIBRIUM-ARC-SOLANA.md), which runs an Arc fork and this
validator side by side and exchanges their real published bytes.

### Pins

| Piece | Pin |
| --- | --- |
| SVM NTT source | `lib/ntt-svm`, tag `v3.0.0+solana`, commit `1a2a92ef7f289972b2d00dd1d58077d139fe68d7` |
| EVM NTT source | `lib/ntt`, tag `v2.0.0+evm`, commit `c636cc15b07969e4b44de7e466c999c07e7387a9` |
| Toolchain | platform-tools `v1.41` (rustc 1.75), the release matching the pin's declared solana 1.18.26 |
| Core bridge | `worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth`, the mainnet binary checked into the pin's fixtures |

The two pins are separate submodules of the same repository, so the deployed EVM rehearsal keeps
building byte for byte against its own pin while the SVM work moves independently.

The default platform-tools (`v1.43`, rustc 1.79) cannot build this commit: its `Cargo.lock` pins
`ahash 0.7.7`, which gates on the `stdsimd` feature rustc removed in 1.78. `scripts/solana/build-programs.sh`
requests `v1.41` rather than bumping the dependency, so the lockfile stays exactly as pinned.

### Compatibility with the EVM pin

A transfer only survives the hop if both sides read the same bytes. Each pin ships the same wire
fixture for its own tests, and `src/lib/__tests__/equilibriumSolana.test.ts` decodes both with this
codec and re-encodes each to its original hex. The two fixtures differ in one field, the chain the
test transfer is addressed to; the encoding is identical. Six decimals sit inside NTT's eight
decimal wire cap, so an EQUILIBRIUM transfer between two six-decimal peers carries no dust in either
direction.

### What the rehearsal runs

`scripts/solana/rehearse.ts` starts `solana-test-validator` with the built manager and transceiver
as upgradeable programs, the mainnet core bridge binary, and mainnet's bridge config, fee collector
and guardian set 0 accounts. Guardian set 0 in that fixture holds a single key: Wormhole's published
development key, which the rehearsal signs with. **A substituted one-key guardian set is exactly why
this is not a route proof.** A real transfer needs the live Guardian set to observe and sign it.

1. **Six-decimal mint with manager-PDA authority.** A classic SPL mint is created at six decimals
   with zero supply and no freeze authority, then its mint authority is handed to the manager's
   `token_authority` PDA before `initialize`. The program checks that constraint itself in burning
   mode (`InvalidMintAuthority`). The rehearsal satisfies that constraint; it does not run the
   negative case, so that refusal is read from the pinned source rather than executed here. The
   [integration rehearsal](EQUILIBRIUM-ARC-SOLANA.md) executes it.
2. **Burning manager and peers.** `initialize` in burning mode on Wormhole chain 1, one registered
   transceiver, threshold 1, an Arc peer at chain 71 registered on both the manager and the
   transceiver. The written config is read back and asserted, including that the deployer is the
   program's upgrade authority, which the program enforces.
3. **Credit.** A guardian-signed VAA is posted through the core bridge, validated by the
   transceiver, redeemed and released. The mint supply rises by exactly the transferred atoms, the
   recipient receives them, custody ends at zero, and the supply reconciles against hub backing.
4. **Replay.** The same VAA re-validated, and the same claim released a second time, are both
   refused (`TransferAlreadyRedeemed`). Replays are submitted from an unrelated funded account, so a
   refusal is the program rejecting the message and never the cluster rejecting a duplicate
   transaction signature.
5. **Authenticated but unauthorized credits.** Three deliveries that a guardian did sign are still
   refused: one from an emitter that is not the registered transceiver peer
   (`InvalidTransceiverPeer`), one whose source manager is not the registered manager peer
   (`InvalidNttManagerPeer`), and one whose body does not match the verified signature set, which
   the core bridge refuses to post. The spoke supply does not move.
6. **Debit.** An approved session authority burns the tokens and records an outbox item; the
   published core bridge message is read back and decoded, and its trimmed amount, decimals and
   destination chain are asserted against the debit. A second publication of the same outbox item is
   refused (`MessageAlreadySent`).
7. **Round-trip conservation, spoke side.** After a credit and a matching debit the spoke is back to
   zero measured supply, zero recipient balance and zero custody. The hub half of the conservation
   claim is **modelled, not observed**: no Arc hub exists to read, so the rehearsal derives hub
   circulating and custody from the measured spoke supply against the fixed issuance. That makes
   `reconcileSpoke` unable to fail on its own in the rehearsal, and passing it there is not
   independent evidence. The invariant itself is unit-tested against cases that do fail, and the
   record carries `modelledHubSide: true`.
8. **Restart recovery.** The validator is `SIGKILL`ed after a claim is approved and finalized but
   before it is credited. The same ledger is reopened: the claim is still there with the same
   amount, the restart credited nothing on its own, releasing it afterwards credits exactly once,
   and a repeat is refused.
9. **Rate-limited claim.** A claim above the inbound limit is queued with a release timestamp rather
   than dropped, and an early release is refused (`CantReleaseYet`). The claim is retained.

Every refusal in the record names the constraint that held rather than a generic simulation failure.
Most are Anchor error numbers from the manager. One is not: re-validating an already-delivered VAA is
refused by the runtime with `Allocate ... already in use`, because the validated-message account is a
PDA of the message id and already exists. That is the same guarantee reached a different way, and it
is worth reading as such rather than as an NTT check.

### The pool path stays closed

PumpSwap's `create_pool` accepts a mint that already exists, which is what keeps the spoke one asset
rather than a fifth Pump coin. The rehearsal derives the pool address for the spoke mint against
mainnet USDC and stops there. Nothing is created and no quote inventory is moved. The index is part
of the pool address, so a second index is a second pool for the same pair and has to be pinned
before anything is submitted. `pumpSwapPool`'s global config derivation is checked against the
account observed on mainnet; the pool seeds themselves come from PumpSwap's published instruction
reference and are not confirmed against an observed address, so treat that address as a preview.

### Deployment preview

`bun run equilibrium:solana:preview` prices a deployment without touching one. Program and account
sizes come from the rehearsal, which measured what the actual programs created; rent and the
Wormhole message fee are read live from the named cluster. At mainnet-beta rent it is about
**13.46 SOL** of one-time rent and about **26.89 SOL** at peak, because `solana program deploy`
holds an upload buffer the same size as the program data until the deploy completes. The Wormhole
message fee is 100 lamports per published transfer.

The preview names four signers and what each can still do afterwards. The program upgrade authority
is the strongest key: it signs both deploys, signs `initialize` as the manager's `deployer`, and can
replace either program at will. The manager owner can add peers, change the threshold, pause the
spoke and change rate limits. The temporary mint authority can do nothing after it hands the mint to
the PDA. Its recovery section covers a claim that survived a crash, a debit whose message was never
published, a stranded upload buffer, and what losing each key costs.

### Reproduce

```bash
git submodule update --init --recursive
bun install --frozen-lockfile
bun test src/lib/__tests__/equilibriumSolana.test.ts
bun run equilibrium:solana:build
bun run equilibrium:solana
bun run equilibrium:solana:preview
```

The build needs the Solana toolchain (`cargo-build-sbf`, from a solana CLI install) and rustup's
`cargo` shim on `PATH`; the rehearsal needs `solana-test-validator`. The rehearsal binds
`127.0.0.1:8899` by default; set `EQUILIBRIUM_SOLANA_PORT` if that is taken, and
`EQUILIBRIUM_SOLANA_KEEP_LEDGER=1` to keep the ledger directory for inspection. It writes
`output/equilibrium/solana-rehearsal.json`, and the preview writes
`output/equilibrium/solana-deployment-preview-<cluster>.json`. Both are local records, not
deployment records.

### What is still missing before a public Solana route

- **Fresh program ids.** The pinned `declare_id!` values are the upstream defaults and are not
  deployed anywhere. Each deployment rebuilds the programs against its own generated keypairs.
- **An Arc hub.** The peer addresses the rehearsal registers are generated per run. A real
  `set_peer` needs the deployed Arc manager and transceiver addresses, and the hub has to be locking
  where this spoke is burning.
- **Approved custody** for the upgrade authority and the manager owner, and a tested recovery path
  for both, before anything is funded.
- **A devnet rehearsal.** Wormhole's SVM guide uses Solana devnet, not Solana testnet, for NTT token
  creation. A public rehearsal goes there first.
- **An observed hub side on a public chain.** Against an Arc *fork* running the real pinned locking
  manager, hub custody is now read rather than derived; see
  [the integration rehearsal](EQUILIBRIUM-ARC-SOLANA.md). A deployed Arc hub is still missing, so
  the cross-chain half of supply conservation stays fork evidence.
- **Quote inventory.** NTT moves the canonical token only. USDC for the pool and SOL for gas have to
  be pre-positioned; SVM CCTP is a separate decision and stays closed.

See [routes](EQUILIBRIUM-ROUTES.md), [recoverable integration](EQUILIBRIUM-INTEGRATION.md) and the
[release preview](../public/equilibrium-release-preview.md).
