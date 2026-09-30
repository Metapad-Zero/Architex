/**
 * The Arc–Solana route as a durable launch adapter's backend: real transactions, real reads.
 *
 * `integrate.ts` proved the route. This implements {@link SolanaRoute} over the same two
 * environments — an Anvil fork of Arc testnet carrying the real deployed Wormhole core bridge with
 * the pinned locking NTT manager deployed onto it, and the pinned NTT programs with the real
 * mainnet core bridge binary on a local `solana-test-validator` — so that a launch job can be
 * fulfilled across it and survive the things a script never has to: a payment that must settle once,
 * a worker that dies between submitting and recording, and a retry that must not lock or mint a
 * second allocation.
 *
 * Every step is observable from chain state alone. That is the whole design constraint: a restarted
 * worker holds nothing but the job row, so each step's plan is derived from the job, persisted
 * before anything is submitted, and answered afterwards by a read that a fresh process can make.
 *
 *  - payment    an EIP-3009 authorization. The token consumes the nonce, so the chain refuses the
 *               second submission. Observed through `authorizationState`.
 *  - canonical  `EquilibriumIssuanceFactory.issue` keyed by the step's operation hash, which the
 *               factory binds to the issuance parameters and refuses to rebind.
 *  - manager    a locking manager and transceiver deployed across several transactions and only
 *               then registered. Observed through the registry, so a half-built leg reads as absent
 *               and the contracts it left behind are never referred to by anything.
 *  - debit      the hub's `transfer`, which is not idempotent. Observed by the core-bridge sequence
 *               recorded before submission: unpublished means it never happened, and a different
 *               payload at that sequence fails the step closed instead of locking again.
 *  - credit     the NTT delivery, keyed by the manager-message digest the spoke's inbox item and its
 *               replay guard both use. The program refuses a second release.
 *  - pool       one atomic distribution per operation: inventory to a derived holder and the rest of
 *               the allocation to the recipient, together, so no retry can split them.
 *
 * FIXTURES, all labelled where they are used and in the record the harness writes: the settlement
 * asset and the quote asset are fixture tokens (Arc testnet USDC cannot be held by a payer this
 * rehearsal signs for), and one development guardian key is substituted into both core bridges. No
 * public route is opened, nothing is funded and nothing is broadcast to a public network.
 */
import { type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Connection, Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js'
import { getAbiItem, type Abi, type Address, type Hex, type PublicClient } from 'viem'
import {
  SOLANA_NTT, bytes32, decodeTransceiverMessage, encodeNttManagerMessage, leBytes,
  managerMessageDigest, toHex, trimAmount, TOKEN_PROGRAM,
} from '../../src/lib/equilibriumSolana'
import { evmToWormholeFormat, type ObservedRoute } from '../../src/lib/equilibriumArcSolana'
import {
  inventoryHolder, operationOf, solanaSeed,
  type CanonicalPlan, type CreditPlan, type DebitPlan, type InventoryPlan, type LegPlan,
  type PaymentPlan, type RoutePending, type SolanaRoute, type StepPlan,
} from '../../server/equilibrium/solanaRoute'
import { LaunchError, type Atoms, type EffectContext, type EffectResult, type Job, type LaunchRequest, type StepKind } from '../../server/equilibrium/types'
import {
  ARC_TESTNET, artifact, call, connect, deploy, linkLibraries, overrideGuardianSet, startAnvil,
  stopAnvil, waitForAnvil,
} from './arcFork'
import { BURNING, LOCKING, NttDeployment, decodeConfig, decodeInboxItem } from './nttClient'
import { awaitConfirmed, postVaa, send, startValidator, stopValidator, waitForHealth } from './localValidator'
import { DEV_GUARDIAN_ADDRESS } from './wormholeCore'
import {
  associatedTokenAddress, createAssociatedTokenAccount, createMintAccount, initializeMint2, mintTo,
  readMint, readTokenBalance, setMintAuthority,
} from './splToken'

const ROOT = resolve(import.meta.dirname, '../..')
const SVM = join(ROOT, 'lib/ntt-svm/solana')
const DEPLOY = join(SVM, 'target/deploy')

const ARC_CHAIN = SOLANA_NTT.arcWormholeId
const SOLANA_CHAIN = SOLANA_NTT.solanaWormholeId
const DECIMALS = SOLANA_NTT.decimals
/** The pinned SVM program hard-codes the same 24 hours; the hub takes it as a constructor argument. */
const RATE_LIMIT_DURATION = 86_400
/** Fixture balances, generous enough that no step is ever refused for want of a fixture token. */
const FIXTURE_SUPPLY = 1_000_000_000_000_000n

/* ------------------------------------------------------------------ ABIs */

const managerContract = artifact('NttManager').abi
const transceiverContract = artifact('WormholeTransceiver').abi
const factoryContract = artifact('EquilibriumToken', 'EquilibriumIssuanceFactory').abi
const registryContract = artifact('EquilibriumFulfillment', 'EquilibriumRouteRegistry').abi
const distributorContract = artifact('EquilibriumFulfillment', 'EquilibriumDistributor').abi
const paymentContract = artifact('EquilibriumFulfillment', 'EquilibriumPaymentFixture').abi
const tokenContract = artifact('EquilibriumToken', 'EquilibriumCanonical').abi

const erc20Abi = [
  { type: 'function', name: 'totalSupply', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'allowance', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
] as const satisfies Abi

const factoryAbi = [
  { type: 'function', name: 'tokenOf', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'address' }], stateMutability: 'view' },
] as const satisfies Abi

const registryAbi = [
  {
    type: 'function', name: 'legOf', inputs: [{ type: 'bytes32' }], stateMutability: 'view',
    outputs: [{ type: 'tuple', components: [{ type: 'address', name: 'token' }, { type: 'address', name: 'manager' }, { type: 'address', name: 'transceiver' }] }],
  },
] as const satisfies Abi

