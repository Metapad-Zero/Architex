import { randomBytes } from 'node:crypto'
import { Connection, Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js'
import type { Address, Hex } from 'viem'
import { evmToWormholeFormat } from '../../../src/lib/equilibriumArcSolana'
import {
  SOLANA_NTT, bytes32, decodeTransceiverMessage, encodeNttManagerMessage, leBytes, managerMessageDigest, nttAddresses, toHex, trimAmount, TOKEN_PROGRAM,
} from '../../../src/lib/equilibriumSolana'
import { BURNING, NttDeployment, decodeConfig, decodeInboxItem } from '../../../scripts/solana/nttClient'
import { postVaa, readChainClock, send } from '../../../scripts/solana/localValidator'
import {
  associatedTokenAddress, createAssociatedTokenAccount, createMintAccount, initializeMint2, readMint, readTokenBalance, setMintAuthority,
} from '../../../scripts/solana/splToken'
import { solanaInventoryOwner, spokeClaim } from '../solanaRoute'
import type { EffectResult, Job, Observation, Step } from '../types'
import type { Published } from '../evm/vaa'

/**
 * The Solana spoke of the composed launch job: the pinned SVM NTT manager and transceiver on a local
 * `solana-test-validator`, peered to the SAME Arc locking hub that backs the Base and Robinhood
 * spokes. Everything here is the Solana half of three steps; the debit that feeds it is an ordinary
 * Arc executor operation in the composition, so its idempotency is the executor's.
 *
 * The step logic is the queued-claim branch's (7d17874, scripts/solana/fulfillRoute.ts), re-keyed to
 * the composition's hub: the spoke peers the executor-deployed hub manager and transceiver instead of
 * a registry leg, and the credit delivers the bytes the hub published in the debit's own receipt.
 *
 *  - manager:solana  a random mint secret persisted in the plan, the mint under the manager's token
 *                    authority, the burning config, the transceiver and both Arc peers. Observed from
 *                    the accounts themselves, so a leg interrupted halfway resumes from what is missing.
 *  - credit:solana   post the VAA, receive, redeem, release — keyed by the manager-message digest
 *                    the spoke's inbox item and replay guard use. A delivery the spoke's inbound rate
 *                    limit holds is a claim, never an absence and never a result.
 *  - pool:solana     inventory to an unsignable program-derived holder and the rest to the
 *                    recipient, in one atomic transaction.
 *
 * FIXTURES: one development guardian key in the validator's core bridge, a fixture quote mint, and a
 * validator whose clock is only moved by rebuilding its ledger (scripts/solana/clockShift.ts).
 */
export const SPOKE_MANAGER = new PublicKey(SOLANA_NTT.manager)
export const SPOKE_TRANSCEIVER = new PublicKey(SOLANA_NTT.transceiver)
export const SPOKE_CORE_BRIDGE = new PublicKey(SOLANA_NTT.coreBridge)
export const SPOKE_PROGRAMS = [SPOKE_MANAGER, SPOKE_TRANSCEIVER, SPOKE_CORE_BRIDGE, TOKEN_PROGRAM] as const
const SPOKE = nttAddresses(SPOKE_MANAGER, SPOKE_TRANSCEIVER, SPOKE_CORE_BRIDGE)
const DECIMALS = SOLANA_NTT.decimals

export interface SolanaSpokeInfrastructure {
  /** Replaced when the validator restarts; read through this record every time, never captured. */
  connection: Connection
  rpcPort: number
  ledger: string
  /** Fee payer, and the owner of the account each bridged allocation is credited to. */
  payer: Keypair
  /** The NTT deployment owner; also the validator's program upgrade authority. */
  admin: Keypair
  /** Fixture quote mint; the payer holds its supply as pre-positioned spoke quote inventory. */
  quoteMint: PublicKey
}
export interface SolanaSpokeConfig {
  infrastructure: SolanaSpokeInfrastructure
  /** The spoke's inbound limit for the Arc peer. Unset: the whole issuance, so no claim of the launch is held. */
  inboundLimit?: bigint
}

export interface SolanaLegPlan { kind: 'leg'; mintSecret: Hex; hubManager: Address; hubTransceiver: Address; issuance: string }
export interface SolanaCreditPlan { kind: 'credit'; amount: string; custodian: string; digest: Hex; message: { timestamp: number; nonce: number; emitter: Hex; sequence: string; consistencyLevel: number; payload: Hex } }
export interface SolanaInventoryPlan { kind: 'inventory'; tokens: string; quote: string; holder: string; recipient: string; delivered: string }
export type SolanaPlan = SolanaLegPlan | SolanaCreditPlan | SolanaInventoryPlan

/** The account an Arc debit names as the Solana recipient: the launch's own custody owner. */
export const custodianOf = (config: SolanaSpokeConfig) => config.infrastructure.payer.publicKey
/** What the Arc hub peers to: the pinned manager program and the transceiver's emitter PDA. */
export const hubPeers = () => ({ chain: SOLANA_NTT.solanaWormholeId, manager: toHex(bytes32(SPOKE_MANAGER)), emitter: toHex(bytes32(SPOKE.emitter)) })

/** The mint the job's persisted manager:solana plan holds the secret for. */
export function spokeOf(job: Job): NttDeployment {
  const step = job.steps.find((s) => s.id === 'manager:solana')
  if (!step?.prepared) throw new Error('The Solana leg has not been prepared, so this job has no mint yet')
  const plan = (JSON.parse(step.prepared.bytes) as { plan: SolanaPlan }).plan
  if (plan.kind !== 'leg') throw new Error('The Solana leg plan is not a leg')
  return new NttDeployment(SPOKE_MANAGER, SPOKE_TRANSCEIVER, SPOKE_CORE_BRIDGE, Keypair.fromSeed(Buffer.from(plan.mintSecret.slice(2), 'hex')).publicKey)
}

/** Durable evidence on Solana is the account itself; a signature depends on history a restarted validator need not keep. */
const evidence = (what: string, address: PublicKey) => `solana:${what}:${address.toBase58()}`

function transferChecked(source: PublicKey, mint: PublicKey, destination: PublicKey, owner: PublicKey, amount: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM,
    keys: [{ pubkey: source, isSigner: false, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: false }, { pubkey: destination, isSigner: false, isWritable: true }, { pubkey: owner, isSigner: true, isWritable: false }],
    data: Buffer.concat([Buffer.from([12]), Buffer.from(leBytes(amount, 8)), Buffer.from([DECIMALS])]),
  })
}

