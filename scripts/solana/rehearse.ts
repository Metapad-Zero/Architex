/**
 * LOCAL VALIDATOR REHEARSAL: the actual NTT manager and Wormhole transceiver programs built from
 * the pinned SVM commit, plus the actual mainnet Wormhole core bridge binary, running on a
 * `solana-test-validator` ledger with a substituted one-key guardian set.
 *
 * What it establishes: the burning-spoke configuration is accepted by the real programs, and debit,
 * credit, replay rejection, unauthorized credit rejection, round-trip conservation, a delayed claim
 * and crash recovery behave as the accounting requires.
 *
 * What it does NOT establish: any public route. The guardian set is local, the chain is local, and
 * no mint, manager, pool or transfer exists on devnet or mainnet-beta. This is the SVM counterpart
 * of `contracts-equilibrium/test/NttRehearsal.t.sol`, and carries the same caveat.
 *
 * Run: `bun run equilibrium:solana:build` once, then `bun run equilibrium:solana`.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  Connection, Keypair, PublicKey, SendTransactionError, Transaction, type TransactionInstruction,
} from '@solana/web3.js'
import {
  MAINNET_USDC_MINT, SOLANA_NTT, bytes32, decodeTransceiverMessage, encodeTransceiverMessage,
  managerMessageDigest, pumpSwapPool, reconcileSpoke, toHex, trimAmount,
  type NttManagerMessage, type VaaBody,
} from '../../src/lib/equilibriumSolana'
import {
  BURNING, NttDeployment, decodeConfig, decodeInboxItem, fetchAccount,
} from './nttClient'
import {
  DEV_GUARDIAN_ADDRESS, postVaaInstruction, secp256k1Instruction, serializeVaa, signVaa,
  verifySignaturesInstruction,
} from './wormholeCore'
import {
  approve, createAssociatedTokenAccount, createMintAccount, associatedTokenAddress, initializeMint2,
  readMint, readTokenBalance, setMintAuthority,
} from './splToken'

const ROOT = resolve(import.meta.dirname, '../..')
const SVM = join(ROOT, 'lib/ntt-svm/solana')
const DEPLOY = join(SVM, 'target/deploy')
const FIXTURES = join(SVM, 'programs/example-native-token-transfers/tests/fixtures')
const ACCOUNTS = join(SVM, 'tests/accounts/mainnet')

/** Modelled hub. Arc's canonical issuance is fixed and six-decimal; the spoke starts at zero. */
const ARC_CHAIN = SOLANA_NTT.arcWormholeId
const SOLANA_CHAIN = SOLANA_NTT.solanaWormholeId
const DECIMALS = SOLANA_NTT.decimals
const ISSUANCE = 1_000_000_000_000n
const RATE_LIMIT = ISSUANCE
/** A fractional amount, so a decimals bug cannot pass by cancelling out. */
const TRANSFER = 1_234_567_890n

const RPC_PORT = Number(process.env.EQUILIBRIUM_SOLANA_PORT ?? 8899)
const FAUCET_PORT = RPC_PORT + 101
const RPC_URL = `http://127.0.0.1:${RPC_PORT}`

