/**
 * ARC ↔ SOLANA INTEGRATION REHEARSAL: two live environments exchanging the bytes they actually
 * published, with both halves of the ledger read from their own chain.
 *
 * The Arc side is an Anvil fork of Arc testnet carrying the real deployed Wormhole core bridge, on
 * which this run deploys the actual pinned NTT locking manager and Wormhole transceiver
 * (`lib/ntt`, c636cc15b07969e4b44de7e466c999c07e7387a9). The Solana side is the actual pinned NTT
 * manager and transceiver programs (`lib/ntt-svm`, 1a2a92ef7f289972b2d00dd1d58077d139fe68d7) plus
 * the actual mainnet core bridge binary on a `solana-test-validator` ledger.
 *
 * What it establishes that `scripts/solana/rehearse.ts` could not: the hub side is observed rather
 * than modelled. The spoke rehearsal derived Arc custody and circulating supply from the measured
 * spoke supply against the fixed issuance, so its reconciliation could not fail. Here the hub
 * figures are read from an Arc ERC20 and its locking manager, the spoke figures from an SPL mint
 * and its custody account, and the two are compared. The messages are not reconstructed either:
 * each direction takes the bytes out of the receipt or account the publishing side wrote.
 *
 * What it does NOT establish: any public route. One development guardian key is substituted into
 * both core bridges, the Arc chain is a local fork and the Solana cluster is local. No mint,
 * manager, transceiver, pool or transfer exists on Arc mainnet, devnet or mainnet-beta, and no
 * funds move. Every clock fixture is labelled CLOCK FIXTURE in the console output and carried as
 * `clockFixtures` in the record.
 *
 * Run: `bun run equilibrium:solana:build` once, then `bun run equilibrium:arc-solana`.
 */