const distributorAbi = [
  {
    type: 'function', name: 'placementOf', inputs: [{ type: 'bytes32' }], stateMutability: 'view',
    outputs: [{ type: 'tuple', components: [{ type: 'uint256', name: 'poolTokens' }, { type: 'uint256', name: 'poolQuote' }, { type: 'uint256', name: 'delivered' }, { type: 'bool', name: 'placed' }] }],
  },
] as const satisfies Abi

const paymentAbi = [
  { type: 'function', name: 'authorizationState', inputs: [{ type: 'address' }, { type: 'bytes32' }], outputs: [{ type: 'bool' }], stateMutability: 'view' },
] as const satisfies Abi

/**
 * The events an observation filters on, declared literally rather than pulled out of the compiled
 * ABI. The literal types are the point: `getLogs` then checks the indexed filter at compile time and
 * hands back typed arguments, so a renamed field is a build error instead of an undefined at runtime.
 */
const eventsAbi = [
  { type: 'event', name: 'LogMessagePublished', inputs: [{ type: 'address', name: 'sender', indexed: true }, { type: 'uint64', name: 'sequence' }, { type: 'uint32', name: 'nonce' }, { type: 'bytes', name: 'payload' }, { type: 'uint8', name: 'consistencyLevel' }] },
  { type: 'event', name: 'AuthorizationUsed', inputs: [{ type: 'address', name: 'authorizer', indexed: true }, { type: 'bytes32', name: 'nonce', indexed: true }] },
  { type: 'event', name: 'Issued', inputs: [{ type: 'bytes32', name: 'identity', indexed: true }, { type: 'bytes32', name: 'payload', indexed: true }, { type: 'address', name: 'token', indexed: true }] },
  { type: 'event', name: 'LegRegistered', inputs: [{ type: 'bytes32', name: 'operation', indexed: true }, { type: 'address', name: 'token' }, { type: 'address', name: 'manager' }, { type: 'address', name: 'transceiver' }] },
  { type: 'event', name: 'InventoryPlaced', inputs: [{ type: 'bytes32', name: 'operation', indexed: true }, { type: 'address', name: 'holder', indexed: true }, { type: 'address', name: 'recipient', indexed: true }, { type: 'uint256', name: 'poolTokens' }, { type: 'uint256', name: 'poolQuote' }, { type: 'uint256', name: 'delivered' }] },
] as const satisfies Abi

const coreBridgeAbi = [
  { type: 'function', name: 'nextSequence', inputs: [{ type: 'address' }], outputs: [{ type: 'uint64' }], stateMutability: 'view' },
] as const satisfies Abi

/* ------------------------------------------------------------------ SPL helpers */

/**
 * `TransferChecked`, not `Transfer`: it takes the mint and its decimals and the token program
 * verifies both. An inventory placement that moved the right number of atoms of the wrong mint would
 * otherwise reconcile against the wrong ledger.
 */
function transferChecked(source: PublicKey, mint: PublicKey, destination: PublicKey, owner: PublicKey, amount: bigint, decimals: number): TransactionInstruction {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([12]), Buffer.from(leBytes(amount, 8)), Buffer.from([decimals])]),
  })
}

/**
 * The evidence handle recorded for a Solana effect.
 *
 * On Arc this is a transaction hash, because the chain keeps its receipts and a restarted worker can
 * fetch one. On Solana the durable evidence is the account itself: the manager config, the inbox item
 * and the inventory token account are all PDAs or derived addresses whose existence and contents are
 * the finalized fact. A transaction signature is not equivalent — `getSignaturesForAddress` depends on
 * RPC transaction history a restarted validator need not retain, and an observation that answers
 * "cannot tell" because the history was pruned would stall a launch that in fact completed.
 */
function solanaEvidence(what: string, address: PublicKey): string {
  return `solana:${what}:${address.toBase58()}`
}

/* ------------------------------------------------------------------ infrastructure */

export interface RouteInfrastructure {
  arcPort: number
  rpcPort: number
  ledger: string
  /** Where log searches start: the block at which this run's own contracts existed. */
  fromBlock: bigint
  arc: { url: string; publicClient: PublicClient; wallet: ReturnType<typeof connect>['wallet']; account: Address }
  connection: Connection
  structs: Address
  factory: Address
  registry: Address
  distributor: Address
  paymentAsset: Address
  quoteAsset: Address
  guardianSubstitution: { index: number; replaced: readonly Address[] }
  /** Solana fee payer and launch custody owner. */
  payer: Keypair
  /** The NTT deployment owner on Solana; also the validator's program upgrade authority. */
  admin: Keypair
  quoteMint: Keypair
}

export interface OpenRouteOptions {
  arcPort?: number
  rpcPort?: number
  ledger: string
  /** The Arc account the settlement fixture credits, i.e. the payer the launch service will quote. */
  payerAddress: Address
  paymentName?: string
  paymentVersion?: string
}

/**
 * Bring both environments up and deploy the launch-service-owned infrastructure: the issuance
 * factory, the bridge-leg registry, the atomic distributor and the two fixture assets.
 *
 * Nothing here is per-launch. The per-launch artefacts — the canonical token, its locking manager
 * and transceiver, the spoke mint and its manager config — are created by the job's own steps, which
 * is what makes them observable against that job's operation hashes.
 */