interface StepRecord { step: string; detail: string; at: string }
const steps: StepRecord[] = []
function record(step: string, detail: string): void {
  const entry = { step, detail, at: new Date().toISOString() }
  steps.push(entry)
  console.log(`  ${step}: ${detail}`)
}
function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Rehearsal assertion failed: ${message}`)
}

/* ------------------------------------------------------------------ validator lifecycle */

let validator: ChildProcess | null = null

function startValidator(ledger: string, reset: boolean, admin: PublicKey): ChildProcess {
  const args = [
    '--ledger', ledger, '--rpc-port', String(RPC_PORT), '--faucet-port', String(FAUCET_PORT),
    '--limit-ledger-size', '10000', '--quiet',
    ...(reset ? ['--reset'] : []),
    // The actual mainnet core bridge binary, with mainnet's config, fee collector and guardian set
    // account; guardian set 0 carries the single development key this rehearsal signs with.
    '--bpf-program', SOLANA_NTT.coreBridge, join(FIXTURES, 'mainnet_core_bridge.so'),
    '--account', '2yVjuQwpsvdsrywzsJJVs9Ueh4zayyo5DYJbBNc3DDpn', join(ACCOUNTS, 'core_bridge_config.json'),
    '--account', '9bFNrXNb2WTx8fMHXCheaZqkLZ3YCCaiqTftHxeintHy', join(ACCOUNTS, 'core_bridge_fee_collector.json'),
    '--account', 'DS7qfSAgYsonPpKoAjcGhX9VFjXdGkiHjEDkTidf8H2P', join(ACCOUNTS, 'guardian_set_0.json'),
    // Upgradeable, because the manager checks its deployer against the program's upgrade authority.
    '--upgradeable-program', SOLANA_NTT.manager, join(DEPLOY, 'example_native_token_transfers.so'), admin.toBase58(),
    '--upgradeable-program', SOLANA_NTT.transceiver, join(DEPLOY, 'ntt_transceiver.so'), admin.toBase58(),
  ]
  const child = spawn('solana-test-validator', args, { cwd: SVM, stdio: ['ignore', 'ignore', 'pipe'] })
  child.stderr?.on('data', (chunk: Buffer) => { process.stderr.write(`    [validator] ${chunk.toString()}`) })
  return child
}

/** Cancels only the process this run started, by its own pid. */
function stopValidator(signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!validator?.pid) return
  try { process.kill(validator.pid, signal) } catch { /* already gone */ }
  validator = null
}

/**
 * A hard kill can only be survived by state the validator has already rooted, so the rehearsal
 * waits for finality before pulling the plug. Killing mid-confirmation would test the test
 * validator's snapshot cadence, not the manager's recovery.
 */
async function awaitFinalized(connection: Connection, signature: string, seconds = 90): Promise<void> {
  const deadline = Date.now() + seconds * 1000
  for (;;) {
    const status = await connection.getSignatureStatus(signature, { searchTransactionHistory: true })
    if (status.value?.confirmationStatus === 'finalized') return
    if (Date.now() > deadline) throw new Error('Transaction did not finalize on the local validator.')
    await new Promise((done) => setTimeout(done, 500))
  }
}

async function awaitConfirmed(connection: Connection, signature: string, seconds = 60): Promise<void> {
  const deadline = Date.now() + seconds * 1000
  for (;;) {
    const status = await connection.getSignatureStatus(signature, { searchTransactionHistory: true })
    if (status.value?.confirmationStatus) return
    if (Date.now() > deadline) throw new Error('Airdrop was not confirmed on the local validator.')
    await new Promise((done) => setTimeout(done, 300))
  }
}

async function waitForHealth(connection: Connection, seconds = 90): Promise<void> {
  const deadline = Date.now() + seconds * 1000
  for (;;) {
    try {
      const slot = await connection.getSlot('confirmed')
      if (slot > 0) return
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error('Local validator did not become healthy.')
    await new Promise((done) => setTimeout(done, 500))
  }
}

/* ------------------------------------------------------------------ transaction helpers */

/**
 * Sends and confirms over HTTP only. `sendAndConfirmTransaction` opens a signature subscription,
 * and this run deliberately kills the validator underneath its client; polling keeps the restart
 * from leaving a websocket reconnecting for the rest of the run.
 */
async function send(connection: Connection, payer: Keypair, instructions: TransactionInstruction[], signers: Keypair[] = []): Promise<string> {
  const transaction = new Transaction().add(...instructions)
  const latest = await connection.getLatestBlockhash('confirmed')
  transaction.recentBlockhash = latest.blockhash
  transaction.feePayer = payer.publicKey
  transaction.sign(payer, ...signers)
  // Preflight first: a rejection surfaces the program's own logs instead of an expiry timeout.
  const simulated = await connection.simulateTransaction(transaction)
  if (simulated.value.err) {
    throw new SendTransactionError({
      action: 'simulate',
      signature: '',
      transactionMessage: `Simulation failed: ${JSON.stringify(simulated.value.err)}`,
      logs: simulated.value.logs ?? [],
    })
  }
  const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true, maxRetries: 5 })
  const deadline = Date.now() + 60_000
  for (;;) {
    const status = await connection.getSignatureStatus(signature, { searchTransactionHistory: true })
    if (status.value?.err) throw new Error(`Transaction ${signature} failed: ${JSON.stringify(status.value.err)}`)
    if (status.value?.confirmationStatus === 'confirmed' || status.value?.confirmationStatus === 'finalized') return signature
    if (Date.now() > deadline) throw new Error(`Transaction ${signature} was not confirmed.`)
    await new Promise((done) => setTimeout(done, 300))
  }
}
/**
 * Records the on-chain refusal rather than swallowing it, so the evidence names the constraint the
 * program enforced. A bare "simulation failed" would not distinguish a rejected replay from a
 * malformed transaction, so the program logs are searched for the error the runtime raised.
 */
async function expectRefusal(label: string, attempt: () => Promise<unknown>): Promise<void> {
  try {
    await attempt()
  } catch (error) {
    record(label, `refused: ${refusalReason(error)}`)
    return
  }
  throw new Error(`Rehearsal assertion failed: ${label} was accepted, and must not be.`)
}
function refusalReason(error: unknown): string {
  const logs = error instanceof SendTransactionError ? error.logs ?? [] : []
  const named = logs.find((line) => /Error Code:|Error Message:|already in use|custom program error/i.test(line))
  const message = error instanceof Error ? error.message.split('\n')[0] : String(error)
  return (named ?? message).trim().slice(0, 200)
}

/* ------------------------------------------------------------------ message construction */

interface Inbound { message: NttManagerMessage; body: VaaBody; digest: Uint8Array }

/**
 * A transfer as the Arc hub's manager would have published it: the hub's manager and transceiver
 * as source and emitter, this Solana manager as the recipient manager.
 */
function inboundTransfer(
  manager: PublicKey, arcManager: Uint8Array, arcTransceiver: Uint8Array,
  recipient: PublicKey, amount: bigint, sequence: bigint, id: string,
): Inbound {
  const message: NttManagerMessage = {
    id: new TextEncoder().encode(id.padEnd(32, '\0')).subarray(0, 32),
    sender: arcManager,
    payload: {
      amount: trimAmount(amount, DECIMALS, DECIMALS),
      sourceToken: arcManager,
      to: bytes32(recipient),
      toChain: SOLANA_CHAIN,
    },
  }
  return {
    message,
    digest: managerMessageDigest(ARC_CHAIN, message),
    body: {
      timestamp: Math.floor(Date.now() / 1000),
      nonce: 0,
      emitterChain: ARC_CHAIN,
      emitterAddress: arcTransceiver,
      sequence,
      consistencyLevel: 0,
      payload: encodeTransceiverMessage({
        sourceNttManager: arcManager,
        recipientNttManager: bytes32(manager),
        managerPayload: message,
        transceiverPayload: new Uint8Array(),
      }),
    },
  }
}

/** Posts a signed VAA through the core bridge: verify the signature, then write the account. */
async function postVaa(connection: Connection, payer: Keypair, deployment: NttDeployment, body: VaaBody): Promise<{ posted: PublicKey; vaa: string }> {
  const signed = signVaa(body)
  const signatureSet = Keypair.generate()
  const guardianSet = deployment.at.guardianSet(0)
  await send(connection, payer, [
    secp256k1Instruction(signed, DEV_GUARDIAN_ADDRESS),
    verifySignaturesInstruction(deployment.coreBridge, payer.publicKey, guardianSet, signatureSet.publicKey),
  ], [signatureSet])
  const posted = deployment.at.postedVaa(signed.hash)
  await send(connection, payer, [
    postVaaInstruction(deployment.coreBridge, payer.publicKey, guardianSet, deployment.at.coreBridgeConfig, signatureSet.publicKey, posted, body),
  ])
  return { posted, vaa: toHex(serializeVaa(signed)) }
}

/* ------------------------------------------------------------------ accounting */

async function supplyOf(connection: Connection, deployment: NttDeployment, pending: bigint) {
  const mint = await readMint(connection, deployment.mint)
  const ledger = {
    issuance: ISSUANCE,
    hubCirculating: ISSUANCE - mint.supply - pending,
    hubCustody: mint.supply + pending,
    spokeSupply: mint.supply,
    pending,
  }
  return { ...ledger, ...reconcileSpoke(ledger), custody: await readTokenBalance(connection, deployment.custody()) }
}

/* ------------------------------------------------------------------ the rehearsal */

async function main(): Promise<void> {
  for (const file of ['example_native_token_transfers.so', 'ntt_transceiver.so']) {
    if (!existsSync(join(DEPLOY, file))) {
      throw new Error(`Missing ${file}. Build the pinned SVM programs first: bun run equilibrium:solana:build`)
    }
  }
  const ledger = mkdtempSync(join(tmpdir(), 'equilibrium-svm-'))
  const payer = Keypair.generate()
  const admin = Keypair.generate()
  // An unrelated funded account. Replays are submitted from here, so a refusal is the program
  // rejecting the message and never the cluster rejecting a duplicate transaction signature.
  const stranger = Keypair.generate()
  // Modelled Arc peers. Placeholders for an undeployed hub, never addresses to publish.
  const arcManager = bytes32(Keypair.generate().publicKey)
  const arcTransceiver = bytes32(Keypair.generate().publicKey)
  const mintKeypair = Keypair.generate()
  const spoke = new NttDeployment(
    new PublicKey(SOLANA_NTT.manager), new PublicKey(SOLANA_NTT.transceiver),
    new PublicKey(SOLANA_NTT.coreBridge), mintKeypair.publicKey,
  )

  console.log(`Local NTT rehearsal, SVM pin ${SOLANA_NTT.commit}`)
  validator = startValidator(ledger, true, admin.publicKey)
  let connection = new Connection(RPC_URL, 'confirmed')
  try {
    await waitForHealth(connection)
    for (const account of [payer, stranger]) {
      const airdrop = await connection.requestAirdrop(account.publicKey, 500_000_000_000)
      await awaitConfirmed(connection, airdrop)
    }
    record('validator', `local ledger at ${RPC_URL}, core bridge ${SOLANA_NTT.coreBridge} with a substituted one-key guardian set`)

    /* 1. A six-decimal mint whose mint authority is the manager's token authority PDA. */
    await send(connection, payer, [
      await createMintAccount(connection, payer.publicKey, mintKeypair.publicKey),
      initializeMint2(mintKeypair.publicKey, DECIMALS, payer.publicKey),
      setMintAuthority(mintKeypair.publicKey, payer.publicKey, spoke.at.tokenAuthority),
      createAssociatedTokenAccount(payer.publicKey, payer.publicKey, mintKeypair.publicKey),
    ], [mintKeypair])
    const created = await readMint(connection, mintKeypair.publicKey)
    assert(created.decimals === DECIMALS, 'mint is not six-decimal')
    assert(created.supply === 0n, 'spoke mint did not start at zero supply')
    assert(created.mintAuthority?.equals(spoke.at.tokenAuthority) === true, 'mint authority is not the manager token authority PDA')
    assert(created.mintAuthority !== null, 'mint authority was renounced')
    record('mint', `${mintKeypair.publicKey.toBase58()} decimals ${created.decimals}, supply 0, mint authority ${spoke.at.tokenAuthority.toBase58()} (token_authority PDA), no freeze authority`)

    /* 2. Burning manager, transceiver, peers and limits. */
    await send(connection, payer, [spoke.initialize(payer.publicKey, admin.publicKey, SOLANA_CHAIN, RATE_LIMIT, BURNING)], [admin])
    await send(connection, payer, [
      spoke.registerTransceiver(payer.publicKey, admin.publicKey),
      spoke.setThreshold(admin.publicKey, 1),
      spoke.setPeer(payer.publicKey, admin.publicKey, ARC_CHAIN, arcManager, RATE_LIMIT, DECIMALS),
      spoke.setWormholePeer(payer.publicKey, admin.publicKey, ARC_CHAIN, arcTransceiver),
    ], [admin])
    const config = decodeConfig(await fetchAccount(connection, spoke.at.config))
    assert(config.mode === BURNING, 'manager is not in burning mode')
    assert(config.chainId === SOLANA_CHAIN, 'manager chain id is not Solana')
    assert(config.threshold === 1, 'threshold is not one transceiver')
    assert(config.owner.equals(admin.publicKey), 'manager owner is not the deployer')
    assert(config.custody.equals(spoke.custody()), 'custody account is not the token authority ATA')
    record('manager', `burning mode, chain ${config.chainId}, owner ${config.owner.toBase58()}, threshold ${config.threshold}, one enabled transceiver, Arc peer ${toHex(arcManager)} at six decimals`)

    const recipientAta = associatedTokenAddress(mintKeypair.publicKey, payer.publicKey)

    /* 3. Inbound credit. */
    const first = inboundTransfer(spoke.manager, arcManager, arcTransceiver, payer.publicKey, TRANSFER, 1n, 'arc-to-solana-1')
    const posted = await postVaa(connection, payer, spoke, first.body)
    await send(connection, payer, [spoke.receiveWormholeMessage(payer.publicKey, posted.posted, ARC_CHAIN, first.message.id)])
    await send(connection, payer, [spoke.redeem(payer.publicKey, ARC_CHAIN, first.message.id, first.digest)])
    const queued = decodeInboxItem(await fetchAccount(connection, spoke.at.inboxItem(first.digest)))
    assert(queued.amount === TRANSFER, 'inbox item amount does not match the wire amount')
    await send(connection, payer, [spoke.releaseInboundMint(payer.publicKey, first.digest, recipientAta, true)])
    let books = await supplyOf(connection, spoke, 0n)
    assert(books.spokeSupply === TRANSFER, 'credit did not mint exactly the transferred amount')
    assert(await readTokenBalance(connection, recipientAta) === TRANSFER, 'recipient did not receive the credit')
    assert(books.custody === 0n, 'custody retained tokens after a credit')
    assert(books.conserved && books.backed, 'supply did not reconcile after the credit')
    record('credit', `VAA ${posted.posted.toBase58()} credited ${TRANSFER} atoms once; spoke supply ${books.spokeSupply}, custody 0, hub backing reconciled`)

    /* 4. Replay of a completed credit, submitted by someone other than the original sender. */
    await expectRefusal('replay: same VAA re-validated', () => send(connection, stranger, [spoke.receiveWormholeMessage(stranger.publicKey, posted.posted, ARC_CHAIN, first.message.id)]))
    await expectRefusal('replay: same claim released twice', () => send(connection, stranger, [spoke.releaseInboundMint(stranger.publicKey, first.digest, recipientAta, true)]))
    books = await supplyOf(connection, spoke, 0n)
    assert(books.spokeSupply === TRANSFER, 'a replay changed the spoke supply')

    /* 5. Authenticated but unauthorized credits. */
    const strangerEmitter = bytes32(Keypair.generate().publicKey)
    const strangerBody = { ...inboundTransfer(spoke.manager, arcManager, strangerEmitter, payer.publicKey, TRANSFER, 2n, 'stranger-emitter').body }
    const strangerPosted = await postVaa(connection, payer, spoke, strangerBody)
    await expectRefusal('unauthorized: guardian-signed VAA from an unregistered emitter', () =>
      send(connection, payer, [spoke.receiveWormholeMessage(payer.publicKey, strangerPosted.posted, ARC_CHAIN, new TextEncoder().encode('stranger-emitter'.padEnd(32, '\0')).subarray(0, 32))]))

    const wrongManager = bytes32(Keypair.generate().publicKey)
    const wrongSource = inboundTransfer(spoke.manager, wrongManager, arcTransceiver, payer.publicKey, TRANSFER, 3n, 'wrong-source-manager')
    const wrongPosted = await postVaa(connection, payer, spoke, wrongSource.body)
    await send(connection, payer, [spoke.receiveWormholeMessage(payer.publicKey, wrongPosted.posted, ARC_CHAIN, wrongSource.message.id)])
    await expectRefusal('unauthorized: message from a manager that is not the registered peer', () =>
      send(connection, payer, [spoke.redeem(payer.publicKey, ARC_CHAIN, wrongSource.message.id, wrongSource.digest)]))

    const tampered = inboundTransfer(spoke.manager, arcManager, arcTransceiver, payer.publicKey, TRANSFER, 4n, 'tampered-body')
    await expectRefusal('unauthorized: guardian signature over a different body', async () => {
      const signed = signVaa(tampered.body)
      const forged = { ...tampered.body, sequence: 99n }
      const signatureSet = Keypair.generate()
      await send(connection, payer, [
        secp256k1Instruction(signed, DEV_GUARDIAN_ADDRESS),
        verifySignaturesInstruction(spoke.coreBridge, payer.publicKey, spoke.at.guardianSet(0), signatureSet.publicKey),
      ], [signatureSet])
      await send(connection, payer, [postVaaInstruction(spoke.coreBridge, payer.publicKey, spoke.at.guardianSet(0), spoke.at.coreBridgeConfig, signatureSet.publicKey, spoke.at.postedVaa(signVaa(forged).hash), forged)])
    })
    books = await supplyOf(connection, spoke, 0n)
    assert(books.spokeSupply === TRANSFER, 'a rejected credit changed the spoke supply')
    record('unauthorized', `three authenticated-but-unauthorized deliveries refused; spoke supply unchanged at ${books.spokeSupply}`)

    /* 6. Outbound debit and its published message. */
    const outboxItem = Keypair.generate()
    const burn = spoke.transferBurn(payer.publicKey, recipientAta, payer.publicKey, outboxItem.publicKey, TRANSFER, ARC_CHAIN, arcManager, false)
    await send(connection, payer, [approve(recipientAta, burn.sessionAuthority, payer.publicKey, TRANSFER), burn.instruction], [outboxItem])
    books = await supplyOf(connection, spoke, TRANSFER)
    assert(books.spokeSupply === 0n, 'the debit did not burn the transferred amount')
    assert(books.custody === 0n, 'custody retained tokens after a debit')
    assert(books.conserved && books.backed, 'supply did not reconcile with the transfer in flight')
    await send(connection, payer, [spoke.releaseWormholeOutbound(payer.publicKey, outboxItem.publicKey, true)])
    const published = await fetchAccount(connection, spoke.at.wormholeMessage(outboxItem.publicKey))
    const start = published.findIndex((_, index) => published[index] === 0x99 && published[index + 1] === 0x45 && published[index + 2] === 0xff && published[index + 3] === 0x10)
    assert(start > 0, 'the core bridge message does not carry a Wormhole NTT transceiver payload')
    const emitted = decodeTransceiverMessage(published.subarray(start))
    assert(emitted.managerPayload.payload.toChain === ARC_CHAIN, 'the published transfer is not addressed to Arc')
    assert(emitted.managerPayload.payload.amount.amount === TRANSFER, 'the published amount does not match the debit')
    assert(emitted.managerPayload.payload.amount.decimals === DECIMALS, 'the published amount was trimmed away from six decimals')
    record('debit', `burned ${TRANSFER} atoms and published one message to Arc: trimmed amount ${emitted.managerPayload.payload.amount.amount} at ${emitted.managerPayload.payload.amount.decimals} decimals, in flight and still backed`)
    await expectRefusal('replay: same outbox item published twice', () => send(connection, stranger, [spoke.releaseWormholeOutbound(stranger.publicKey, outboxItem.publicKey, true)]))

    /* 7. A round trip conserves the issuance exactly. */
    books = await supplyOf(connection, spoke, 0n)
    assert(books.spokeSupply === 0n, 'the completed round trip left supply on the spoke')
    assert(books.hubCirculating === ISSUANCE, 'the completed round trip did not return the issuance to the hub')
    record('round trip', `credit then debit of ${TRANSFER} atoms returned the spoke to zero supply with the full ${ISSUANCE} atom issuance accounted for`)

    /* 8. Crash after the claim is approved and before it is credited. */
    const pending = inboundTransfer(spoke.manager, arcManager, arcTransceiver, payer.publicKey, TRANSFER, 5n, 'crash-recovery')
    const pendingPosted = await postVaa(connection, payer, spoke, pending.body)
    await send(connection, payer, [spoke.receiveWormholeMessage(payer.publicKey, pendingPosted.posted, ARC_CHAIN, pending.message.id)])
    const redeemed = await send(connection, payer, [spoke.redeem(payer.publicKey, ARC_CHAIN, pending.message.id, pending.digest)])
    const beforeCrash = decodeInboxItem(await fetchAccount(connection, spoke.at.inboxItem(pending.digest)))
    assert(beforeCrash.status === 'release_after', 'the approved claim is not awaiting release')
    await awaitFinalized(connection, redeemed)
    stopValidator('SIGKILL')
    await new Promise((done) => setTimeout(done, 3_000))
    validator = startValidator(ledger, false, admin.publicKey)
    // A new client: the previous one's websocket died with the validator it was subscribed to.
    connection = new Connection(RPC_URL, 'confirmed')
    await waitForHealth(connection)
    const afterCrash = decodeInboxItem(await fetchAccount(connection, spoke.at.inboxItem(pending.digest)))
    assert(afterCrash.amount === beforeCrash.amount, 'the claim changed across the restart')
    assert(afterCrash.status === 'release_after', 'the restart lost the approved claim')
    let restarted = await supplyOf(connection, spoke, TRANSFER)
    assert(restarted.spokeSupply === 0n, 'the restart credited a claim on its own')
    await send(connection, payer, [spoke.releaseInboundMint(payer.publicKey, pending.digest, recipientAta, true)])
    restarted = await supplyOf(connection, spoke, 0n)
    assert(restarted.spokeSupply === TRANSFER, 'the recovered claim did not credit exactly once')
    await expectRefusal('restart: recovered claim released twice', () => send(connection, stranger, [spoke.releaseInboundMint(stranger.publicKey, pending.digest, recipientAta, true)]))
    record('restart', `SIGKILL after redeem retained the ${TRANSFER} atom claim; the same ledger reopened, credited it exactly once and refused the repeat`)

    /* 9. A claim above the inbound rate limit is delayed, not lost and not credited early. */
    await send(connection, payer, [spoke.setInboundLimit(admin.publicKey, ARC_CHAIN, 1_000_000n)], [admin])
    const delayed = inboundTransfer(spoke.manager, arcManager, arcTransceiver, payer.publicKey, TRANSFER, 6n, 'rate-limited')
    const delayedPosted = await postVaa(connection, payer, spoke, delayed.body)
    await send(connection, payer, [spoke.receiveWormholeMessage(payer.publicKey, delayedPosted.posted, ARC_CHAIN, delayed.message.id)])
    await send(connection, payer, [spoke.redeem(payer.publicKey, ARC_CHAIN, delayed.message.id, delayed.digest)])
    const held = decodeInboxItem(await fetchAccount(connection, spoke.at.inboxItem(delayed.digest)))
    const now = BigInt(Math.floor(Date.now() / 1000))
    assert(held.status === 'release_after' && held.releaseAfter !== null && held.releaseAfter > now, 'the rate-limited claim was not delayed')
    await expectRefusal('rate limit: delayed claim released early', () => send(connection, stranger, [spoke.releaseInboundMint(stranger.publicKey, delayed.digest, recipientAta, true)]))
    const afterDelay = await supplyOf(connection, spoke, TRANSFER)
    assert(afterDelay.spokeSupply === TRANSFER, 'the delayed claim credited before its release time')
    record('rate limit', `a ${TRANSFER} atom claim over a 1,000,000 atom inbound limit was queued until ${held.releaseAfter?.toString() ?? 'unknown'} and refused early release; the claim is retained, not dropped`)

    /* 10. Measured account sizes, so the deployment preview prices what was actually created. */
    const sized: Record<string, PublicKey> = {
      mint: mintKeypair.publicKey, custody: spoke.custody(), recipientTokenAccount: recipientAta,
      managerConfig: spoke.at.config, outboxRateLimit: spoke.at.outboxRateLimit,
      inboxRateLimit: spoke.at.inboxRateLimit(ARC_CHAIN), managerPeer: spoke.at.peer(ARC_CHAIN),
      registeredTransceiver: spoke.at.registeredTransceiver(spoke.transceiver),
      transceiverPeer: spoke.at.transceiverPeer(ARC_CHAIN),
      transceiverMessage: spoke.at.transceiverMessage(ARC_CHAIN, first.message.id),
      inboxItem: spoke.at.inboxItem(first.digest), outboxItem: outboxItem.publicKey,
      wormholeMessage: spoke.at.wormholeMessage(outboxItem.publicKey), postedVaa: posted.posted,
    }
    const accountSizes: Record<string, number> = {}
    for (const [name, address] of Object.entries(sized)) accountSizes[name] = (await fetchAccount(connection, address)).length
    record('sizes', `measured ${Object.keys(accountSizes).length} created accounts, ${Object.values(accountSizes).reduce((sum, size) => sum + size, 0)} bytes in total`)

    /* 11. The existing-mint pool path, derived and left closed. */
    const pool = pumpSwapPool(0, payer.publicKey, mintKeypair.publicKey, MAINNET_USDC_MINT)
    record('pool', `PumpSwap existing-mint path derived and NOT opened: index 0, base ${mintKeypair.publicKey.toBase58()}, quote ${MAINNET_USDC_MINT.toBase58()}, pool ${pool.pool.toBase58()}, global config ${pool.globalConfig.toBase58()}`)

    const result = {
      observedAt: new Date().toISOString(),
      mode: 'local' as const,
      claim: 'Local validator rehearsal with the pinned NTT programs and a substituted one-key guardian set. Not a public route, not a devnet or mainnet deployment, no funds moved.',
      pin: { svmCommit: SOLANA_NTT.commit, svmVersion: SOLANA_NTT.version, evmCommit: 'c636cc15b07969e4b44de7e466c999c07e7387a9', evmVersion: 'v2.0.0+evm' },
      programs: { manager: SOLANA_NTT.manager, transceiver: SOLANA_NTT.transceiver, coreBridge: SOLANA_NTT.coreBridge },
      spoke: { mint: mintKeypair.publicKey.toBase58(), decimals: DECIMALS, mode: 'burning', tokenAuthority: spoke.at.tokenAuthority.toBase58(), custody: spoke.custody().toBase58(), config: spoke.at.config.toBase58() },
      peers: { arcChain: ARC_CHAIN, arcManager: toHex(arcManager), arcTransceiver: toHex(arcTransceiver), note: 'Modelled hub addresses generated for this run. No Arc deployment exists.' },
      pool: { venue: 'PumpSwap existing mint', open: false, index: 0, quote: MAINNET_USDC_MINT.toBase58(), pool: pool.pool.toBase58(), globalConfig: pool.globalConfig.toBase58() },
      accountSizes,
      programBytes: {
        manager: statSync(join(DEPLOY, 'example_native_token_transfers.so')).size,
        transceiver: statSync(join(DEPLOY, 'ntt_transceiver.so')).size,
      },
      publicRouteTested: false,
      steps,
    }
    const out = join(ROOT, 'output/equilibrium')
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'solana-rehearsal.json'), `${JSON.stringify(result, null, 2)}\n`)
    console.log(`\nAll checks passed. Record written to output/equilibrium/solana-rehearsal.json`)
  } finally {
    stopValidator()
    if (!process.env.EQUILIBRIUM_SOLANA_KEEP_LEDGER) rmSync(ledger, { recursive: true, force: true })
  }
}

await main()