import { type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import type { Abi, Address, Hex } from 'viem'
import {
  SOLANA_NTT, bytes32, decodeTransceiverMessage, encodeNttManagerMessage, managerMessageDigest,
  toHex, trimAmount, type NttManagerMessage, type VaaBody,
} from '../../src/lib/equilibriumSolana'
import {
  decodePostedMessage, describeRoute, evmToWormholeFormat, reconcileRoute,
  type ObservedRoute,
} from '../../src/lib/equilibriumArcSolana'
import {
  ARC_TESTNET, artifact, call, connect, deploy, dumpState, increaseTime, linkLibraries, loadState,
  overrideGuardianSet, publishedMessage, revertReason, startAnvil, stopAnvil, waitForAnvil,
} from './arcFork'
import { BURNING, LOCKING, NttDeployment, decodeConfig, decodeInboxItem, fetchAccount } from './nttClient'
import {
  awaitConfirmed, awaitFinalized, postVaa, refusalReason, send, startValidator, stopValidator,
  waitForHealth,
} from './localValidator'
import {
  DEV_GUARDIAN_ADDRESS, postVaaInstruction, secp256k1Instruction, serializeVaa, signVaa,
  verifySignaturesInstruction,
} from './wormholeCore'
import {
  approve, associatedTokenAddress, createAssociatedTokenAccount, createMintAccount, initializeMint2,
  readMint, readTokenBalance, setMintAuthority,
} from './splToken'

const ROOT = resolve(import.meta.dirname, '../..')
const SVM = join(ROOT, 'lib/ntt-svm/solana')
const DEPLOY = join(SVM, 'target/deploy')

const ARC_CHAIN = SOLANA_NTT.arcWormholeId
const SOLANA_CHAIN = SOLANA_NTT.solanaWormholeId
const DECIMALS = SOLANA_NTT.decimals
/** Fixed canonical issuance in six-decimal atoms. `EquilibriumCanonical` takes a uint64. */
const ISSUANCE = 1_000_000_000_000n
/** Fractional amounts, so a decimals bug cannot pass by cancelling out. */
const OUTBOUND = 1_234_567_890n
const SECOND = 987_654_321n
const DELAYED = 55_555_555n
/** The hub manager's inbound queue delay. The pinned SVM program hard-codes the same 24 hours. */
const RATE_LIMIT_DURATION = 86_400

const ARC_PORT = Number(process.env.EQUILIBRIUM_ARC_PORT ?? 8645)
const RPC_PORT = Number(process.env.EQUILIBRIUM_SOLANA_INTEGRATION_PORT ?? 8945)
const FAUCET_PORT = RPC_PORT + 101
const RPC_URL = `http://127.0.0.1:${RPC_PORT}`

const VALIDATOR_AT = {
  cwd: SVM,
  deploy: DEPLOY,
  fixtures: join(SVM, 'programs/example-native-token-transfers/tests/fixtures'),
  accounts: join(SVM, 'tests/accounts/mainnet'),
}

/* ------------------------------------------------------------------ recording */

interface StepRecord { step: string; detail: string; at: string }
const steps: StepRecord[] = []
const clockFixtures: string[] = []
function record(step: string, detail: string): void {
  steps.push({ step, detail, at: new Date().toISOString() })
  console.log(`  ${step}: ${detail}`)
}
/** Every clock manipulation goes through here, so none of them can be quiet. */
function clockFixture(what: string): void {
  clockFixtures.push(what)
  record('CLOCK FIXTURE', what)
}
function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Rehearsal assertion failed: ${message}`)
}
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index])
}

async function expectSvmRefusal(label: string, attempt: () => Promise<unknown>): Promise<void> {
  try {
    await attempt()
  } catch (error) {
    record(label, `refused on Solana: ${refusalReason(error)}`)
    return
  }
  throw new Error(`Rehearsal assertion failed: ${label} was accepted on Solana, and must not be.`)
}
async function expectArcRefusal(label: string, attempt: () => Promise<unknown>): Promise<void> {
  try {
    await attempt()
  } catch (error) {
    record(label, `refused on Arc: ${revertReason(error)}`)
    return
  }
  throw new Error(`Rehearsal assertion failed: ${label} was accepted on Arc, and must not be.`)
}

/* ------------------------------------------------------------------ ABIs */

/**
 * The full compiled ABIs, used for every state-changing call: they declare the contracts' custom
 * errors, which is what lets a refusal be recorded by name instead of as a four-byte signature.
 * The small typed fragments below are for reads, where the literal types are worth having.
 */
const managerContract = artifact('NttManager').abi
const transceiverContract = artifact('WormholeTransceiver').abi
const tokenContract = artifact('EquilibriumToken', 'EquilibriumCanonical').abi


const erc20Abi = [
  { type: 'function', name: 'totalSupply', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'approve', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'decimals', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' },
] as const satisfies Abi

const managerAbi = [
  { type: 'function', name: 'initialize', inputs: [], outputs: [], stateMutability: 'payable' },
  { type: 'function', name: 'setPeer', inputs: [{ type: 'uint16' }, { type: 'bytes32' }, { type: 'uint8' }, { type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'setTransceiver', inputs: [{ type: 'address' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'setThreshold', inputs: [{ type: 'uint8' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'setOutboundLimit', inputs: [{ type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'setInboundLimit', inputs: [{ type: 'uint256' }, { type: 'uint16' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'transfer', inputs: [{ type: 'uint256' }, { type: 'uint16' }, { type: 'bytes32' }], outputs: [{ type: 'uint64' }], stateMutability: 'payable' },
  { type: 'function', name: 'completeInboundQueuedTransfer', inputs: [{ type: 'bytes32' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'getMode', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' },
  { type: 'function', name: 'chainId', inputs: [], outputs: [{ type: 'uint16' }], stateMutability: 'view' },
  { type: 'function', name: 'getThreshold', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' },
  { type: 'function', name: 'rateLimitDuration', inputs: [], outputs: [{ type: 'uint64' }], stateMutability: 'view' },
  {
    // `amount` is a TrimmedAmount: a uint72 packing the amount above its decimals byte.
    type: 'function', name: 'getInboundQueuedTransfer', inputs: [{ type: 'bytes32' }], stateMutability: 'view',
    outputs: [{
      type: 'tuple',
      components: [
        { type: 'uint72', name: 'amount' }, { type: 'uint64', name: 'txTimestamp' },
        { type: 'address', name: 'recipient' },
      ],
    }],
  },
] as const satisfies Abi

const transceiverAbi = [
  { type: 'function', name: 'initialize', inputs: [], outputs: [], stateMutability: 'payable' },
  { type: 'function', name: 'setWormholePeer', inputs: [{ type: 'uint16' }, { type: 'bytes32' }], outputs: [], stateMutability: 'payable' },
  { type: 'function', name: 'receiveMessage', inputs: [{ type: 'bytes' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'getWormholePeer', inputs: [{ type: 'uint16' }], outputs: [{ type: 'bytes32' }], stateMutability: 'view' },
] as const satisfies Abi

/* ------------------------------------------------------------------ message helpers */

/**
 * The manager message exactly as the publishing side encoded it. Re-encoding the decoded form and
 * checking it against the original slice is what makes the digest trustworthy: the inbox item and
 * the inbound queue are both keyed by that digest, so a codec that round-trips imperfectly would
 * silently address the wrong claim.
 */
function managerMessageFrom(payload: Uint8Array): { message: NttManagerMessage; digest: (fromChain: number) => Uint8Array } {
  const decoded = decodeTransceiverMessage(payload)
  const managerLength = (payload[68] << 8) | payload[69]
  const raw = payload.subarray(70, 70 + managerLength)
  const reencoded = encodeNttManagerMessage(decoded.managerPayload)
  assert(sameBytes(raw, reencoded), 'the manager message does not re-encode to the bytes that were published')
  return {
    message: decoded.managerPayload,
    digest: (fromChain: number) => managerMessageDigest(fromChain, decoded.managerPayload),
  }
}

/** A VAA body over bytes that were published, not bytes this script decided to send. */
function vaaBody(
  timestamp: number, emitterChain: number, emitterAddress: Uint8Array,
  sequence: bigint, nonce: number, consistencyLevel: number, payload: Uint8Array,
): VaaBody {
  return { timestamp, nonce, emitterChain, emitterAddress, sequence, consistencyLevel, payload }
}

/* ------------------------------------------------------------------ the rehearsal */

let validator: ChildProcess | null = null
let anvil: ChildProcess | null = null

async function main(): Promise<void> {
  for (const file of ['example_native_token_transfers.so', 'ntt_transceiver.so']) {
    if (!existsSync(join(DEPLOY, file))) {
      throw new Error(`Missing ${file}. Build the pinned SVM programs first: bun run equilibrium:solana:build`)
    }
  }

  const ledger = mkdtempSync(join(tmpdir(), 'equilibrium-arc-svm-'))
  const stateFile = join(ledger, 'arc-fork-state.hex')
  const payer = Keypair.generate()
  const admin = Keypair.generate()
  // An unrelated funded account. Replays are submitted from here, so a refusal is the program
  // rejecting the message and never the cluster rejecting a duplicate transaction signature.
  const stranger = Keypair.generate()
  const mintKeypair = Keypair.generate()
  const spoke = new NttDeployment(
    new PublicKey(SOLANA_NTT.manager), new PublicKey(SOLANA_NTT.transceiver),
    new PublicKey(SOLANA_NTT.coreBridge), mintKeypair.publicKey,
  )

  console.log(`Arc–Solana integration rehearsal: EVM pin c636cc1, SVM pin ${SOLANA_NTT.commit}`)

  let arc = connect(ARC_PORT)
  let connection = new Connection(RPC_URL, 'confirmed')
  try {
    /* ---------------------------------------------------------- 1. the Arc fork */

    anvil = startAnvil(ARC_PORT)
    await waitForAnvil(arc.publicClient)
    const forkBlock = await arc.publicClient.getBlock({ blockTag: 'latest' })
    assert(await arc.publicClient.getChainId() === ARC_TESTNET.evmChainId, 'the fork is not Arc testnet')
    const coreCode = await arc.publicClient.getCode({ address: ARC_TESTNET.coreBridge })
    assert((coreCode?.length ?? 0) > 2, 'the Arc core bridge has no code on this fork')
    const substituted = await overrideGuardianSet(arc.publicClient, ARC_TESTNET.coreBridge, `0x${DEV_GUARDIAN_ADDRESS}`)
    record('arc fork', `Arc testnet ${ARC_TESTNET.evmChainId} forked at block ${forkBlock.number} (${forkBlock.hash}), real core bridge ${ARC_TESTNET.coreBridge}; guardian set ${substituted.index} substituted from ${substituted.replaced.join(', ')} to the one development key both sides sign with`)

    /* ---------------------------------------------------------- 2. the Arc hub */

    const hub = await deploy(arc, artifact('EquilibriumToken', 'EquilibriumCanonical'), ['Equilibrium', 'EQL', arc.account, ISSUANCE])
    // The manager and the transceiver call TransceiverStructs as an external library, so it has to
    // exist on the fork before either can be deployed.
    const structs = await deploy(arc, artifact('TransceiverStructs'))
    const libraries = { TransceiverStructs: structs }
    const managerImpl = await deploy(arc, linkLibraries(artifact('NttManager'), libraries), [hub, LOCKING, ARC_CHAIN, BigInt(RATE_LIMIT_DURATION), false])
    const hubManager = await deploy(arc, artifact('ERC1967Proxy'), [managerImpl, '0x'])
    await call(arc, hubManager, managerContract, 'initialize')
    await call(arc, hubManager, managerContract, 'setOutboundLimit', [ISSUANCE])
    const transceiverImpl = await deploy(arc, linkLibraries(artifact('WormholeTransceiver'), libraries), [hubManager, ARC_TESTNET.coreBridge, 0, 0, 0, '0x0000000000000000000000000000000000000000'])
    const hubTransceiver = await deploy(arc, artifact('ERC1967Proxy'), [transceiverImpl, '0x'])
    await call(arc, hubTransceiver, transceiverContract, 'initialize')
    await call(arc, hubManager, managerContract, 'setTransceiver', [hubTransceiver])
    await call(arc, hubManager, managerContract, 'setThreshold', [1])

    // Read back what was actually configured, rather than trusting that the setters above landed.
    const hubState = { address: hubManager, abi: managerAbi } as const
    assert(await arc.publicClient.readContract({ ...hubState, functionName: 'getMode' }) === LOCKING, 'the Arc manager is not in locking mode')
    assert(await arc.publicClient.readContract({ ...hubState, functionName: 'chainId' }) === ARC_CHAIN, 'the Arc manager does not report Wormhole chain 71')
    assert(await arc.publicClient.readContract({ ...hubState, functionName: 'getThreshold' }) === 1, 'the Arc manager threshold is not one transceiver')
    assert(await arc.publicClient.readContract({ ...hubState, functionName: 'rateLimitDuration' }) === BigInt(RATE_LIMIT_DURATION), 'the Arc manager rate limit duration is not 24 hours')
    assert(await arc.publicClient.readContract({ address: hub, abi: erc20Abi, functionName: 'decimals' }) === DECIMALS, 'the Arc token is not six-decimal')
    record('arc hub', `EquilibriumCanonical ${hub} with a fixed ${ISSUANCE} atom issuance; locking NttManager ${hubManager}, WormholeTransceiver ${hubTransceiver}, threshold 1, 24h rate limit duration`)

    /* ---------------------------------------------------------- 3. the Solana spoke */

    validator = startValidator(VALIDATOR_AT, ledger, { rpc: RPC_PORT, faucet: FAUCET_PORT }, true, admin.publicKey)
    await waitForHealth(connection)
    for (const account of [payer, stranger]) {
      await awaitConfirmed(connection, await connection.requestAirdrop(account.publicKey, 500_000_000_000))
    }

    // The negative mint-authority case, which has to run before the real initialize: the config is
    // a PDA of the program, so there is exactly one chance to offer the manager a mint it should
    // refuse. A burning manager that accepted a mint it cannot control would issue claims it could
    // never honour.
    const unownedMint = Keypair.generate()
    await send(connection, payer, [
      await createMintAccount(connection, payer.publicKey, unownedMint.publicKey),
      initializeMint2(unownedMint.publicKey, DECIMALS, payer.publicKey),
    ], [unownedMint])
    const wrongAuthority = new NttDeployment(spoke.manager, spoke.transceiver, spoke.coreBridge, unownedMint.publicKey)
    await expectSvmRefusal('authority: burning manager initialized over a mint it does not control', () =>
      send(connection, payer, [wrongAuthority.initialize(payer.publicKey, admin.publicKey, SOLANA_CHAIN, ISSUANCE, BURNING)], [admin]))
    assert((await connection.getAccountInfo(spoke.at.config, 'confirmed')) === null, 'the refused initialize still created a manager config')

    await send(connection, payer, [
      await createMintAccount(connection, payer.publicKey, mintKeypair.publicKey),
      initializeMint2(mintKeypair.publicKey, DECIMALS, payer.publicKey),
      setMintAuthority(mintKeypair.publicKey, payer.publicKey, spoke.at.tokenAuthority),
      createAssociatedTokenAccount(payer.publicKey, payer.publicKey, mintKeypair.publicKey),
    ], [mintKeypair])
    const created = await readMint(connection, mintKeypair.publicKey)
    assert(created.decimals === DECIMALS && created.supply === 0n, 'the spoke mint is not a zero-supply six-decimal mint')
    assert(created.mintAuthority?.equals(spoke.at.tokenAuthority) === true, 'mint authority is not the manager token authority PDA')

    await send(connection, payer, [spoke.initialize(payer.publicKey, admin.publicKey, SOLANA_CHAIN, ISSUANCE, BURNING)], [admin])
    await send(connection, payer, [
      spoke.registerTransceiver(payer.publicKey, admin.publicKey),
      spoke.setThreshold(admin.publicKey, 1),
    ], [admin])
    const config = decodeConfig(await fetchAccount(connection, spoke.at.config))
    assert(config.mode === BURNING && config.chainId === SOLANA_CHAIN && config.threshold === 1, 'the Solana manager is not a one-transceiver burning spoke')
    record('solana spoke', `mint ${mintKeypair.publicKey.toBase58()} at ${DECIMALS} decimals under the ${spoke.at.tokenAuthority.toBase58()} token_authority PDA; burning manager ${spoke.manager.toBase58()}, transceiver ${spoke.transceiver.toBase58()}, emitter ${spoke.at.emitter.toBase58()}`)

    /* ---------------------------------------------------------- 4. real peers on both sides */

    const solanaManagerPeer = bytes32(spoke.manager)
    const solanaEmitterPeer = bytes32(spoke.at.emitter)
    await call(arc, hubManager, managerContract, 'setPeer', [SOLANA_CHAIN, toHex(solanaManagerPeer), DECIMALS, ISSUANCE])
    await call(arc, hubTransceiver, transceiverContract, 'setWormholePeer', [SOLANA_CHAIN, toHex(solanaEmitterPeer)])
    await send(connection, payer, [
      spoke.setPeer(payer.publicKey, admin.publicKey, ARC_CHAIN, evmToWormholeFormat(hubManager), ISSUANCE, DECIMALS),
      spoke.setWormholePeer(payer.publicKey, admin.publicKey, ARC_CHAIN, evmToWormholeFormat(hubTransceiver)),
    ], [admin])
    record('peers', `Arc manager ${hubManager} ↔ Solana manager ${spoke.manager.toBase58()}; Arc transceiver ${hubTransceiver} ↔ Solana emitter ${spoke.at.emitter.toBase58()}. Both sides registered the other's real address, not a placeholder.`)

    /* ---------------------------------------------------------- observation */

    const observe = async (pendingToSpoke: bigint, pendingToHub: bigint): Promise<ObservedRoute> => {
      const issuance = await arc.publicClient.readContract({ address: hub, abi: erc20Abi, functionName: 'totalSupply' })
      const hubCustody = await arc.publicClient.readContract({ address: hub, abi: erc20Abi, functionName: 'balanceOf', args: [hubManager] })
      const mint = await readMint(connection, mintKeypair.publicKey)
      return {
        issuance, hubCustody, hubCirculating: issuance - hubCustody,
        spokeSupply: mint.supply,
        spokeCustody: await readTokenBalance(connection, spoke.custody()),
        pendingToSpoke, pendingToHub,
      }
    }
    /** The hub half alone, for the window in which the spoke is deliberately not running. */
    const observeHub = async (): Promise<{ issuance: bigint; hubCustody: bigint; hubCirculating: bigint }> => {
      const issuance = await arc.publicClient.readContract({ address: hub, abi: erc20Abi, functionName: 'totalSupply' })
      const hubCustody = await arc.publicClient.readContract({ address: hub, abi: erc20Abi, functionName: 'balanceOf', args: [hubManager] })
      return { issuance, hubCustody, hubCirculating: issuance - hubCustody }
    }
    const reconcile = async (label: string, pendingToSpoke: bigint, pendingToHub: bigint): Promise<ObservedRoute> => {
      const route = await observe(pendingToSpoke, pendingToHub)
      const result = reconcileRoute(route)
      assert(result.ok, `${label}: the two observed ledgers do not reconcile (${describeRoute(route)})`)
      return route
    }

    const recipientAta = associatedTokenAddress(mintKeypair.publicKey, payer.publicKey)
    const arcRecipient: Address = arc.account
    await reconcile('before any transfer', 0n, 0n)

    /* ---------------------------------------------------------- 5. Arc → Solana, real bytes */

    await call(arc, hub, tokenContract, 'approve', [hubManager, OUTBOUND])
    const sent = await call(arc, hubManager, managerContract, 'transfer', [OUTBOUND, SOLANA_CHAIN, toHex(bytes32(payer.publicKey))])
    const outbound = publishedMessage(sent.logs)
    const sentBlock = await arc.publicClient.getBlock({ blockNumber: (await arc.publicClient.getTransactionReceipt({ hash: sent.hash })).blockNumber })
    assert(outbound.emitter.toLowerCase() === hubTransceiver.toLowerCase(), 'the Arc message was not published by the hub transceiver')

    const outboundMessage = managerMessageFrom(outbound.payload)
    const outboundDecoded = decodeTransceiverMessage(outbound.payload)
    assert(sameBytes(outboundDecoded.sourceNttManager, evmToWormholeFormat(hubManager)), 'the published source manager is not the Arc hub manager')
    assert(sameBytes(outboundDecoded.recipientNttManager, solanaManagerPeer), 'the published recipient manager is not the Solana manager program')
    assert(outboundDecoded.managerPayload.payload.toChain === SOLANA_CHAIN, 'the published transfer is not addressed to Solana')
    assert(sameBytes(outboundDecoded.managerPayload.payload.to, bytes32(payer.publicKey)), 'the published recipient is not the Solana account')
    const expectedTrim = trimAmount(OUTBOUND, DECIMALS, DECIMALS)
    assert(outboundDecoded.managerPayload.payload.amount.amount === expectedTrim.amount
      && outboundDecoded.managerPayload.payload.amount.decimals === expectedTrim.decimals, 'the published amount does not match the debit')

    let route = await reconcile('Arc debited, message in flight', OUTBOUND, 0n)
    assert(route.hubCustody === OUTBOUND && route.spokeSupply === 0n, 'the Arc debit did not move the tokens into custody')
    record('arc → solana debit', `Arc locked ${OUTBOUND} atoms into ${hubManager} and published sequence ${outbound.sequence} from ${outbound.emitter}: ${outbound.payload.length} bytes, ${toHex(outbound.payload).slice(0, 34)}… Observed hub custody ${route.hubCustody}, observed spoke supply ${route.spokeSupply}.`)

    const outboundBody = vaaBody(
      Number(sentBlock.timestamp), ARC_CHAIN, evmToWormholeFormat(hubTransceiver),
      outbound.sequence, outbound.nonce, outbound.consistencyLevel, outbound.payload,
    )
    const outboundPosted = await postVaa(connection, payer, spoke, outboundBody)
    const outboundDigest = outboundMessage.digest(ARC_CHAIN)
    await send(connection, payer, [spoke.receiveWormholeMessage(payer.publicKey, outboundPosted.posted, ARC_CHAIN, outboundMessage.message.id)])
    await send(connection, payer, [spoke.redeem(payer.publicKey, ARC_CHAIN, outboundMessage.message.id, outboundDigest)])
    const claimed = decodeInboxItem(await fetchAccount(connection, spoke.at.inboxItem(outboundDigest)))
    assert(claimed.amount === OUTBOUND, 'the Solana claim does not carry the amount Arc locked')
    await send(connection, payer, [spoke.releaseInboundMint(payer.publicKey, outboundDigest, recipientAta, true)])

    route = await reconcile('Arc → Solana credited', 0n, 0n)
    assert(route.spokeSupply === OUTBOUND && route.hubCustody === OUTBOUND, 'the credit did not mint exactly what Arc locked')
    assert(await readTokenBalance(connection, recipientAta) === OUTBOUND, 'the Solana recipient did not receive the credit')
    record('arc → solana credit', `the bytes Arc published credited ${OUTBOUND} atoms on Solana once. Both sides observed: ${describeRoute(route)}`)

    /* ---------------------------------------------------------- 6. refusals on the spoke */

    await expectSvmRefusal('replay: the same Arc VAA re-validated', () =>
      send(connection, stranger, [spoke.receiveWormholeMessage(stranger.publicKey, outboundPosted.posted, ARC_CHAIN, outboundMessage.message.id)]))
    await expectSvmRefusal('replay: the same Arc claim released twice', () =>
      send(connection, stranger, [spoke.releaseInboundMint(stranger.publicKey, outboundDigest, recipientAta, true)]))

    // The real Arc payload with one byte of the guardian-signed body changed.
    await expectSvmRefusal('unauthorized: guardian signature over a different body', async () => {
      const honest = signVaa(outboundBody)
      const forged = { ...outboundBody, sequence: outboundBody.sequence + 7n }
      const signatureSet = Keypair.generate()
      await send(connection, payer, [
        secp256k1Instruction(honest, DEV_GUARDIAN_ADDRESS),
        verifySignaturesInstruction(spoke.coreBridge, payer.publicKey, spoke.at.guardianSet(0), signatureSet.publicKey),
      ], [signatureSet])
      await send(connection, payer, [
        postVaaInstruction(spoke.coreBridge, payer.publicKey, spoke.at.guardianSet(0), spoke.at.coreBridgeConfig, signatureSet.publicKey, spoke.at.postedVaa(signVaa(forged).hash), forged),
      ])
    })
    route = await reconcile('after refused deliveries', 0n, 0n)
    assert(route.spokeSupply === OUTBOUND, 'a refused delivery changed the spoke supply')
    record('spoke refusals', `a replayed delivery, a replayed release and a tampered body all refused; both ledgers unchanged at ${describeRoute(route)}`)

    /* ---------------------------------------------------------- 7. Solana → Arc, real bytes */

    const outboxItem = Keypair.generate()
    const burn = spoke.transferBurn(
      payer.publicKey, recipientAta, payer.publicKey, outboxItem.publicKey,
      OUTBOUND, ARC_CHAIN, evmToWormholeFormat(arcRecipient), false,
    )
    await send(connection, payer, [approve(recipientAta, burn.sessionAuthority, payer.publicKey, OUTBOUND), burn.instruction], [outboxItem])
    await send(connection, payer, [spoke.releaseWormholeOutbound(payer.publicKey, outboxItem.publicKey, true)])
    const returned = decodePostedMessage(await fetchAccount(connection, spoke.at.wormholeMessage(outboxItem.publicKey)))
    assert(returned.emitter.equals(spoke.at.emitter), 'the Solana message was not published by the transceiver emitter')
    assert(returned.emitterChain === SOLANA_CHAIN, 'the Solana message does not declare Solana as its emitter chain')

    // Re-encoded and checked against the published bytes before anything is derived from it.
    managerMessageFrom(returned.payload)
    const returnDecoded = decodeTransceiverMessage(returned.payload)
    assert(sameBytes(returnDecoded.sourceNttManager, solanaManagerPeer), 'the returned source manager is not the Solana manager program')
    assert(sameBytes(returnDecoded.recipientNttManager, evmToWormholeFormat(hubManager)), 'the returned recipient manager is not the Arc hub manager')
    assert(returnDecoded.managerPayload.payload.toChain === ARC_CHAIN, 'the returned transfer is not addressed to Arc')
    assert(sameBytes(returnDecoded.managerPayload.payload.to, evmToWormholeFormat(arcRecipient)), 'the returned recipient is not the Arc account')

    route = await reconcile('Solana burned, message in flight', 0n, OUTBOUND)
    assert(route.spokeSupply === 0n && route.hubCustody === OUTBOUND, 'the Solana debit did not burn the representation while the hub kept its backing')
    record('solana → arc debit', `Solana burned ${OUTBOUND} atoms and published sequence ${returned.sequence} from ${returned.emitter.toBase58()}: ${returned.payload.length} bytes. Arc custody still holds ${route.hubCustody} against an in-flight claim.`)

    const returnBody = vaaBody(
      returned.vaaTime, SOLANA_CHAIN, bytes32(spoke.at.emitter),
      returned.sequence, returned.nonce, returned.consistencyLevel, returned.payload,
    )
    const returnVaa = toHex(serializeVaa(signVaa(returnBody)))
    await call(arc, hubTransceiver, transceiverContract, 'receiveMessage', [returnVaa])

    route = await reconcile('round trip complete', 0n, 0n)
    assert(route.hubCustody === 0n && route.spokeSupply === 0n && route.hubCirculating === ISSUANCE,
      'the completed round trip did not return the whole issuance to Arc')
    record('round trip', `the bytes Solana published released ${OUTBOUND} atoms of real Arc custody. Observed on both chains: ${describeRoute(route)}. Neither half of this is calculated from the other.`)

    /* ---------------------------------------------------------- 8. refusals on the hub */

    await expectArcRefusal('replay: the same Solana VAA delivered twice to Arc', () =>
      call(arc, hubTransceiver, transceiverContract, 'receiveMessage', [returnVaa]))
    const forgedEmitter = toHex(serializeVaa(signVaa({ ...returnBody, emitterAddress: bytes32(Keypair.generate().publicKey) })))
    await expectArcRefusal('unauthorized: Solana payload re-signed from an unregistered emitter', () =>
      call(arc, hubTransceiver, transceiverContract, 'receiveMessage', [forgedEmitter]))
    const tamperedVaa = Buffer.from(returnVaa.slice(2), 'hex')
    tamperedVaa[tamperedVaa.length - 1] ^= 0x01
    await expectArcRefusal('unauthorized: one byte of the guardian-signed body changed', () =>
      call(arc, hubTransceiver, transceiverContract, 'receiveMessage', [`0x${tamperedVaa.toString('hex')}`]))
    route = await reconcile('after refused deliveries on Arc', 0n, 0n)
    assert(route.hubCustody === 0n && route.hubCirculating === ISSUANCE, 'a refused delivery on Arc moved custody')
    record('hub refusals', `replay, unregistered emitter and tampered body all refused on Arc; ${describeRoute(route)}`)

    /* ---------------------------------------------------------- 9. restart recovery */

    await call(arc, hub, tokenContract, 'approve', [hubManager, SECOND])
    const secondSent = await call(arc, hubManager, managerContract, 'transfer', [SECOND, SOLANA_CHAIN, toHex(bytes32(payer.publicKey))])
    const second = publishedMessage(secondSent.logs)
    const secondBlock = await arc.publicClient.getBlock({ blockNumber: (await arc.publicClient.getTransactionReceipt({ hash: secondSent.hash })).blockNumber })
    const secondMessage = managerMessageFrom(second.payload)
    const secondDigest = secondMessage.digest(ARC_CHAIN)
    const secondPosted = await postVaa(connection, payer, spoke, vaaBody(
      Number(secondBlock.timestamp), ARC_CHAIN, evmToWormholeFormat(hubTransceiver),
      second.sequence, second.nonce, second.consistencyLevel, second.payload,
    ))
    // Before delivering it legitimately: the same undelivered Arc payload, re-signed from an
    // emitter the spoke never registered. Running this on a message that has already arrived would
    // be refused by the message account already existing, which proves something weaker.
    const strangerEmitter = bytes32(Keypair.generate().publicKey)
    const strangerPosted = await postVaa(connection, payer, spoke, vaaBody(
      Number(secondBlock.timestamp), ARC_CHAIN, strangerEmitter,
      second.sequence, second.nonce, second.consistencyLevel, second.payload,
    ))
    await expectSvmRefusal('unauthorized: an undelivered Arc payload re-signed from an unregistered emitter', () =>
      send(connection, payer, [spoke.receiveWormholeMessage(payer.publicKey, strangerPosted.posted, ARC_CHAIN, secondMessage.message.id)]))
    assert((await connection.getAccountInfo(spoke.at.transceiverMessage(ARC_CHAIN, secondMessage.message.id), 'confirmed')) === null,
      'the refused delivery still validated a message')

    await send(connection, payer, [spoke.receiveWormholeMessage(payer.publicKey, secondPosted.posted, ARC_CHAIN, secondMessage.message.id)])
    const redeemed = await send(connection, payer, [spoke.redeem(payer.publicKey, ARC_CHAIN, secondMessage.message.id, secondDigest)])
    const beforeCrash = decodeInboxItem(await fetchAccount(connection, spoke.at.inboxItem(secondDigest)))
    assert(beforeCrash.status === 'release_after', 'the approved claim is not awaiting release')
    await awaitFinalized(connection, redeemed)

    stopValidator(validator, 'SIGKILL')
    validator = null
    await new Promise((done) => setTimeout(done, 3_000))
    // The Arc fork stayed up throughout, so the hub custody read after the crash is a live read of
    // a chain that never restarted. That is the point: the claim and its backing are checked
    // against each other across the failure, not within one process's memory.
    // Only the hub can be read here, because the spoke is deliberately not running. That is the
    // claim being tested: the backing for an un-credited claim is on a chain that did not crash.
    const duringOutage = await observeHub()
    assert(duringOutage.hubCustody === SECOND, 'Arc custody did not hold the backing while the spoke was down')
    assert(duringOutage.hubCirculating + SECOND === duringOutage.issuance, 'the issuance does not add up while the spoke is down')

    validator = startValidator(VALIDATOR_AT, ledger, { rpc: RPC_PORT, faucet: FAUCET_PORT }, false, admin.publicKey)
    // A new client: the previous one's websocket died with the validator it was subscribed to.
    connection = new Connection(RPC_URL, 'confirmed')
    await waitForHealth(connection)
    const afterCrash = decodeInboxItem(await fetchAccount(connection, spoke.at.inboxItem(secondDigest)))
    assert(afterCrash.amount === beforeCrash.amount && afterCrash.status === 'release_after', 'the restart lost the approved claim')
    await reconcile('spoke restarted, claim still pending', SECOND, 0n)
    await send(connection, payer, [spoke.releaseInboundMint(payer.publicKey, secondDigest, recipientAta, true)])
    route = await reconcile('recovered claim credited', 0n, 0n)
    assert(route.spokeSupply === SECOND, 'the recovered claim did not credit exactly once')
    await expectSvmRefusal('restart: the recovered claim released twice', () =>
      send(connection, stranger, [spoke.releaseInboundMint(stranger.publicKey, secondDigest, recipientAta, true)]))
    record('spoke restart', `SIGKILL between approving and crediting a ${SECOND} atom claim. Arc custody held ${SECOND} throughout, the same ledger reopened, credited exactly once and refused the repeat: ${describeRoute(route)}`)

    /* ---------------------------------------------------------- 10. hub restart */

    writeFileSync(stateFile, await dumpState(arc.publicClient))
    stopAnvil(anvil, 'SIGKILL')
    anvil = null
    await new Promise((done) => setTimeout(done, 1_500))
    anvil = startAnvil(ARC_PORT, Number(forkBlock.number))
    arc = connect(ARC_PORT)
    await waitForAnvil(arc.publicClient)
    await loadState(arc.publicClient, readFileSync(stateFile, 'utf8') as Hex)
    // The guardian substitution is storage on the core bridge, so it has to have come back with
    // everything else; the rate-limit case below signs another VAA against it.
    const stillSubstituted = await overrideGuardianSet(arc.publicClient, ARC_TESTNET.coreBridge, `0x${DEV_GUARDIAN_ADDRESS}`)
    assert(stillSubstituted.replaced.length === 1 && stillSubstituted.replaced[0].toLowerCase() === `0x${DEV_GUARDIAN_ADDRESS}`,
      'the hub restart lost the substituted guardian set')
    const reloadedPeer = await arc.publicClient.readContract({ address: hubTransceiver, abi: transceiverAbi, functionName: 'getWormholePeer', args: [SOLANA_CHAIN] })
    assert(reloadedPeer === toHex(solanaEmitterPeer), 'the hub restart lost its registered Solana peer')
    const reloaded = await reconcile('hub restarted', 0n, 0n)
    assert(reloaded.hubCustody === SECOND, 'the hub restart lost its custody')
    await expectArcRefusal('hub restart: an already-delivered Solana VAA replayed after the restart', () =>
      call(arc, hubTransceiver, transceiverContract, 'receiveMessage', [returnVaa]))
    record('hub restart', `the Arc node was killed and reopened from an anvil state snapshot (a HARNESS snapshot of the fork, not a property of Arc): custody ${reloaded.hubCustody}, peers and the consumed-VAA set all survived, and the earlier delivery is still refused`)

    /* ---------------------------------------------------------- 11. eventual rate-limit release */

    await call(arc, hubManager, managerContract, 'setInboundLimit', [1_000_000n, SOLANA_CHAIN])
    const queuedItem = Keypair.generate()
    const queuedBurn = spoke.transferBurn(
      payer.publicKey, recipientAta, payer.publicKey, queuedItem.publicKey,
      SECOND, ARC_CHAIN, evmToWormholeFormat(arcRecipient), false,
    )
    await send(connection, payer, [approve(recipientAta, queuedBurn.sessionAuthority, payer.publicKey, SECOND), queuedBurn.instruction], [queuedItem])
    await send(connection, payer, [spoke.releaseWormholeOutbound(payer.publicKey, queuedItem.publicKey, true)])
    const queuedPost = decodePostedMessage(await fetchAccount(connection, spoke.at.wormholeMessage(queuedItem.publicKey)))
    const queuedMessage = managerMessageFrom(queuedPost.payload)
    const queuedDigest: Hex = `0x${Buffer.from(queuedMessage.digest(SOLANA_CHAIN)).toString('hex')}`
    const queuedVaa = toHex(serializeVaa(signVaa(vaaBody(
      queuedPost.vaaTime, SOLANA_CHAIN, bytes32(spoke.at.emitter),
      queuedPost.sequence, queuedPost.nonce, queuedPost.consistencyLevel, queuedPost.payload,
    ))))
    await call(arc, hubTransceiver, transceiverContract, 'receiveMessage', [queuedVaa])

    const queued = await arc.publicClient.readContract({ address: hubManager, abi: managerAbi, functionName: 'getInboundQueuedTransfer', args: [queuedDigest] })
    assert(queued.txTimestamp > 0n, 'the over-limit delivery was not queued on Arc')
    assert(queued.amount >> 8n === SECOND && (queued.amount & 0xffn) === BigInt(DECIMALS), 'the queued entry does not carry the amount Solana burned')
    assert(queued.recipient.toLowerCase() === arcRecipient.toLowerCase(), 'the queued entry is addressed elsewhere')
    let delayedRoute = await reconcile('delivery queued by the hub rate limit', 0n, SECOND)
    assert(delayedRoute.hubCustody === SECOND, 'the queued delivery released custody early')
    await expectArcRefusal('rate limit: queued transfer completed before its delay elapsed', () =>
      call(arc, hubManager, managerContract, 'completeInboundQueuedTransfer', [queuedDigest]))

    clockFixture(`Arc fork time advanced by ${RATE_LIMIT_DURATION + 1} seconds via evm_increaseTime so the hub's 24-hour inbound queue can be released. Nothing else about the delay is simulated: the queue entry, its timestamp and the release are the pinned manager's own.`)
    const beforeWarp = await arc.publicClient.getBlock({ blockTag: 'latest' })
    await increaseTime(arc.publicClient, RATE_LIMIT_DURATION + 1)
    const afterWarp = await arc.publicClient.getBlock({ blockTag: 'latest' })
    assert(afterWarp.timestamp - beforeWarp.timestamp > BigInt(RATE_LIMIT_DURATION), 'the clock fixture did not advance the fork past the rate limit duration')
    await call(arc, hubManager, managerContract, 'completeInboundQueuedTransfer', [queuedDigest])
    delayedRoute = await reconcile('queued delivery released', 0n, 0n)
    assert(delayedRoute.hubCustody === 0n && delayedRoute.hubCirculating === ISSUANCE && delayedRoute.spokeSupply === 0n,
      'the released queue entry did not return the issuance to Arc')
    await expectArcRefusal('rate limit: the released queue entry completed twice', () =>
      call(arc, hubManager, managerContract, 'completeInboundQueuedTransfer', [queuedDigest]))
    record('rate limit release', `a ${SECOND} atom delivery over a 1,000,000 atom inbound limit queued at ${queued.txTimestamp} for ${queued.recipient}, refused early completion, then released exactly once after the labelled clock fixture: ${describeRoute(delayedRoute)}`)

    /* ---------------------------------------------------------- 12. a claim left in flight */

    await send(connection, payer, [spoke.setInboundLimit(admin.publicKey, ARC_CHAIN, 1_000_000n)], [admin])
    await call(arc, hub, tokenContract, 'approve', [hubManager, DELAYED])
    const heldSent = await call(arc, hubManager, managerContract, 'transfer', [DELAYED, SOLANA_CHAIN, toHex(bytes32(payer.publicKey))])
    const held = publishedMessage(heldSent.logs)
    const heldBlock = await arc.publicClient.getBlock({ blockNumber: (await arc.publicClient.getTransactionReceipt({ hash: heldSent.hash })).blockNumber })
    const heldMessage = managerMessageFrom(held.payload)
    const heldDigest = heldMessage.digest(ARC_CHAIN)
    const heldPosted = await postVaa(connection, payer, spoke, vaaBody(
      Number(heldBlock.timestamp), ARC_CHAIN, evmToWormholeFormat(hubTransceiver),
      held.sequence, held.nonce, held.consistencyLevel, held.payload,
    ))
    await send(connection, payer, [spoke.receiveWormholeMessage(payer.publicKey, heldPosted.posted, ARC_CHAIN, heldMessage.message.id)])
    await send(connection, payer, [spoke.redeem(payer.publicKey, ARC_CHAIN, heldMessage.message.id, heldDigest)])
    const heldItem = decodeInboxItem(await fetchAccount(connection, spoke.at.inboxItem(heldDigest)))
    const now = BigInt(Math.floor(Date.now() / 1000))
    assert(heldItem.status === 'release_after' && heldItem.releaseAfter !== null && heldItem.releaseAfter > now, 'the over-limit claim was not delayed on Solana')
    await expectSvmRefusal('rate limit: the delayed Solana claim released early', () =>
      send(connection, stranger, [spoke.releaseInboundMint(stranger.publicKey, heldDigest, recipientAta, true)]))
    const inFlight = await reconcile('a rate-limited claim left in flight', DELAYED, 0n)
    assert(inFlight.hubCustody === DELAYED && inFlight.spokeSupply === 0n, 'the delayed claim is not backed by observed Arc custody')
    record('claim in flight', `a ${DELAYED} atom claim held by the spoke's inbound limit until ${heldItem.releaseAfter?.toString() ?? 'unknown'} is refused early and backed by ${inFlight.hubCustody} atoms of observed Arc custody. Conservation holds with the claim outstanding: ${describeRoute(inFlight)}`)
    record('not executed', 'The Solana side of the eventual release is NOT executed. The pinned SVM program hard-codes a 24-hour RATE_LIMIT_DURATION and reads the Clock sysvar, whose unix timestamp on solana-test-validator tracks the host clock; --warp-slot did not bring a validator up on this host. The equivalent release IS executed above on the Arc hub, whose delay is a constructor parameter and whose clock the fork exposes.')

    /* ---------------------------------------------------------- the record */

    const endState = await observe(DELAYED, 0n)
    const result = {
      observedAt: new Date().toISOString(),
      mode: 'local' as const,
      claim: 'Arc–Solana integration rehearsal. An Anvil fork of Arc testnet carrying the real deployed Wormhole core bridge, with the actual pinned NTT locking manager and transceiver deployed onto it, exchanging its own published message bytes with the actual pinned NTT programs and the actual mainnet core bridge binary on a local Solana validator. One development guardian key is substituted into both core bridges. Not a public route, not a devnet, testnet or mainnet deployment, no funds moved.',
      pin: {
        evmCommit: 'c636cc15b07969e4b44de7e466c999c07e7387a9', evmVersion: 'v2.0.0+evm',
        svmCommit: SOLANA_NTT.commit, svmVersion: SOLANA_NTT.version,
      },
      arc: {
        forkOf: ARC_TESTNET.rpc, evmChainId: ARC_TESTNET.evmChainId, wormholeId: ARC_CHAIN,
        forkBlock: Number(forkBlock.number), forkBlockHash: forkBlock.hash,
        coreBridge: ARC_TESTNET.coreBridge,
        guardianSetIndex: substituted.index, guardianSetReplaced: substituted.replaced,
        token: hub, manager: hubManager, transceiver: hubTransceiver,
        mode: 'locking', rateLimitDuration: RATE_LIMIT_DURATION,
      },
      solana: {
        manager: spoke.manager.toBase58(), transceiver: spoke.transceiver.toBase58(),
        coreBridge: spoke.coreBridge.toBase58(), emitter: spoke.at.emitter.toBase58(),
        mint: mintKeypair.publicKey.toBase58(), decimals: DECIMALS, mode: 'burning',
        tokenAuthority: spoke.at.tokenAuthority.toBase58(), custody: spoke.custody().toBase58(),
        programBytes: {
          manager: statSync(join(DEPLOY, 'example_native_token_transfers.so')).size,
          transceiver: statSync(join(DEPLOY, 'ntt_transceiver.so')).size,
        },
      },
      exchangedMessages: [
        { direction: 'arc→solana', sequence: Number(outbound.sequence), bytes: outbound.payload.length, payload: toHex(outbound.payload) },
        { direction: 'solana→arc', sequence: Number(returned.sequence), bytes: returned.payload.length, payload: toHex(returned.payload) },
        { direction: 'arc→solana', sequence: Number(second.sequence), bytes: second.payload.length, payload: toHex(second.payload) },
        { direction: 'solana→arc', sequence: Number(queuedPost.sequence), bytes: queuedPost.payload.length, payload: toHex(queuedPost.payload) },
        { direction: 'arc→solana', sequence: Number(held.sequence), bytes: held.payload.length, payload: toHex(held.payload) },
      ],
      endState,
      reconciliation: reconcileRoute(endState),
      modelledHubSide: false,
      observed: 'Arc token total supply and locking-manager custody; Solana SPL mint supply, recipient balance and custody balance; the published message bytes of every transfer in both directions.',
      clockFixtures,
      notExecuted: [
        'The Solana inbound queue\'s eventual release: the pinned program hard-codes 24 hours against the Clock sysvar and the local validator\'s clock cannot be advanced on this host. The equivalent hub release is executed.',
        'Any public route. No deployment, transfer, pool or funding exists on Arc mainnet or testnet, Solana devnet or mainnet-beta.',
      ],
      publicRouteTested: false,
      steps,
    }
    const out = join(ROOT, 'output/equilibrium')
    mkdirSync(out, { recursive: true })
    // The ledger figures are bigints; JSON has no such thing, so they are written as decimal strings.
    const asJson = JSON.stringify(result, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value), 2)
    writeFileSync(join(out, 'arc-solana-integration.json'), `${asJson}\n`)
    console.log('\nAll checks passed. Record written to output/equilibrium/arc-solana-integration.json')
  } finally {
    stopValidator(validator)
    stopAnvil(anvil)
    if (!process.env.EQUILIBRIUM_SOLANA_KEEP_LEDGER) rmSync(ledger, { recursive: true, force: true })
  }
}

await main()