export async function openRoute(options: OpenRouteOptions): Promise<{ infrastructure: RouteInfrastructure; anvil: ChildProcess; validator: ChildProcess }> {
  for (const file of ['example_native_token_transfers.so', 'ntt_transceiver.so']) {
    if (!existsSync(join(DEPLOY, file))) {
      throw new Error(`Missing ${file}. Build the pinned SVM programs first: bun run equilibrium:solana:build`)
    }
  }
  const arcPort = options.arcPort ?? Number(process.env.EQUILIBRIUM_FULFILL_ARC_PORT ?? 8745)
  const rpcPort = options.rpcPort ?? Number(process.env.EQUILIBRIUM_FULFILL_SOLANA_PORT ?? 9045)

  const anvil = startAnvil(arcPort)
  const arc = connect(arcPort)
  await waitForAnvil(arc.publicClient)
  if (await arc.publicClient.getChainId() !== ARC_TESTNET.evmChainId) throw new Error('The fork is not Arc testnet.')
  const coreCode = await arc.publicClient.getCode({ address: ARC_TESTNET.coreBridge })
  if ((coreCode?.length ?? 0) <= 2) throw new Error('The Arc core bridge has no code on this fork.')
  // GUARDIAN FIXTURE: one development key substituted for the real set, on both core bridges.
  const guardianSubstitution = await overrideGuardianSet(arc.publicClient, ARC_TESTNET.coreBridge, `0x${DEV_GUARDIAN_ADDRESS}`)

  const structs = await deploy(arc, artifact('TransceiverStructs'))
  const factory = await deploy(arc, artifact('EquilibriumToken', 'EquilibriumIssuanceFactory'), [arc.account])
  const registry = await deploy(arc, artifact('EquilibriumFulfillment', 'EquilibriumRouteRegistry'), [arc.account])
  const distributor = await deploy(arc, artifact('EquilibriumFulfillment', 'EquilibriumDistributor'), [arc.account])
  // PAYMENT FIXTURE: the EIP-712 name/version here are the payment terms the service quotes.
  const paymentAsset = await deploy(arc, artifact('EquilibriumFulfillment', 'EquilibriumPaymentFixture'),
    [options.paymentName ?? 'USDC-FIXTURE', options.paymentVersion ?? '2', options.payerAddress, FIXTURE_SUPPLY])
  const quoteAsset = await deploy(arc, artifact('EquilibriumFulfillment', 'EquilibriumQuoteFixture'), [arc.account, FIXTURE_SUPPLY])
  const fromBlock = await arc.publicClient.getBlockNumber()

  const payer = Keypair.generate()
  const admin = Keypair.generate()
  const quoteMint = Keypair.generate()
  const validator = startValidator(
    { cwd: SVM, deploy: DEPLOY, fixtures: join(SVM, 'programs/example-native-token-transfers/tests/fixtures'), accounts: join(SVM, 'tests/accounts/mainnet') },
    options.ledger, { rpc: rpcPort, faucet: rpcPort + 101 }, true, admin.publicKey,
  )
  const connection = new Connection(`http://127.0.0.1:${rpcPort}`, 'confirmed')
  await waitForHealth(connection)
  await awaitConfirmed(connection, await connection.requestAirdrop(payer.publicKey, 500_000_000_000))

  // QUOTE INVENTORY FIXTURE on the spoke, so the Solana inventory step has a quote asset to place.
  await send(connection, payer, [
    await createMintAccount(connection, payer.publicKey, quoteMint.publicKey),
    initializeMint2(quoteMint.publicKey, DECIMALS, payer.publicKey),
    createAssociatedTokenAccount(payer.publicKey, payer.publicKey, quoteMint.publicKey),
  ], [quoteMint])
  await send(connection, payer, [
    mintTo(quoteMint.publicKey, associatedTokenAddress(quoteMint.publicKey, payer.publicKey), payer.publicKey, FIXTURE_SUPPLY),
  ])

  return {
    infrastructure: {
      arcPort, rpcPort, ledger: options.ledger, fromBlock, arc, connection,
      structs, factory, registry, distributor, paymentAsset, quoteAsset,
      guardianSubstitution, payer, admin, quoteMint,
    },
    anvil, validator,
  }
}

export function closeRoute(anvil: ChildProcess | null, validator: ChildProcess | null): void {
  stopValidator(validator)
  stopAnvil(anvil)
}

/* ------------------------------------------------------------------ the route */

/**
 * Network fees on Arc, in the six-decimal atoms every other figure in a launch job is denominated
 * in. Arc's native gas asset is USDC at eighteen decimals, so this is a unit conversion and not an
 * exchange rate.
 *
 * Solana fees are paid in SOL by the operator's own fee payer. There is no honest conversion into
 * these atoms, so Solana steps report a zero launch cost and the harness records the lamports
 * separately rather than pricing them in the customer's asset.
 */
async function arcCost(client: PublicClient, hash: Hex): Promise<Atoms> {
  const receipt = await client.getTransactionReceipt({ hash })
  return ((receipt.gasUsed * receipt.effectiveGasPrice) / 10n ** 12n).toString()
}