export function solanaSpoke(config: SolanaSpokeConfig) {
  const infra = config.infrastructure
  const live = () => infra.connection
  const payer = () => infra.payer
  const exists = async (address: PublicKey) => (await live().getAccountInfo(address, 'confirmed')) !== null
  /** Lamports this process spent per operation, measured across each submission it made. */
  const lamports = new Map<Hex, bigint>()
  const measured = async (operation: Hex, run: () => Promise<void>) => {
    const before = await live().getBalance(payer().publicKey, 'confirmed')
    try { await run() } finally {
      const after = await live().getBalance(payer().publicKey, 'confirmed').catch(() => before)
      lamports.set(operation, (lamports.get(operation) ?? 0n) + BigInt(before - after))
    }
  }

  /** The NTT manager message the hub published, re-encoded and checked against the published bytes. */
  function managerMessageOf(payload: Uint8Array) {
    const decoded = decodeTransceiverMessage(payload)
    const length = (payload[68] << 8) | payload[69]
    const raw = payload.subarray(70, 70 + length)
    const reencoded = encodeNttManagerMessage(decoded.managerPayload)
    if (raw.length !== reencoded.length || !raw.every((b, i) => b === reencoded[i])) throw new Error('The published manager message does not re-encode to the bytes on chain')
    return decoded
  }

  return {
    version: `svm=${SOLANA_NTT.commit};spokeInbound=${config.inboundLimit?.toString() ?? 'issuance'}`,
    lamports,
    custodian: () => custodianOf(config).toBase58(),

    /** Fail before quoting if the validator is not serving the pinned programs. */
    async verify() {
      for (const program of [SPOKE_MANAGER, SPOKE_TRANSCEIVER, SPOKE_CORE_BRIDGE]) {
        const account = await live().getAccountInfo(program, 'confirmed')
        if (!account?.executable) throw new Error(`Solana program ${program.toBase58()} is not deployed on the local validator`)
      }
    },

    plan(job: Job, step: Step, operation: Hex, hub: { manager: Address; transceiver: Address }, published?: Published): SolanaPlan {
      const destination = job.request.destinations.find((d) => d.chain === 'solana')!
      if (step.kind === 'manager') {
        // Random and persisted with the plan before anything is submitted: recoverable after a restart,
        // and not a function of the public job id, so nobody who saw the quote can create the mint first.
        return { kind: 'leg', mintSecret: toHex(randomBytes(32)), hubManager: hub.manager, hubTransceiver: hub.transceiver, issuance: job.request.canonical.issuance }
      }
      if (step.kind === 'credit') {
        if (!published) throw new Error('credit:solana cannot be planned before debit:solana has a finalized published message')
        const payload = Buffer.from(published.payload.slice(2), 'hex')
        const digest = toHex(managerMessageDigest(SOLANA_NTT.arcWormholeId, managerMessageOf(payload).managerPayload))
        return { kind: 'credit', amount: destination.amount, custodian: custodianOf(config).toBase58(), digest,
          message: { timestamp: published.timestamp, nonce: published.nonce, emitter: published.emitter, sequence: published.sequence.toString(), consistencyLevel: published.consistencyLevel, payload: published.payload } }
      }
      if (step.kind === 'pool') {
        return { kind: 'inventory', tokens: destination.poolTokens, quote: destination.poolQuote, holder: solanaInventoryOwner(operation).toBase58(),
          recipient: destination.recipient, delivered: (BigInt(destination.amount) - BigInt(destination.poolTokens)).toString() }
      }
      throw new Error(`No Solana plan for ${step.id}`)
    },

    /** Whether the bridged message the Arc debit published is exactly the allocation to the custodian. */
    checkDebit(job: Job, published: Published) {
      const destination = job.request.destinations.find((d) => d.chain === 'solana')!
      const decoded = managerMessageOf(Buffer.from(published.payload.slice(2), 'hex'))
      const trimmed = trimAmount(BigInt(destination.amount), DECIMALS, DECIMALS)
      const to = bytes32(custodianOf(config))
      const p = decoded.managerPayload.payload
      if (p.toChain !== SOLANA_NTT.solanaWormholeId || p.amount.amount !== trimmed.amount || p.amount.decimals !== trimmed.decimals || !p.to.every((b, i) => b === to[i])) {
        throw new Error('debit:solana published a transfer other than this job\'s Solana allocation to its custody account')
      }
    },

    async observe(job: Job, operation: Hex, plan: SolanaPlan): Promise<Observation> {
      if (plan.kind === 'leg') {
        const spoke = spokeOf(job)
        // The last account written is required too: a leg interrupted halfway reads as absent.
        for (const account of [spoke.at.config, spoke.at.registeredTransceiver(spoke.transceiver), spoke.at.peer(SOLANA_NTT.arcWormholeId), spoke.at.transceiverPeer(SOLANA_NTT.arcWormholeId)]) {
          if (!await exists(account)) return 'absent'
        }
        const state = decodeConfig((await live().getAccountInfo(spoke.at.config, 'confirmed'))!.data)
        if (!state.mint.equals(spoke.mint)) throw new Error(`The spoke manager config is bound to mint ${state.mint.toBase58()}, not this job's ${spoke.mint.toBase58()}. The pinned programs hold one config, so this launch cannot share them.`)
        if (state.mode !== BURNING || state.chainId !== SOLANA_NTT.solanaWormholeId || state.threshold !== 1) throw new Error('The spoke manager config is not a one-transceiver burning spoke on Solana')
        const mint = await readMint(live(), spoke.mint)
        if (mint.decimals !== DECIMALS || mint.mintAuthority?.equals(spoke.at.tokenAuthority) !== true) throw new Error('The spoke mint is not a six-decimal mint under the manager token authority')
        return { operation, transaction: evidence('config', spoke.at.config), finalized: true, cost: '0', address: spoke.mint.toBase58() } satisfies EffectResult
      }
      if (plan.kind === 'credit') {
        const spoke = spokeOf(job)
        const digest = Buffer.from(plan.digest.slice(2), 'hex')
        const inbox = spoke.at.inboxItem(digest)
        const account = await live().getAccountInfo(inbox, 'confirmed')
        if (!account) return 'absent'
        const item = decodeInboxItem(account.data)
        // Read against the Clock sysvar the manager compares against, never the host's clock.
        const clock = item.status === 'release_after' ? await readChainClock(live()) : 0n
        const queued = spokeClaim({ kind: 'credit', amount: plan.amount, custodian: plan.custodian, digest: plan.digest, sequence: plan.message.sequence },
          { amount: item.amount, recipient: item.recipient.toBase58(), status: item.status, releaseAfter: item.releaseAfter }, clock, Math.floor(Date.now() / 1000))
        if (queued) return { queued }
        if (item.status !== 'released') return 'absent'
        const custody = associatedTokenAddress(spoke.mint, new PublicKey(plan.custodian))
        const held = await readTokenBalance(live(), custody)
        if (held < BigInt(plan.amount)) throw new Error(`The credited account holds ${held} atoms, fewer than the ${plan.amount} this claim released`)
        return { operation, transaction: evidence('inbox', inbox), finalized: true, cost: '0', address: custody.toBase58(), amount: plan.amount }
      }
      const spoke = spokeOf(job)
      const holder = new PublicKey(plan.holder)
      const tokenAccount = associatedTokenAddress(spoke.mint, holder)
      if (!await exists(tokenAccount)) return 'absent'
      const tokens = await readTokenBalance(live(), tokenAccount)
      const quote = await readTokenBalance(live(), associatedTokenAddress(infra.quoteMint, holder))
      if (tokens !== BigInt(plan.tokens) || quote !== BigInt(plan.quote)) throw new Error(`The Solana inventory holder holds ${tokens} tokens and ${quote} quote, not the bound ${plan.tokens} and ${plan.quote}`)
      const delivered = await readTokenBalance(live(), associatedTokenAddress(spoke.mint, new PublicKey(plan.recipient)))
      if (delivered < BigInt(plan.delivered)) throw new Error(`The Solana recipient holds ${delivered} atoms, fewer than the ${plan.delivered} this placement delivered`)
      return { operation, transaction: evidence('inventory', tokenAccount), finalized: true, cost: '0', address: plan.holder, amount: plan.tokens, quoteAmount: plan.quote }
    },

    async submit(job: Job, operation: Hex, plan: SolanaPlan): Promise<void> {
      await measured(operation, async () => {
        const p = payer()
        if (plan.kind === 'leg') {
          const mintKey = Keypair.fromSeed(Buffer.from(plan.mintSecret.slice(2), 'hex'))
          const spoke = new NttDeployment(SPOKE_MANAGER, SPOKE_TRANSCEIVER, SPOKE_CORE_BRIDGE, mintKey.publicKey)
          const issuance = BigInt(plan.issuance)
          if (!await exists(spoke.mint)) {
            await send(live(), p, [await createMintAccount(live(), p.publicKey, mintKey.publicKey), initializeMint2(mintKey.publicKey, DECIMALS, p.publicKey),
              setMintAuthority(mintKey.publicKey, p.publicKey, spoke.at.tokenAuthority), createAssociatedTokenAccount(p.publicKey, p.publicKey, mintKey.publicKey)], [mintKey])
          }
          if (!await exists(spoke.at.config)) await send(live(), p, [spoke.initialize(p.publicKey, infra.admin.publicKey, SOLANA_NTT.solanaWormholeId, issuance, BURNING)], [infra.admin])
          if (!await exists(spoke.at.registeredTransceiver(spoke.transceiver))) await send(live(), p, [spoke.registerTransceiver(p.publicKey, infra.admin.publicKey), spoke.setThreshold(infra.admin.publicKey, 1)], [infra.admin])
          if (!await exists(spoke.at.peer(SOLANA_NTT.arcWormholeId))) {
            await send(live(), p, [spoke.setPeer(p.publicKey, infra.admin.publicKey, SOLANA_NTT.arcWormholeId, evmToWormholeFormat(plan.hubManager), issuance, DECIMALS),
              // The queue is decided by this limit. A launch wants the whole issuance; a smaller one is pinned into the adapter version.
              spoke.setInboundLimit(infra.admin.publicKey, SOLANA_NTT.arcWormholeId, config.inboundLimit ?? issuance)], [infra.admin])
          }
          if (!await exists(spoke.at.transceiverPeer(SOLANA_NTT.arcWormholeId))) {
            await send(live(), p, [spoke.setWormholePeer(p.publicKey, infra.admin.publicKey, SOLANA_NTT.arcWormholeId, evmToWormholeFormat(plan.hubTransceiver))], [infra.admin])
          }
          return
        }
        if (plan.kind === 'credit') {
          const spoke = spokeOf(job)
          const payload = Buffer.from(plan.message.payload.slice(2), 'hex')
          const decoded = managerMessageOf(payload)
          const digest = managerMessageDigest(SOLANA_NTT.arcWormholeId, decoded.managerPayload)
          if (toHex(digest) !== plan.digest) throw new Error('The published Arc bytes no longer digest to the recorded claim')
          const id = decoded.managerPayload.id
          // GUARDIAN FIXTURE: the development key signs over the bytes Arc actually published.
          if (!await exists(spoke.at.transceiverMessage(SOLANA_NTT.arcWormholeId, id))) {
            const posted = await postVaa(live(), p, spoke, { timestamp: plan.message.timestamp, nonce: plan.message.nonce, emitterChain: SOLANA_NTT.arcWormholeId,
              emitterAddress: Buffer.from(plan.message.emitter.slice(2), 'hex'), sequence: BigInt(plan.message.sequence), consistencyLevel: plan.message.consistencyLevel, payload })
            await send(live(), p, [spoke.receiveWormholeMessage(p.publicKey, posted.posted, SOLANA_NTT.arcWormholeId, id)])
          }
          const inbox = spoke.at.inboxItem(digest)
          if (!await exists(inbox)) await send(live(), p, [spoke.redeem(p.publicKey, SOLANA_NTT.arcWormholeId, id, digest)])
          // Stop after the redeem if the manager holds the claim it just wrote: the observation records it.
          const item = decodeInboxItem((await live().getAccountInfo(inbox, 'confirmed'))!.data)
          if (item.status === 'release_after' && item.releaseAfter !== null && await readChainClock(live()) < item.releaseAfter) return
          if (item.status === 'released') return
          await send(live(), p, [spoke.releaseInboundMint(p.publicKey, digest, associatedTokenAddress(spoke.mint, new PublicKey(plan.custodian)), true)])
          return
        }
        const spoke = spokeOf(job)
        const holder = new PublicKey(plan.holder)
        const recipient = new PublicKey(plan.recipient)
        const from = associatedTokenAddress(spoke.mint, p.publicKey)
        const instructions: TransactionInstruction[] = []
        // One Solana transaction: the holder's funded account is reachable only together with the rest.
        for (const [mint, owner] of [[spoke.mint, holder], [infra.quoteMint, holder], [spoke.mint, recipient]] as const) {
          if (!await exists(associatedTokenAddress(mint, owner))) instructions.push(createAssociatedTokenAccount(p.publicKey, owner, mint))
        }
        if (BigInt(plan.tokens) > 0n) instructions.push(transferChecked(from, spoke.mint, associatedTokenAddress(spoke.mint, holder), p.publicKey, BigInt(plan.tokens)))
        if (BigInt(plan.quote) > 0n) instructions.push(transferChecked(associatedTokenAddress(infra.quoteMint, p.publicKey), infra.quoteMint, associatedTokenAddress(infra.quoteMint, holder), p.publicKey, BigInt(plan.quote)))
        if (BigInt(plan.delivered) > 0n) instructions.push(transferChecked(from, spoke.mint, associatedTokenAddress(spoke.mint, recipient), p.publicKey, BigInt(plan.delivered)))
        await send(live(), p, instructions)
      })
    },

    /** The spoke's half of the ledger, read from the validator: SPL supply and the manager's custody account. */
    async ledger(job: Job) {
      const step = job.steps.find((s) => s.id === 'manager:solana')
      if (!step?.prepared) return { mint: null, supply: 0n, custody: 0n }
      const spoke = spokeOf(job)
      if (!await exists(spoke.mint)) return { mint: spoke.mint.toBase58(), supply: 0n, custody: 0n }
      const mint = await readMint(live(), spoke.mint)
      return { mint: spoke.mint.toBase58(), supply: mint.supply, custody: await exists(spoke.custody()) ? await readTokenBalance(live(), spoke.custody()) : 0n }
    },

    /** Whether the claim for this job's credit has been released on the spoke (minted). */
    async released(job: Job, digest: Hex) {
      const account = await live().getAccountInfo(spokeOf(job).at.inboxItem(Buffer.from(digest.slice(2), 'hex')), 'confirmed')
      return account ? decodeInboxItem(account.data).status === 'released' : false
    },
  }
}
export type SolanaSpoke = ReturnType<typeof solanaSpoke>