export function fulfillmentRoute(infrastructure: RouteInfrastructure, options: { paymentName?: string; paymentVersion?: string } = {}): SolanaRoute {
  const { arc, payer, admin } = infrastructure
  const client = arc.publicClient
  /**
   * Read through the infrastructure record every time rather than closing over the client.
   * `restartSpoke` replaces it, and a route holding the dead one would report every account as
   * unreachable — which for an observation is the difference between "not there" and "cannot tell".
   */
  const live = (): Connection => infrastructure.connection

  /** The step operation for another step of the same job, so plans can refer to each other's effects. */
  const operationFor = (job: Job, id: string): Hex => {
    const step = job.steps.find((candidate) => candidate.id === id)
    if (!step) throw new Error(`This job has no ${id} step`)
    return operationOf(job, step)
  }
  const destinationOf = (job: Job, chain: string) => {
    const destination = job.request.destinations.find((candidate) => candidate.chain === chain)
    if (!destination) throw new Error(`This job has no ${chain} destination`)
    return destination
  }

  /** The canonical token, read from the factory rather than from the job's recorded step result. */
  const canonicalToken = async (job: Job): Promise<Address> => {
    const token = await client.readContract({ address: infrastructure.factory, abi: factoryAbi, functionName: 'tokenOf', args: [operationFor(job, 'canonical:arc')] })
    if (/^0x0+$/.test(token)) throw new Error('The canonical token has not been issued for this job')
    return token
  }
  const arcLeg = async (job: Job) => {
    const leg = await client.readContract({ address: infrastructure.registry, abi: registryAbi, functionName: 'legOf', args: [operationFor(job, 'manager:arc')] })
    if (/^0x0+$/.test(leg.manager)) throw new Error('The Arc bridge leg has not been registered for this job')
    return leg
  }
  /** The spoke deployment for this job: the pinned programs over this job's own derived mint. */
  const spokeOf = (job: Job): NttDeployment => new NttDeployment(
    new PublicKey(SOLANA_NTT.manager), new PublicKey(SOLANA_NTT.transceiver), new PublicKey(SOLANA_NTT.coreBridge),
    Keypair.fromSeed(solanaSeed(operationFor(job, 'manager:solana'), 'mint')).publicKey,
  )
  const accountExists = async (address: PublicKey): Promise<boolean> => (await live().getAccountInfo(address, 'confirmed')) !== null

  /** Every core-bridge message this job's hub transceiver published, taken from the chain's logs. */
  const publishedFrom = async (emitter: Address) => {
    const logs = await client.getLogs({
      address: ARC_TESTNET.coreBridge,
      event: getAbiItem({ abi: eventsAbi, name: 'LogMessagePublished' }),
      args: { sender: emitter },
      fromBlock: infrastructure.fromBlock, toBlock: 'latest',
    })
    return logs.map((log) => ({
      sequence: log.args.sequence!, nonce: Number(log.args.nonce!), consistencyLevel: Number(log.args.consistencyLevel!),
      payload: Uint8Array.from(Buffer.from(log.args.payload!.slice(2), 'hex')),
      transaction: log.transactionHash, blockNumber: log.blockNumber,
    }))
  }

  /** The NTT manager message the hub published, re-encoded and checked against the published bytes. */
  const managerMessageOf = (payload: Uint8Array) => {
    const decoded = decodeTransceiverMessage(payload)
    const managerLength = (payload[68] << 8) | payload[69]
    const raw = payload.subarray(70, 70 + managerLength)
    const reencoded = encodeNttManagerMessage(decoded.managerPayload)
    if (raw.length !== reencoded.length || !raw.every((byte, index) => byte === reencoded[index])) {
      throw new Error('The published manager message does not re-encode to the bytes on chain')
    }
    return decoded
  }

  return {
    version: `arc-solana-fulfillment-v1;evm=c636cc15b07969e4b44de7e466c999c07e7387a9;svm=${SOLANA_NTT.commit};factory=${infrastructure.factory};registry=${infrastructure.registry};distributor=${infrastructure.distributor};asset=${infrastructure.paymentAsset}`,
    terms: {
      chainId: ARC_TESTNET.evmChainId, asset: infrastructure.paymentAsset, payTo: arc.account,
      name: options.paymentName ?? 'USDC-FIXTURE', version: options.paymentVersion ?? '2',
    },

    assertReady(request: LaunchRequest) {
      // The spoke's manager keeps one config PDA per deployed program, so the pinned programs back
      // one mint at a time. Quoting a second concurrent launch against them would put two issuances
      // behind one set of custody figures, which is exactly what the accounting must never allow.
      if (BigInt(request.canonical.issuance) > 18446744073709551615n) {
        throw new LaunchError(400, 'invalid_request', 'The canonical issuance must fit the token\'s uint64 constructor argument.')
      }
    },

    budgets(): Record<StepKind, Atoms> {
      // Allowances, not predictions: the observed Arc network fee is checked against them and a step
      // whose real cost exceeded its allowance fails rather than quietly overspending the payer.
      return { payment: '20000000', canonical: '20000000', manager: '60000000', debit: '20000000', credit: '20000000', pool: '20000000' }
    },

    async plan({ job, step }: EffectContext): Promise<StepPlan> {
      const operation = operationOf(job, step)
      switch (step.kind) {
        case 'payment': {
          const payment = job.payment
          if (!payment) throw new LaunchError(402, 'payment_required', 'The signed authorization is not on the job yet.')
          const a = payment.authorization
          return { kind: 'payment', asset: infrastructure.paymentAsset, from: a.from, to: a.to, value: a.value, validAfter: a.validAfter, validBefore: a.validBefore, nonce: a.nonce, signature: payment.signature } satisfies PaymentPlan
        }
        case 'canonical':
          return { kind: 'canonical', identity: operation, name: job.request.canonical.name, symbol: job.request.canonical.symbol, custody: arc.account, issuance: job.request.canonical.issuance } satisfies CanonicalPlan
        case 'manager':
          return { kind: 'leg', chain: step.chain === 'solana' ? 'solana' : 'arc', operation } satisfies LegPlan
        case 'debit': {
          const destination = destinationOf(job, step.chain)
          const leg = await arcLeg(job)
          // Read before anything is submitted and persisted with the plan: this is the only handle a
          // restarted worker has on a transfer the hub does not make idempotent itself.
          const expectedSequence = await client.readContract({ address: ARC_TESTNET.coreBridge, abi: coreBridgeAbi, functionName: 'nextSequence', args: [leg.transceiver] })
          return { kind: 'debit', amount: destination.amount, custodian: payer.publicKey.toBase58(), beneficiary: destination.recipient, expectedSequence: expectedSequence.toString() } satisfies DebitPlan
        }
        case 'credit': {
          const destination = destinationOf(job, step.chain)
          const debit = job.steps.find((candidate) => candidate.id === `debit:${step.chain}`)
          if (!debit?.prepared) throw new Error(`credit:${step.chain} cannot be planned before its debit was prepared`)
          const debitPlan = JSON.parse(debit.prepared.bytes) as { plan: DebitPlan }
          const leg = await arcLeg(job)
          const published = (await publishedFrom(leg.transceiver)).find((message) => message.sequence.toString() === debitPlan.plan.expectedSequence)
          if (!published) throw new Error(`No Arc message is published at sequence ${debitPlan.plan.expectedSequence}; the debit is not finalized`)
          const digest = managerMessageDigest(ARC_CHAIN, managerMessageOf(published.payload).managerPayload)
          return { kind: 'credit', amount: destination.amount, custodian: payer.publicKey.toBase58(), digest: toHex(digest), sequence: debitPlan.plan.expectedSequence } satisfies CreditPlan
        }
        case 'pool': {
          const destination = destinationOf(job, step.chain)
          const delivered = (BigInt(destination.amount) - BigInt(destination.poolTokens)).toString()
          const holder = step.chain === 'solana'
            ? Keypair.fromSeed(solanaSeed(operation, 'inventory')).publicKey.toBase58()
            : inventoryHolder(operation)
          return { kind: 'inventory', chain: step.chain === 'solana' ? 'solana' : 'arc', tokens: destination.poolTokens, quote: destination.poolQuote, holder, recipient: destination.recipient, delivered } satisfies InventoryPlan
        }
        default:
          throw new Error(`No Arc–Solana plan for step kind ${step.kind as string}`)
      }
    },

    async observe({ job, step }: EffectContext, plan: StepPlan): Promise<EffectResult | 'absent' | 'pending'> {
      const operation = operationOf(job, step)
      switch (plan.kind) {
        case 'payment': {
          const used = await client.readContract({ address: plan.asset, abi: paymentAbi, functionName: 'authorizationState', args: [plan.from, plan.nonce] })
          if (!used) return 'absent'
          const logs = await client.getLogs({
            address: plan.asset,
            event: getAbiItem({ abi: eventsAbi, name: 'AuthorizationUsed' }),
            args: { authorizer: plan.from, nonce: plan.nonce },
            fromBlock: infrastructure.fromBlock, toBlock: 'latest',
          })
          // The nonce is consumed but its event is not readable yet: unresolved, never absent.
          if (!logs.length) return 'pending'
          return { operation, transaction: logs[0].transactionHash, finalized: true, cost: '0', amount: plan.value }
        }
        case 'canonical': {
          const token = await client.readContract({ address: infrastructure.factory, abi: factoryAbi, functionName: 'tokenOf', args: [plan.identity] })
          if (/^0x0+$/.test(token)) return 'absent'
          const logs = await client.getLogs({
            address: infrastructure.factory,
            event: getAbiItem({ abi: eventsAbi, name: 'Issued' }),
            args: { identity: plan.identity },
            fromBlock: infrastructure.fromBlock, toBlock: 'latest',
          })
          if (!logs.length) return 'pending'
          const supply = await client.readContract({ address: token, abi: erc20Abi, functionName: 'totalSupply' })
          if (supply !== BigInt(plan.issuance)) throw new Error(`The issued token's supply is ${supply}, not the bound issuance ${plan.issuance}`)
          return { operation, transaction: logs[0].transactionHash, finalized: true, cost: await arcCost(client, logs[0].transactionHash), address: token, amount: plan.issuance }
        }
        case 'leg': {
          if (plan.chain === 'arc') {
            const leg = await client.readContract({ address: infrastructure.registry, abi: registryAbi, functionName: 'legOf', args: [plan.operation] })
            if (/^0x0+$/.test(leg.manager)) return 'absent'
            const logs = await client.getLogs({
              address: infrastructure.registry,
              event: getAbiItem({ abi: eventsAbi, name: 'LegRegistered' }),
              args: { operation: plan.operation },
              fromBlock: infrastructure.fromBlock, toBlock: 'latest',
            })
            if (!logs.length) return 'pending'
            const token = await canonicalToken(job)
            if (leg.token.toLowerCase() !== token.toLowerCase()) throw new Error('The registered Arc leg belongs to a different token than this job issued')
            return { operation, transaction: logs[0].transactionHash, finalized: true, cost: await arcCost(client, logs[0].transactionHash), address: leg.manager }
          }
          const spoke = spokeOf(job)
          // Every account the leg needs, with the last one written checked too: a leg interrupted
          // halfway reads as absent, and its submission resumes from whichever part is missing.
          const required = [spoke.at.config, spoke.at.registeredTransceiver(spoke.transceiver), spoke.at.peer(ARC_CHAIN), spoke.at.transceiverPeer(ARC_CHAIN)]
          for (const account of required) if (!await accountExists(account)) return 'absent'
          const config = decodeConfig((await live().getAccountInfo(spoke.at.config, 'confirmed'))!.data)
          if (!config.mint.equals(spoke.mint)) {
            throw new Error(`The spoke manager config is bound to mint ${config.mint.toBase58()}, not this job's ${spoke.mint.toBase58()}. The pinned programs hold one config, so this launch cannot share them.`)
          }
          if (config.mode !== BURNING || config.chainId !== SOLANA_CHAIN || config.threshold !== 1) {
            throw new Error('The spoke manager config is not a one-transceiver burning spoke on Solana')
          }
          const mint = await readMint(live(), spoke.mint)
          if (mint.decimals !== DECIMALS || mint.mintAuthority?.equals(spoke.at.tokenAuthority) !== true) {
            throw new Error('The spoke mint is not a six-decimal mint under the manager token authority')
          }
          return { operation, transaction: solanaEvidence('config', spoke.at.config), finalized: true, cost: '0', address: spoke.mint.toBase58() }
        }
        case 'debit': {
          const leg = await arcLeg(job)
          const published = await publishedFrom(leg.transceiver)
          const expected = published.find((message) => message.sequence.toString() === plan.expectedSequence)
          if (!expected) {
            // Fail closed rather than submit again if the debit's own bytes turned up elsewhere:
            // the recorded sequence is the only handle on this effect, and a matching payload at a
            // different sequence means the handle is wrong, not that the effect never happened.
            for (const message of published) {
              const decoded = decodeTransceiverMessage(message.payload)
              if (decoded.managerPayload.payload.toChain === SOLANA_CHAIN
                && decoded.managerPayload.payload.amount.amount === trimAmount(BigInt(plan.amount), DECIMALS, DECIMALS).amount) {
                throw new Error(`A matching debit is published at sequence ${message.sequence} rather than the recorded ${plan.expectedSequence}; reconcile this job before retrying.`)
              }
            }
            return 'absent'
          }
          const decoded = managerMessageOf(expected.payload)
          const trimmed = trimAmount(BigInt(plan.amount), DECIMALS, DECIMALS)
          const custodian = bytes32(new PublicKey(plan.custodian))
          if (decoded.managerPayload.payload.toChain !== SOLANA_CHAIN
            || decoded.managerPayload.payload.amount.amount !== trimmed.amount
            || decoded.managerPayload.payload.amount.decimals !== trimmed.decimals
            || !decoded.managerPayload.payload.to.every((byte, index) => byte === custodian[index])) {
            throw new Error(`The Arc message at sequence ${plan.expectedSequence} is not this debit; something else took the recorded sequence.`)
          }
          return { operation, transaction: expected.transaction, finalized: true, cost: await arcCost(client, expected.transaction), address: leg.manager, amount: plan.amount }
        }
        case 'credit': {
          const spoke = spokeOf(job)
          const digest = Uint8Array.from(Buffer.from(plan.digest.slice(2), 'hex'))
          const inbox = spoke.at.inboxItem(digest)
          const account = await live().getAccountInfo(inbox, 'confirmed')
          // Not yet redeemed, or redeemed and not yet released. Both mean this credit has not been
          // delivered; both are safe to submit, because the program refuses a second release and the
          // submission resumes from whichever part of the delivery is missing.
          if (!account) return 'absent'
          const item = decodeInboxItem(account.data)
          if (item.status !== 'released') return 'absent'
          if (item.amount !== BigInt(plan.amount)) throw new Error(`The released claim carries ${item.amount} atoms, not the bound allocation ${plan.amount}`)
          const custody = associatedTokenAddress(spoke.mint, new PublicKey(plan.custodian))
          const held = await readTokenBalance(live(), custody)
          if (held < BigInt(plan.amount)) throw new Error(`The credited account holds ${held} atoms, fewer than the ${plan.amount} this claim released`)
          return { operation, transaction: solanaEvidence('inbox', inbox), finalized: true, cost: '0', address: custody.toBase58(), amount: plan.amount }
        }
        case 'inventory': {
          if (plan.chain === 'arc') {
            const placement = await client.readContract({ address: infrastructure.distributor, abi: distributorAbi, functionName: 'placementOf', args: [operation] })
            if (!placement.placed) return 'absent'
            if (placement.poolTokens !== BigInt(plan.tokens) || placement.poolQuote !== BigInt(plan.quote) || placement.delivered !== BigInt(plan.delivered)) {
              throw new Error('The recorded Arc placement does not match this step\'s bound inventory')
            }
            const logs = await client.getLogs({
              address: infrastructure.distributor,
              event: getAbiItem({ abi: eventsAbi, name: 'InventoryPlaced' }),
              args: { operation },
              fromBlock: infrastructure.fromBlock, toBlock: 'latest',
            })
            if (!logs.length) return 'pending'
            return { operation, transaction: logs[0].transactionHash, finalized: true, cost: await arcCost(client, logs[0].transactionHash), address: plan.holder, amount: plan.tokens, quoteAmount: plan.quote }
          }
          const spoke = spokeOf(job)
          const holder = new PublicKey(plan.holder)
          const tokenAccount = associatedTokenAddress(spoke.mint, holder)
          if (!await accountExists(tokenAccount)) return 'absent'
          const tokens = await readTokenBalance(live(), tokenAccount)
          const quote = await readTokenBalance(live(), associatedTokenAddress(infrastructure.quoteMint.publicKey, holder))
          if (tokens !== BigInt(plan.tokens) || quote !== BigInt(plan.quote)) {
            throw new Error(`The Solana inventory holder holds ${tokens} tokens and ${quote} quote, not the bound ${plan.tokens} and ${plan.quote}`)
          }
          const delivered = await readTokenBalance(live(), associatedTokenAddress(spoke.mint, new PublicKey(plan.recipient)))
          if (delivered < BigInt(plan.delivered)) throw new Error(`The Solana recipient holds ${delivered} atoms, fewer than the ${plan.delivered} this placement delivered`)
          return { operation, transaction: solanaEvidence('inventory', tokenAccount), finalized: true, cost: '0', address: plan.holder, amount: plan.tokens, quoteAmount: plan.quote }
        }
      }
    },

    async submit({ job, step }: EffectContext, plan: StepPlan): Promise<void> {
      switch (plan.kind) {
        case 'payment':
          await call(arc, plan.asset, paymentContract, 'transferWithAuthorization',
            [plan.from, plan.to, BigInt(plan.value), BigInt(plan.validAfter), BigInt(plan.validBefore), plan.nonce, plan.signature])
          return
        case 'canonical':
          await call(arc, infrastructure.factory, factoryContract, 'issue',
            [plan.identity, job.id, plan.name, plan.symbol, plan.custody, BigInt(plan.issuance)])
          return
        case 'leg': {
          if (plan.chain === 'arc') {
            const token = await canonicalToken(job)
            const issuance = BigInt(job.request.canonical.issuance)
            const libraries = { TransceiverStructs: infrastructure.structs }
            const managerImpl = await deploy(arc, linkLibraries(artifact('NttManager'), libraries), [token, LOCKING, ARC_CHAIN, BigInt(RATE_LIMIT_DURATION), false])
            const manager = await deploy(arc, artifact('ERC1967Proxy'), [managerImpl, '0x'])
            await call(arc, manager, managerContract, 'initialize')
            await call(arc, manager, managerContract, 'setOutboundLimit', [issuance])
            const transceiverImpl = await deploy(arc, linkLibraries(artifact('WormholeTransceiver'), libraries), [manager, ARC_TESTNET.coreBridge, 0, 0, 0, `0x${''.padEnd(40, '0')}`])
            const transceiver = await deploy(arc, artifact('ERC1967Proxy'), [transceiverImpl, '0x'])
            await call(arc, transceiver, transceiverContract, 'initialize')
            await call(arc, manager, managerContract, 'setTransceiver', [transceiver])
            await call(arc, manager, managerContract, 'setThreshold', [1])
            // The spoke's manager program id and transceiver emitter PDA are both properties of the
            // pinned programs, so the far peers can be registered before the spoke's own leg exists.
            const spoke = spokeOf(job)
            await call(arc, manager, managerContract, 'setPeer', [SOLANA_CHAIN, toHex(bytes32(spoke.manager)), DECIMALS, issuance])
            await call(arc, manager, managerContract, 'setInboundLimit', [issuance, SOLANA_CHAIN])
            await call(arc, transceiver, transceiverContract, 'setWormholePeer', [SOLANA_CHAIN, toHex(bytes32(spoke.at.emitter))])
            // The commit point. Everything above is inert until this records it against the operation.
            await call(arc, infrastructure.registry, registryContract, 'registerLeg', [plan.operation, token, manager, transceiver])
            return
          }
          const spoke = spokeOf(job)
          const mintKeypair = Keypair.fromSeed(solanaSeed(plan.operation, 'mint'))
          const issuance = BigInt(job.request.canonical.issuance)
          if (!await accountExists(spoke.mint)) {
            await send(live(), payer, [
              await createMintAccount(live(), payer.publicKey, mintKeypair.publicKey),
              initializeMint2(mintKeypair.publicKey, DECIMALS, payer.publicKey),
              setMintAuthority(mintKeypair.publicKey, payer.publicKey, spoke.at.tokenAuthority),
              createAssociatedTokenAccount(payer.publicKey, payer.publicKey, mintKeypair.publicKey),
            ], [mintKeypair])
          }
          if (!await accountExists(spoke.at.config)) {
            await send(live(), payer, [spoke.initialize(payer.publicKey, admin.publicKey, SOLANA_CHAIN, issuance, BURNING)], [admin])
          }
          if (!await accountExists(spoke.at.registeredTransceiver(spoke.transceiver))) {
            await send(live(), payer, [spoke.registerTransceiver(payer.publicKey, admin.publicKey), spoke.setThreshold(admin.publicKey, 1)], [admin])
          }
          if (!await accountExists(spoke.at.peer(ARC_CHAIN))) {
            const leg = await arcLeg(job)
            await send(live(), payer, [
              spoke.setPeer(payer.publicKey, admin.publicKey, ARC_CHAIN, evmToWormholeFormat(leg.manager), issuance, DECIMALS),
              spoke.setInboundLimit(admin.publicKey, ARC_CHAIN, issuance),
            ], [admin])
          }
          if (!await accountExists(spoke.at.transceiverPeer(ARC_CHAIN))) {
            const leg = await arcLeg(job)
            await send(live(), payer, [spoke.setWormholePeer(payer.publicKey, admin.publicKey, ARC_CHAIN, evmToWormholeFormat(leg.transceiver))], [admin])
          }
          return
        }
        case 'debit': {
          const token = await canonicalToken(job)
          const leg = await arcLeg(job)
          const amount = BigInt(plan.amount)
          const allowance = await client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [arc.account, leg.manager] })
          if (allowance < amount) await call(arc, token, tokenContract, 'approve', [leg.manager, amount])
          await call(arc, leg.manager, managerContract, 'transfer', [amount, SOLANA_CHAIN, toHex(bytes32(new PublicKey(plan.custodian)))])
          return
        }
        case 'credit': {
          const spoke = spokeOf(job)
          const leg = await arcLeg(job)
          const published = (await publishedFrom(leg.transceiver)).find((message) => message.sequence.toString() === plan.sequence)
          if (!published) throw new Error(`No Arc message is published at sequence ${plan.sequence}; the debit this credit delivers is not finalized`)
          const decoded = managerMessageOf(published.payload)
          const digest = managerMessageDigest(ARC_CHAIN, decoded.managerPayload)
          if (toHex(digest) !== plan.digest) throw new Error('The published Arc bytes no longer digest to the recorded claim')
          const messageId = decoded.managerPayload.id
          const sentBlock = await client.getBlock({ blockNumber: published.blockNumber })
          // GUARDIAN FIXTURE: the development key signs over the bytes Arc actually published.
          if (!await accountExists(spoke.at.transceiverMessage(ARC_CHAIN, messageId))) {
            const posted = await postVaa(live(), payer, spoke, {
              timestamp: Number(sentBlock.timestamp), nonce: published.nonce, emitterChain: ARC_CHAIN,
              emitterAddress: evmToWormholeFormat(leg.transceiver), sequence: published.sequence,
              consistencyLevel: published.consistencyLevel, payload: published.payload,
            })
            await send(live(), payer, [spoke.receiveWormholeMessage(payer.publicKey, posted.posted, ARC_CHAIN, messageId)])
          }
          const inbox = spoke.at.inboxItem(digest)
          if (!await accountExists(inbox)) {
            await send(live(), payer, [spoke.redeem(payer.publicKey, ARC_CHAIN, messageId, digest)])
          }
          const custody = associatedTokenAddress(spoke.mint, new PublicKey(plan.custodian))
          await send(live(), payer, [spoke.releaseInboundMint(payer.publicKey, digest, custody, true)])
          return
        }
        case 'inventory': {
          const operation = operationOf(job, step)
          if (plan.chain === 'arc') {
            const token = await canonicalToken(job)
            const needed = BigInt(plan.tokens) + BigInt(plan.delivered)
            const tokenAllowance = await client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [arc.account, infrastructure.distributor] })
            if (tokenAllowance < needed) await call(arc, token, tokenContract, 'approve', [infrastructure.distributor, needed])
            const quoteAllowance = await client.readContract({ address: infrastructure.quoteAsset, abi: erc20Abi, functionName: 'allowance', args: [arc.account, infrastructure.distributor] })
            if (quoteAllowance < BigInt(plan.quote)) await call(arc, infrastructure.quoteAsset, tokenContract, 'approve', [infrastructure.distributor, BigInt(plan.quote)])
            // One call: inventory and the recipient's share move together or not at all.
            await call(arc, infrastructure.distributor, distributorContract, 'place',
              [operation, token, infrastructure.quoteAsset, plan.holder, plan.recipient, BigInt(plan.tokens), BigInt(plan.quote), BigInt(plan.delivered)])
            return
          }
          const spoke = spokeOf(job)
          const holder = Keypair.fromSeed(solanaSeed(operation, 'inventory')).publicKey
          const recipient = new PublicKey(plan.recipient)
          const quoteMint = infrastructure.quoteMint.publicKey
          const from = associatedTokenAddress(spoke.mint, payer.publicKey)
          const instructions: TransactionInstruction[] = []
          // A Solana transaction is atomic, so the whole distribution is one effect: the holder's
          // token account existing with the bound balance is only reachable together with the rest.
          for (const [mint, owner] of [[spoke.mint, holder], [quoteMint, holder], [spoke.mint, recipient]] as const) {
            if (!await accountExists(associatedTokenAddress(mint, owner))) {
              instructions.push(createAssociatedTokenAccount(payer.publicKey, owner, mint))
            }
          }
          if (BigInt(plan.tokens) > 0n) instructions.push(transferChecked(from, spoke.mint, associatedTokenAddress(spoke.mint, holder), payer.publicKey, BigInt(plan.tokens), DECIMALS))
          if (BigInt(plan.quote) > 0n) instructions.push(transferChecked(associatedTokenAddress(quoteMint, payer.publicKey), quoteMint, associatedTokenAddress(quoteMint, holder), payer.publicKey, BigInt(plan.quote), DECIMALS))
          if (BigInt(plan.delivered) > 0n) instructions.push(transferChecked(from, spoke.mint, associatedTokenAddress(spoke.mint, recipient), payer.publicKey, BigInt(plan.delivered), DECIMALS))
          await send(live(), payer, instructions)
          return
        }
      }
    },

    /**
     * Both halves of the ledger, each read from its own chain.
     *
     * Nothing here is derived from anything else here: the issuance and the custody figure come from
     * the Arc token and its locking manager, the spoke figures from the SPL mint and the manager's
     * custody account. That is what lets the comparison fail.
     */
    async observeLedger(job: Job, pending: RoutePending): Promise<ObservedRoute> {
      const token = await canonicalToken(job)
      const leg = await arcLeg(job)
      const spoke = spokeOf(job)
      const issuance = await client.readContract({ address: token, abi: erc20Abi, functionName: 'totalSupply' })
      const hubCustody = await client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [leg.manager] })
      const mint = await readMint(live(), spoke.mint)
      return {
        issuance, hubCustody, hubCirculating: issuance - hubCustody,
        spokeSupply: mint.supply,
        spokeCustody: await accountExists(spoke.custody()) ? await readTokenBalance(live(), spoke.custody()) : 0n,
        pendingToSpoke: pending.toSpoke, pendingToHub: pending.toHub,
      }
    },
  }
}

/**
 * Restart the spoke validator in place, keeping its ledger, so recovery can be exercised.
 *
 * The replacement client is written back onto the infrastructure record, because the route reads it
 * from there: after a SIGKILL the old client's sockets are gone, and a route still holding it would
 * report every account as unreachable rather than as present.
 */
export async function restartSpoke(infrastructure: RouteInfrastructure, validator: ChildProcess | null, signal: NodeJS.Signals = 'SIGKILL'): Promise<ChildProcess> {
  stopValidator(validator, signal)
  await new Promise((done) => setTimeout(done, 3_000))
  const next = startValidator(
    { cwd: SVM, deploy: DEPLOY, fixtures: join(SVM, 'programs/example-native-token-transfers/tests/fixtures'), accounts: join(SVM, 'tests/accounts/mainnet') },
    infrastructure.ledger, { rpc: infrastructure.rpcPort, faucet: infrastructure.rpcPort + 101 }, false, infrastructure.admin.publicKey,
  )
  infrastructure.connection = new Connection(`http://127.0.0.1:${infrastructure.rpcPort}`, 'confirmed')
  await waitForHealth(infrastructure.connection)
  return next
}
