import type { Database } from 'bun:sqlite'
import {
  BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, createPublicClient, createWalletClient, decodeEventLog, defineChain, encodeAbiParameters, encodeFunctionData, getAddress,
  http, parseSignature, zeroAddress, type Address, type Hex, type PublicClient, type TransactionReceipt, type WalletClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { hash, identity } from '../request'
import { LaunchError, type Atoms, type EffectContext, type EffectResult, type Job, type LaunchRequest, type PreparedEffect, type PromotionalTokenAdapter, type Step, type StepKind } from '../types'
import {
  CODE, NTT_COMMIT, architexFactoryAbi, architexPairAbi, coreAbi, erc20Abi, executorAbi, linked, nttAbi, predict, proxyInit, spokeAbi, transceiverAbi,
  universal, usdcAbi, v3FactoryAbi, v3PoolAbi, withArgs,
} from '../evm/contracts'
import { weiOf } from '../evm/adapter'
import { plan as v3Plan } from '../evm/v3'
import { publishedFrom, type VaaSource } from '../evm/vaa'

/**
 * FORK-ONLY composition of the Arc–Base adapter (PR #12) and the Robinhood fulfillment (PR #18) into
 * ONE paid launch job: one x402 payment and one canonical issuance on Arc, a single Arc locking hub
 * peered to BOTH a Base burning spoke and a Robinhood burning spoke, one outbound transfer and one
 * pool per spoke. Neither source adapter can do this alone: #12 peers its hub to Base only and #18
 * adopts a hub peered to Robinhood only, and their address layouts differ, so dispatching steps to
 * them would issue two assets. This module plans the combined layout itself and reuses their pinned
 * bytecode, ABIs, VAA and v3 helpers unchanged.
 *
 * Idempotency is the executors', as in both sources: each step is one
 * `EquilibriumExecutor.execute(operation, digest, calls)` with `operation = hash([job.id, step.id])`,
 * and a second execution reverts `OperationDone`. A stale worker, a restart or a replayed
 * transaction can only waste its own gas.
 *
 * Launch slots carry #12's one-launch scope and #18's release rule together: with `launches` set, at
 * most that many jobs may hold a payment authorization at once, and a slot moves to another job only
 * once chain state proves the holder's payment can never settle. A released job is refused for good.
 *
 * Every RPC must be loopback. Public Robinhood routes stay closed (robinhood/adapter.ts), and this
 * module has no testnet or live mode.
 */
export const SPOKES = ['base', 'robinhood'] as const
export type Spoke = typeof SPOKES[number]
export type Side = 'arc' | Spoke

export interface HubConfig {
  rpc: string
  chainId: number
  wormholeChainId: number
  core: Address
  executor: Address
  transceiverStructs: Address
  /** EIP-3009 payment asset and the Arc pool's quote. */
  usdc: Address
  /** Architex pair factory for the Arc pool. */
  factory: Address
  /** Blocks on top of an execution before it counts as final. */
  confirmations: number
  fromBlock: bigint
  /** USDC atoms per 1e18 wei of native gas. Arc gas is native USDC with 18 decimals: 1_000_000. */
  usdcAtomsPerNative: bigint
  maxFeePerGasWei?: bigint
}
export interface SpokeConfig {
  rpc: string
  chainId: number
  wormholeChainId: number
  core: Address
  executor: Address
  transceiverStructs: Address
  /** The pool's quote token on this spoke. */
  quote: Address
  venue: { factory: Address; fee: number; tickSpacing: number }
  confirmations: number
  fromBlock: bigint
  usdcAtomsPerNative: bigint
  priorityFeeWei?: bigint
  /** OP Stack chain: bound the L1 data fee with GasPriceOracle.getL1FeeUpperBound before sending. */
  opStackL1Fee?: boolean
  /** Signs a debit's message for verification by THIS spoke's core. */
  vaa: VaaSource
}
export interface MultispokeLabels {
  environment: string
  payment: string
  quoteInventory: string
  gas: string
}
export interface MultispokeConfig {
  mode: 'fork'
  labels: MultispokeLabels
  operatorKey: Hex
  arc: HubConfig
  spokes: Record<Spoke, SpokeConfig>
  /** NTT rate limits in token atoms per 24 hours, per peer. */
  limits: { outbound: bigint; inbound: bigint }
  budgets: Record<StepKind, Atoms>
  /** Jobs that may hold a payment authorization at once. Unset: no launch limit. */
  launches?: number
  receiptTimeoutMs?: number
}
export interface MultispokeOptions { afterSend?: (step: Step, tx: Hex) => void }

/** The exact label set this composition accepts. A configuration cannot relabel a fixture as funds. */
export const MULTISPOKE_LABELS: MultispokeLabels = {
  environment: 'mixed:arc-testnet-fork+base-sepolia-fork+robinhood-mainnet-fork',
  payment: 'fork-fixture: ForkUsdc (EIP-3009) at the Arc native USDC address on an Arc testnet fork; the payer is an anvil development key; no real funds move',
  quoteInventory: 'fork-fixture: Base Sepolia USDC and Robinhood USDG pool quote are credited to the spoke executors by storage write; the payer\'s Arc USDC for them is not bridged',
  gas: 'Base L1 data fees are bounded by the OP Stack oracle; Robinhood Arbitrum Orbit gas (including its L1 component) is not modelled; both are priced at a fixed ETH/USDC rate',
}

const LOCKING = 0
const BURNING = 1
const DAY = 86_400n
const ZERO: Hex = `0x${'0'.repeat(64)}`
/** Selector of EquilibriumExecutor.OperationDone(bytes32,bytes32). */
const OPERATION_DONE = '0x3a140fc2'
const GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000F' as const
const gasPriceOracleAbi = [{ type: 'function', name: 'getL1FeeUpperBound', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] }] as const
const isLoopback = (url: string) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(url)
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const call = (target: Address, data: Hex, value = 0n) => ({ target, value: value.toString(), data })
const create = (init: Hex) => ({ target: zeroAddress as Address, value: '0', data: init })

interface Plan {
  side: Side
  chainId: number
  executor: Address
  operation: Hex
  calls: { target: Address; value: string; data: Hex }[]
  value: string
  fromBlock: string
  expect: Record<string, Address>
}

/** Every address one job creates on all three chains, derived before any of it exists. */
export function layout(job: Pick<Job, 'id' | 'request'>, config: Pick<MultispokeConfig, 'arc' | 'spokes'>) {
  const op = (step: string) => hash([job.id, step])
  const { name, symbol, issuance } = job.request.canonical
  const canonicalInit = withArgs(linked(CODE.EquilibriumCanonical), [{ type: 'string' }, { type: 'string' }, { type: 'address' }, { type: 'uint64' }], [name, symbol, config.arc.executor, BigInt(issuance)])
  const canonical = predict(config.arc.executor, op('canonical:arc'), 0, canonicalInit)
  const manager = (chain: { executor: Address; transceiverStructs: Address; wormholeChainId: number; core: Address }, token: Address, mode: number, operation: Hex, first: number) => {
    const lib = { TransceiverStructs: chain.transceiverStructs }
    const managerInit = withArgs(linked(CODE.NttManager, lib), [{ type: 'address' }, { type: 'uint8' }, { type: 'uint16' }, { type: 'uint64' }, { type: 'bool' }], [token, mode, chain.wormholeChainId, DAY, false])
    const implementation = predict(chain.executor, operation, first, managerInit)
    const proxy = predict(chain.executor, operation, first + 1, proxyInit(implementation))
    const transceiverInit = withArgs(linked(CODE.WormholeTransceiver, lib), [{ type: 'address' }, { type: 'address' }, { type: 'uint8' }, { type: 'uint8' }, { type: 'uint16' }, { type: 'address' }], [proxy, chain.core, 0, 0, 0, zeroAddress])
    const transceiverImplementation = predict(chain.executor, operation, first + 3, transceiverInit)
    const transceiver = predict(chain.executor, operation, first + 4, proxyInit(transceiverImplementation))
    return { managerInit, implementation, proxy, transceiverInit, transceiverImplementation, transceiver }
  }
  const spoke = (side: Spoke) => {
    const c = config.spokes[side]
    const init = withArgs(linked(CODE.EquilibriumSpoke), [{ type: 'string' }, { type: 'string' }, { type: 'address' }, { type: 'uint64' }], [name, symbol, c.executor, BigInt(issuance)])
    const token = predict(c.executor, op(`manager:${side}`), 0, init)
    return { init, token, manager: manager(c, token, BURNING, op(`manager:${side}`), 1) }
  }
  return { op, canonicalInit, canonical, hub: manager(config.arc, canonical, LOCKING, op('manager:arc'), 0), spokes: { base: spoke('base'), robinhood: spoke('robinhood') } }
}

/** The side a step executes on: debits leave the Arc hub, everything else runs on its own chain. */
export const sideOf = (step: Pick<Step, 'kind' | 'chain'>): Side => (step.kind === 'debit' || step.chain === 'arc' ? 'arc' : step.chain as Spoke)

export function multispokeAdapter(config: MultispokeConfig, db: Database, options: MultispokeOptions = {}) {
  if (config.mode !== 'fork') throw new LaunchError(503, 'route_closed', 'The Arc–Base–Robinhood composition runs on local forks only.')
  if (JSON.stringify(config.labels) !== JSON.stringify(MULTISPOKE_LABELS)) throw new LaunchError(503, 'route_closed', 'Labels differ from the fork fixture labels. Fixtures cannot be relabelled.')
  for (const [side, rpc] of [['arc', config.arc.rpc], ...SPOKES.map((s) => [s, config.spokes[s].rpc])]) {
    if (!isLoopback(rpc)) throw new LaunchError(503, 'route_closed', `${side} RPC ${rpc} is not a local fork. Public Robinhood routes are closed.`)
  }
  const account = privateKeyToAccount(config.operatorKey)
  const chain = (side: Side) => (side === 'arc' ? config.arc : config.spokes[side])
  const chainOf = (side: Side) => defineChain({ id: chain(side).chainId, name: side, nativeCurrency: { name: 'native', symbol: 'NATIVE', decimals: 18 }, rpcUrls: { default: { http: [chain(side).rpc] } } })
  const sides = ['arc', ...SPOKES] as const
  const publicClient = (s: Side): PublicClient => createPublicClient({ chain: chainOf(s), transport: http(chain(s).rpc) })
  const walletClient = (s: Side): WalletClient => createWalletClient({ account, chain: chainOf(s), transport: http(chain(s).rpc) })
  const clients: Record<Side, PublicClient> = { arc: publicClient('arc'), base: publicClient('base'), robinhood: publicClient('robinhood') }
  const wallets: Record<Side, WalletClient> = { arc: walletClient('arc'), base: walletClient('base'), robinhood: walletClient('robinhood') }
  // Own tables: this composition never reads or writes the evm_* or robinhood_* journals.
  db.exec(`CREATE TABLE IF NOT EXISTS multispoke_broadcasts (operation TEXT NOT NULL, side TEXT NOT NULL, tx TEXT NOT NULL, sent_at INTEGER NOT NULL, PRIMARY KEY (operation, tx));
    CREATE TABLE IF NOT EXISTS multispoke_vaas (operation TEXT PRIMARY KEY, vaa TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS multispoke_launches (job TEXT PRIMARY KEY, identity TEXT NOT NULL, payer TEXT NOT NULL, valid_before INTEGER NOT NULL, settled INTEGER NOT NULL DEFAULT 0,
      released_reason TEXT, released_block TEXT, created_at INTEGER NOT NULL);`)
  const sending: Record<Side, Promise<unknown>> = { arc: Promise.resolve(), base: Promise.resolve(), robinhood: Promise.resolve() }
  const strip = (c: HubConfig | SpokeConfig) => ({ ...c, rpc: undefined, fromBlock: undefined, vaa: 'vaa' in c ? c.vaa.kind : undefined, priorityFeeWei: undefined,
    usdcAtomsPerNative: c.usdcAtomsPerNative.toString(), maxFeePerGasWei: 'maxFeePerGasWei' in c ? c.maxFeePerGasWei?.toString() : undefined })
  const pinned = { labels: config.labels, ntt: NTT_COMMIT, code: Object.fromEntries(Object.entries(CODE).map(([k, v]) => [k, v.sha256])), arc: strip(config.arc),
    spokes: { base: strip(config.spokes.base), robinhood: strip(config.spokes.robinhood) }, limits: { outbound: config.limits.outbound.toString(), inbound: config.limits.inbound.toString() },
    budgets: config.budgets, launches: config.launches ?? null }
  const version = `multispoke-arc-base-robinhood-v1:${hash(pinned).slice(2, 18)}`
  const destination = (request: LaunchRequest, side: Side) => request.destinations.find((d) => d.chain === side)!

  async function executed(side: Side, operation: Hex, at: bigint | 'latest' | 'pending'): Promise<Hex> {
    const block = typeof at === 'bigint' ? { blockNumber: at } : { blockTag: at }
    try { return await clients[side].readContract({ address: chain(side).executor, abi: executorAbi, functionName: 'digestOf', args: [operation], ...block }) } catch (cause) {
      // Before the executor existed nothing could have executed; anything else is a real read failure.
      if (cause instanceof BaseError && cause.walk((e) => e instanceof ContractFunctionZeroDataError)) return ZERO
      throw cause
    }
  }
  async function finalBlock(side: Side): Promise<bigint> {
    return await clients[side].getBlockNumber({ cacheTime: 0 }) - BigInt(chain(side).confirmations)
  }
  /** eth_call as the executor, returning the address a factory call would create. */
  async function dryRun(side: Side, to: Address, data: Hex): Promise<Address> {
    const executor = chain(side).executor
    const { data: out } = await clients[side].call({ account: executor, to, data, stateOverride: [{ address: executor, balance: 10n ** 24n }] })
    if (!out || out.length < 66) throw new Error(`Dry run of ${to} returned no address`)
    return getAddress(`0x${out.slice(26, 66)}`)
  }

  // ---- Launch slots -------------------------------------------------------------------------
  interface Slot { job: string; identity: string; payer: string; valid_before: number; settled: number; released_reason: string | null; released_block: string | null }
  const slot = (job: string) => db.query<Slot, [string]>('SELECT * FROM multispoke_launches WHERE job=?').get(job) ?? undefined
  const releasedFor = (identityHash: string) => db.query<Slot, [string]>('SELECT * FROM multispoke_launches WHERE identity=? AND released_reason IS NOT NULL').get(identityHash) ?? undefined
  const holders = (except: string) => db.query<Slot, [string]>('SELECT * FROM multispoke_launches WHERE released_reason IS NULL AND job!=?').all(except)
  const failed = (s: Pick<Slot, 'job' | 'released_reason' | 'released_block'>) =>
    new LaunchError(409, 'payment_failed', `Job ${s.job}'s payment can never settle (${s.released_reason} at Arc block ${s.released_block}); its launch slot was released. This job executed no charge. Start a new request.`)

  /**
   * Why a job's payment can never settle, or null while it still could. Read at one block
   * `confirmations` deep: the payment operation is unexecuted there, and the authorization has
   * expired by that block's time or its nonce is spent. Block time only grows and a spent nonce
   * makes the persisted bytes revert, so no later block can execute the payment.
   */
  async function unsettleable(job: string, payer: Address, validBefore: bigint): Promise<{ reason: string; block: string } | null> {
    const at = await finalBlock('arc')
    if (await executed('arc', hash([job, 'payment:arc']), at) !== ZERO) {
      db.query('UPDATE multispoke_launches SET settled=1 WHERE job=?').run(job)
      return null
    }
    const block = await clients.arc.getBlock({ blockNumber: at })
    if (block.timestamp >= validBefore) return { reason: 'authorization expired', block: at.toString() }
    const spent = await clients.arc.readContract({ address: config.arc.usdc, abi: usdcAbi, functionName: 'authorizationState', args: [payer, job as Hex], blockNumber: at })
    return spent ? { reason: 'authorization nonce spent elsewhere', block: at.toString() } : null
  }
  /** Release a slot for good. Idempotent; the first recorded reason stands. */
  function release(job: Job, why: { reason: string; block: string }) {
    const a = job.payment!.authorization
    db.query(`INSERT INTO multispoke_launches(job, identity, payer, valid_before, created_at, released_reason, released_block) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(job) DO UPDATE SET released_reason=COALESCE(released_reason, excluded.released_reason), released_block=COALESCE(released_block, excluded.released_block)`)
      .run(job.id, job.identity, a.from.toLowerCase(), Number(a.validBefore), Date.now(), why.reason, why.block)
  }
  /** A holder that is settled, or whose authorization has not expired yet, still counts. */
  const live = (s: Slot) => s.settled === 1 || Date.now() / 1000 < s.valid_before

  /**
   * Take this job's slot before its payment can be sent. Holders whose payments provably can never
   * settle are released first; the count and insert then happen in one IMMEDIATE transaction, so
   * two processes racing for the last slot cannot both take it.
   */
  async function takeSlot(job: Job) {
    const own = slot(job.id)
    if (own?.released_reason) throw failed(own)
    if (own) return
    const limit = config.launches
    if (limit !== undefined && holders(job.id).length >= limit) {
      for (const h of holders(job.id).filter((x) => !x.settled)) {
        const why = await unsettleable(h.job, h.payer as Address, BigInt(h.valid_before))
        if (why) db.query('UPDATE multispoke_launches SET released_reason=?, released_block=? WHERE job=? AND released_reason IS NULL').run(why.reason, why.block, h.job)
      }
    }
    const a = job.payment!.authorization
    db.transaction(() => {
      if (slot(job.id)) return
      const taken = holders(job.id)
      if (limit !== undefined && taken.length >= limit) throw new LaunchError(409, 'launch_limit', `${taken.length} launch(es) already hold the approved slot(s): ${taken.map((t) => t.job).join(', ')}. Nothing was charged.`)
      db.query('INSERT INTO multispoke_launches(job, identity, payer, valid_before, created_at) VALUES(?,?,?,?,?)').run(job.id, job.identity, a.from.toLowerCase(), Number(a.validBefore), Date.now())
    }).immediate()
  }

  // ---- Plans --------------------------------------------------------------------------------
  async function plan({ job, step }: EffectContext): Promise<Plan> {
    const L = layout(job, config)
    const side = sideOf(step)
    const c = chain(side)
    const operation = L.op(step.id)
    const request = job.request
    const calls: Plan['calls'] = []
    const expect: Record<string, Address> = {}
    const fee = await clients[side].readContract({ address: c.core, abi: coreAbi, functionName: 'messageFee' })
    if (step.kind === 'payment') {
      const a = job.payment?.authorization
      if (!a || !job.payment) throw new Error('Payment step without a verified authorization')
      if (!same(a.to, config.arc.executor)) throw new Error('Authorization does not pay the Arc executor')
      const { r, s, v } = parseSignature(job.payment.signature)
      calls.push(call(config.arc.usdc, encodeFunctionData({ abi: usdcAbi, functionName: 'transferWithAuthorization', args: [a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, Number(v ?? 27n), r, s] })))
      expect.payer = a.from
    } else if (step.kind === 'canonical') {
      calls.push(create(L.canonicalInit)); expect.token = L.canonical
    } else if (step.kind === 'manager' && side === 'arc') {
      // ONE hub for both spokes: a peer and a Wormhole peer per spoke, each with its own inbound limit.
      const h = L.hub
      calls.push(create(h.managerInit), create(proxyInit(h.implementation)), call(h.proxy, encodeFunctionData({ abi: nttAbi, functionName: 'initialize' })),
        create(h.transceiverInit), create(proxyInit(h.transceiverImplementation)), call(h.transceiver, encodeFunctionData({ abi: transceiverAbi, functionName: 'initialize' }), fee),
        call(h.proxy, encodeFunctionData({ abi: nttAbi, functionName: 'setTransceiver', args: [h.transceiver] })),
        call(h.proxy, encodeFunctionData({ abi: nttAbi, functionName: 'setThreshold', args: [1] })),
        call(h.proxy, encodeFunctionData({ abi: nttAbi, functionName: 'setOutboundLimit', args: [config.limits.outbound] })))
      for (const s of SPOKES) {
        const peer = L.spokes[s].manager
        calls.push(call(h.proxy, encodeFunctionData({ abi: nttAbi, functionName: 'setPeer', args: [config.spokes[s].wormholeChainId, universal(peer.proxy), 6, config.limits.inbound] })),
          call(h.transceiver, encodeFunctionData({ abi: transceiverAbi, functionName: 'setWormholePeer', args: [config.spokes[s].wormholeChainId, universal(peer.transceiver)] }), fee))
      }
      expect.manager = h.proxy; expect.transceiver = h.transceiver
    } else if (step.kind === 'manager') {
      const h = L.hub; const sp = L.spokes[side as Spoke]; const m = sp.manager
      calls.push(create(sp.init), create(m.managerInit), create(proxyInit(m.implementation)), call(m.proxy, encodeFunctionData({ abi: nttAbi, functionName: 'initialize' })),
        create(m.transceiverInit), create(proxyInit(m.transceiverImplementation)), call(m.transceiver, encodeFunctionData({ abi: transceiverAbi, functionName: 'initialize' }), fee),
        call(m.proxy, encodeFunctionData({ abi: nttAbi, functionName: 'setTransceiver', args: [m.transceiver] })),
        call(m.proxy, encodeFunctionData({ abi: nttAbi, functionName: 'setThreshold', args: [1] })),
        call(m.proxy, encodeFunctionData({ abi: nttAbi, functionName: 'setOutboundLimit', args: [config.limits.outbound] })),
        call(m.proxy, encodeFunctionData({ abi: nttAbi, functionName: 'setPeer', args: [config.arc.wormholeChainId, universal(h.proxy), 6, config.limits.inbound] })),
        call(m.transceiver, encodeFunctionData({ abi: transceiverAbi, functionName: 'setWormholePeer', args: [config.arc.wormholeChainId, universal(h.transceiver)] }), fee),
        call(sp.token, encodeFunctionData({ abi: spokeAbi, functionName: 'setMinter', args: [m.proxy] })))
      expect.manager = m.proxy; expect.transceiver = m.transceiver; expect.token = sp.token
    } else if (step.kind === 'debit') {
      const to = step.chain as Spoke
      const amount = BigInt(destination(request, to).amount)
      calls.push(call(L.canonical, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [L.hub.proxy, amount] })),
        call(L.hub.proxy, encodeFunctionData({ abi: nttAbi, functionName: 'transfer', args: [amount, config.spokes[to].wormholeChainId, universal(config.spokes[to].executor)] }), fee))
      expect.token = L.canonical; expect.manager = L.hub.proxy
    } else if (step.kind === 'credit') {
      const vaa = db.query<{ vaa: string }, [string]>('SELECT vaa FROM multispoke_vaas WHERE operation=?').get(L.op(`debit:${side}`))?.vaa
      if (!vaa) throw new Error(`No signed VAA is recorded for the finalized debit:${side}`)
      calls.push(call(L.spokes[side as Spoke].manager.transceiver, encodeFunctionData({ abi: transceiverAbi, functionName: 'receiveMessage', args: [vaa as Hex] })))
      expect.token = L.spokes[side as Spoke].token
    } else if (step.kind === 'pool' && side === 'arc') {
      const d = destination(request, 'arc')
      let pair = await clients.arc.readContract({ address: config.arc.factory, abi: architexFactoryAbi, functionName: 'getPair', args: [L.canonical, config.arc.usdc] })
      if (pair === zeroAddress) {
        const createPair = encodeFunctionData({ abi: architexFactoryAbi, functionName: 'createPair', args: [L.canonical, config.arc.usdc] })
        pair = await dryRun('arc', config.arc.factory, createPair)
        calls.push(call(config.arc.factory, createPair))
      }
      calls.push(call(L.canonical, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [pair, BigInt(d.poolTokens)] })),
        call(config.arc.usdc, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [pair, BigInt(d.poolQuote)] })),
        call(pair, encodeFunctionData({ abi: architexPairAbi, functionName: 'mint', args: [config.arc.executor] })))
      // Custody leaves the executor here, except exactly what the two spoke debits will lock.
      const remainder = BigInt(d.amount) - BigInt(d.poolTokens)
      if (remainder > 0n) calls.push(call(L.canonical, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [d.recipient as Address, remainder] })))
      const unallocated = BigInt(request.canonical.issuance) - request.destinations.reduce((n, x) => n + BigInt(x.amount), 0n)
      if (unallocated > 0n) calls.push(call(L.canonical, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [request.canonical.recipient, unallocated] })))
      expect.pool = pair; expect.token = L.canonical; expect.quote = config.arc.usdc
    } else if (step.kind === 'pool') {
      const s = config.spokes[side as Spoke]
      const token = L.spokes[side as Spoke].token
      const d = destination(request, side)
      const existing = await clients[side].readContract({ address: s.venue.factory, abi: v3FactoryAbi, functionName: 'getPool', args: [token, s.quote, s.venue.fee] })
      if (existing !== zeroAddress) throw new LaunchError(409, 'pool_exists', `A ${s.venue.fee} pool for the ${side} spoke already exists at ${existing}; refusing to seed a pool this job did not create.`)
      const createPool = encodeFunctionData({ abi: v3FactoryAbi, functionName: 'createPool', args: [token, s.quote, s.venue.fee] })
      const pool = await dryRun(side, s.venue.factory, createPool)
      const tokenFirst = token.toLowerCase() < s.quote.toLowerCase()
      const total0 = BigInt(tokenFirst ? d.poolTokens : d.poolQuote); const total1 = BigInt(tokenFirst ? d.poolQuote : d.poolTokens)
      const p = v3Plan(total0, total1, s.venue.tickSpacing)
      calls.push(call(s.venue.factory, createPool), call(pool, encodeFunctionData({ abi: v3PoolAbi, functionName: 'initialize', args: [p.sqrtPriceX96] })),
        call(pool, encodeFunctionData({ abi: v3PoolAbi, functionName: 'mint', args: [s.executor, p.lower, p.upper, p.liquidity, encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [total0, total1])] })))
      const remainder = BigInt(d.amount) - BigInt(d.poolTokens)
      if (remainder > 0n) calls.push(call(token, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [d.recipient as Address, remainder] })))
      expect.pool = pool; expect.token = token; expect.quote = s.quote
    } else throw new Error(`No plan for ${step.id}`)
    const value = calls.reduce((n, x) => n + BigInt(x.value), 0n)
    const fromBlock = await clients[side].getBlockNumber({ cacheTime: 0 })
    return { side, chainId: c.chainId, executor: c.executor, operation, calls, value: value.toString(), fromBlock: (fromBlock > c.fromBlock ? fromBlock : c.fromBlock).toString(), expect }
  }

  const parse = (prepared: PreparedEffect, step: Step, job: Job): Plan => {
    if (hash(prepared.bytes) !== prepared.digest || prepared.operation !== hash([job.id, step.id])) throw new Error('Prepared bytes changed')
    const p = JSON.parse(prepared.bytes) as Plan
    if (p.operation !== prepared.operation || p.side !== sideOf(step) || !same(p.executor, chain(p.side).executor)) throw new Error(`Prepared plan for ${step.id} is inconsistent`)
    return p
  }
  const executeArgs = (p: Plan, digest: Hex) => [p.operation, digest, p.calls.map((x) => ({ target: x.target, value: BigInt(x.value), data: x.data }))] as const

  function transfers(receipt: TransactionReceipt, token: Address) {
    return receipt.logs.filter((l) => same(l.address, token)).flatMap((l) => {
      try {
        const e = decodeEventLog({ abi: erc20Abi, data: l.data, topics: l.topics })
        return e.eventName === 'Transfer' ? [e.args] : []
      } catch { return [] }
    })
  }
  const sum = (items: { value: bigint }[]) => items.reduce((n, x) => n + x.value, 0n).toString()

  async function result(p: Plan, step: Step, receipt: TransactionReceipt): Promise<EffectResult | 'pending'> {
    const c = chain(p.side)
    const cost = ((weiOf(receipt) * c.usdcAtomsPerNative + 10n ** 18n - 1n) / 10n ** 18n).toString()
    const base: EffectResult = { operation: p.operation, transaction: receipt.transactionHash, finalized: true, cost }
    const X = p.executor
    if (step.kind === 'payment') return { ...base, amount: sum(transfers(receipt, config.arc.usdc).filter((t) => same(t.from, p.expect.payer) && same(t.to, X))) }
    if (step.kind === 'canonical') return { ...base, address: p.expect.token, amount: sum(transfers(receipt, p.expect.token).filter((t) => t.from === zeroAddress && same(t.to, X))) }
    if (step.kind === 'manager') {
      const owner = await clients[p.side].readContract({ address: p.expect.manager, abi: nttAbi, functionName: 'owner', blockNumber: receipt.blockNumber })
      if (!same(owner, X)) throw new Error(`${step.id} manager owner is not the executor`)
      return { ...base, address: p.expect.manager }
    }
    if (step.kind === 'debit') {
      const locked = transfers(receipt, p.expect.token).filter((t) => same(t.from, X) && same(t.to, p.expect.manager))
      const block = await clients.arc.getBlock({ blockNumber: receipt.blockNumber })
      const messages = publishedFrom(receipt.logs, config.arc.core, config.arc.wormholeChainId, Number(block.timestamp))
      if (messages.length !== 1) throw new Error(`${step.id} published ${messages.length} Wormhole messages; expected exactly one`)
      // Signed for the destination's core. Unsigned is pending, never absent.
      const vaa = await config.spokes[step.chain as Spoke].vaa.signed(messages[0])
      if (!vaa) return 'pending'
      db.query('INSERT OR IGNORE INTO multispoke_vaas(operation, vaa) VALUES(?, ?)').run(p.operation, vaa)
      return { ...base, amount: sum(locked) }
    }
    if (step.kind === 'credit') {
      const minted = transfers(receipt, p.expect.token).filter((t) => t.from === zeroAddress && same(t.to, X))
      if (!minted.length) throw new Error(`${step.id} executed without a mint: the inbound transfer is queued or was not redeemed`)
      return { ...base, amount: sum(minted) }
    }
    const token = sum(transfers(receipt, p.expect.token).filter((t) => same(t.from, X) && same(t.to, p.expect.pool)))
    const quote = sum(transfers(receipt, p.expect.quote).filter((t) => same(t.from, X) && same(t.to, p.expect.pool)))
    return { ...base, address: p.expect.pool, amount: token, quoteAmount: quote }
  }

  async function fees(side: Side) {
    const c = chain(side)
    if ('maxFeePerGasWei' in c && c.maxFeePerGasWei !== undefined) return { maxFeePerGas: c.maxFeePerGasWei, maxPriorityFeePerGas: 0n }
    const tip = 'priorityFeeWei' in c ? c.priorityFeeWei : undefined
    if (tip === undefined) {
      const { maxFeePerGas, maxPriorityFeePerGas } = await clients[side].estimateFeesPerGas()
      return { maxFeePerGas, maxPriorityFeePerGas }
    }
    return { maxPriorityFeePerGas: tip, maxFeePerGas: ((await clients[side].getBlock()).baseFeePerGas ?? 0n) * 2n + tip }
  }
  /** Refuse to send anything whose worst-case cost could exceed the step's budget. */
  async function worstCase(side: Side, step: Step, gas: bigint, maxFeePerGas: bigint, data: Hex) {
    const c = chain(side)
    let worst = gas * maxFeePerGas
    if ('opStackL1Fee' in c && c.opStackL1Fee) worst += await clients[side].readContract({ address: GAS_PRICE_ORACLE, abi: gasPriceOracleAbi, functionName: 'getL1FeeUpperBound', args: [BigInt((data.length - 2) / 2 + 68)] })
    const atoms = (worst * c.usdcAtomsPerNative + 10n ** 18n - 1n) / 10n ** 18n
    if (atoms > BigInt(step.budget)) throw new LaunchError(409, 'budget', `${step.id} could cost up to ${atoms} USDC atoms, above its ${step.budget} budget. Nothing was sent.`)
  }

  /**
   * One job's supply across all three chains, read from chain state only. In flight is a spoke
   * whose debit executed on Arc while its credit has not executed on the spoke. Canonical tokens
   * outside custody, both representations and in-flight claims must sum to the fixed issuance, and
   * custody must back exactly the representations plus in-flight claims.
   */
  async function supply(job: Job) {
    const L = layout(job, config)
    const orZero = (read: Promise<bigint>) => read.catch((cause: unknown) => {
      // Not deployed yet: nothing issued there.
      if (cause instanceof BaseError && cause.walk((e) => e instanceof ContractFunctionZeroDataError)) return 0n
      throw cause
    })
    const totalSupply = (side: Side, address: Address) => orZero(clients[side].readContract({ address, abi: erc20Abi, functionName: 'totalSupply' }))
    const issued = await totalSupply('arc', L.canonical)
    const custody = await orZero(clients.arc.readContract({ address: L.canonical, abi: erc20Abi, functionName: 'balanceOf', args: [L.hub.proxy] }))
    const spokes = { base: await totalSupply('base', L.spokes.base.token), robinhood: await totalSupply('robinhood', L.spokes.robinhood.token) }
    const inFlight = { base: 0n, robinhood: 0n }
    for (const s of SPOKES) {
      const debited = await executed('arc', L.op(`debit:${s}`), 'latest') !== ZERO
      const credited = await executed(s, L.op(`credit:${s}`), 'latest') !== ZERO
      if (debited && !credited) inFlight[s] = BigInt(destination(job.request, s).amount)
    }
    const remote = spokes.base + spokes.robinhood
    const pending = inFlight.base + inFlight.robinhood
    const outside = issued - custody
    return { issued, custody, spokes, inFlight, outside, accounted: outside + remote + pending,
      reconciled: issued === BigInt(job.request.canonical.issuance) && outside + remote + pending === issued && custody === remote + pending }
  }

  const adapter: PromotionalTokenAdapter & {
    clients: Record<Side, PublicClient>; verify(): Promise<void>; supply: typeof supply; slot: typeof slot
  } = {
    mode: 'fork',
    version,
    clients,
    supply,
    slot,
    terms: { chainId: config.arc.chainId, asset: config.arc.usdc, payTo: config.arc.executor, name: 'USDC', version: '2' },
    assertReady(request) {
      if (request.destinations.map((d) => d.chain).join(',') !== 'arc,base,robinhood') {
        throw new LaunchError(503, 'route_closed', 'This fork composition fulfils exactly Arc, Base and Robinhood in one job. Solana is closed here; single-spoke launches run in their own harnesses.')
      }
      for (const s of SPOKES) {
        const amount = BigInt(destination(request, s).amount)
        if (amount > config.limits.inbound || amount > config.limits.outbound) throw new LaunchError(409, 'rate_limit', `The ${s} allocation exceeds the configured NTT rate limit and would queue.`)
      }
      const gone = releasedFor(identity(request))
      if (gone) throw failed(gone)
      // Fast refusal before a quote or charge. The payment step re-checks atomically.
      if (config.launches !== undefined) {
        const taken = holders('').filter((h) => h.identity !== identity(request) && live(h))
        if (taken.length >= config.launches) throw new LaunchError(409, 'launch_limit', `${taken.length} launch(es) already hold the approved slot(s). Nothing was charged.`)
      }
    },
    budgets: () => config.budgets,
    async verify() {
      for (const side of sides) {
        const c = chain(side)
        if (await clients[side].getChainId() !== c.chainId) throw new Error(`${side} RPC reports a different chain id`)
        if (await clients[side].readContract({ address: c.core, abi: coreAbi, functionName: 'chainId' }) !== c.wormholeChainId) throw new Error(`${side} Wormhole core reports a different chain`)
        const owner = await clients[side].readContract({ address: c.executor, abi: executorAbi, functionName: 'owner' })
        if (!same(owner, account.address)) throw new Error(`${side} executor is owned by ${owner}, not the operator ${account.address}`)
        const factory = await clients[side].readContract({ address: c.executor, abi: executorAbi, functionName: 'v3Factory' })
        if (!same(factory, side === 'arc' ? zeroAddress : config.spokes[side].venue.factory)) throw new Error(`${side} executor v3 factory differs from the venue`)
      }
    },
    async prepare(context) {
      const p = await plan(context)
      const bytes = JSON.stringify(p)
      return { operation: p.operation, digest: hash(bytes), bytes }
    },
    async observe({ job, step }, prepared) {
      const p = parse(prepared, step, job)
      const client = clients[p.side]
      const final = await finalBlock(p.side)
      const atFinal = await executed(p.side, p.operation, final)
      if (atFinal !== ZERO) {
        if (atFinal !== prepared.digest) throw new LaunchError(409, 'operation_conflict', `${step.id} already executed with other bytes (${atFinal}).`)
        const [log] = await client.getLogs({ address: p.executor, event: executorAbi.find((x) => x.type === 'event' && x.name === 'Executed')!, args: { operation: p.operation }, fromBlock: BigInt(p.fromBlock), toBlock: final }) as { transactionHash: Hex }[]
        if (!log) throw new Error(`${step.id} executed but has no log in the searched range`)
        if (step.kind === 'payment') db.query('UPDATE multispoke_launches SET settled=1 WHERE job=?').run(job.id)
        return result(p, step, await client.getTransactionReceipt({ hash: log.transactionHash }))
      }
      // Executed but not yet final, or a submission still in the mempool: pending, never absent.
      const current = await executed(p.side, p.operation, 'latest')
      if (current === prepared.digest) return 'pending'
      if (current !== ZERO) throw new LaunchError(409, 'operation_conflict', `${step.id} already executed with other bytes (${current}).`)
      for (const { tx } of db.query<{ tx: string }, [string]>('SELECT tx FROM multispoke_broadcasts WHERE operation=?').all(p.operation)) {
        if (await client.getTransaction({ hash: tx as Hex }).then((t) => t.blockNumber === null, () => false)) return 'pending'
      }
      if (step.kind === 'payment') {
        // Absent and provably never payable: release the slot and refuse this job for good.
        const own = slot(job.id)
        if (own?.released_reason) throw failed(own)
        const a = job.payment!.authorization
        const why = await unsettleable(job.id, a.from, BigInt(a.validBefore))
        if (why) { release(job, why); throw failed({ job: job.id, released_reason: why.reason, released_block: why.block }) }
      }
      return 'absent'
    },
    async broadcast({ job, step }, prepared) {
      const p = parse(prepared, step, job)
      const client = clients[p.side]
      if (step.kind === 'payment') await takeSlot(job)
      const run = async () => {
        const current = await executed(p.side, p.operation, 'latest')
        if (current === prepared.digest) return
        if (current !== ZERO) throw new LaunchError(409, 'operation_conflict', `${step.id} already executed with other bytes (${current}).`)
        // A crashed or stale worker's identical copy may still be in the mempool: observe it instead of paying for a second send.
        if (await executed(p.side, p.operation, 'pending') === prepared.digest) return
        let gas: bigint
        try {
          await client.simulateContract({ account, address: p.executor, abi: executorAbi, functionName: 'execute', args: executeArgs(p, prepared.digest), value: BigInt(p.value) })
          gas = await client.estimateContractGas({ account, address: p.executor, abi: executorAbi, functionName: 'execute', args: executeArgs(p, prepared.digest), value: BigInt(p.value) })
        } catch (cause) {
          // Another worker executed it between the read and the simulation: nothing to send.
          const revert = cause instanceof BaseError ? cause.walk((e) => e instanceof ContractFunctionRevertedError) : null
          if (revert instanceof ContractFunctionRevertedError && revert.data?.errorName === 'OperationDone') return
          throw cause
        }
        const limit = (gas * 12n) / 10n
        const fee = await fees(p.side)
        await worstCase(p.side, step, limit, fee.maxFeePerGas, encodeFunctionData({ abi: executorAbi, functionName: 'execute', args: executeArgs(p, prepared.digest) }))
        let tx: Hex | undefined
        for (let attempt = 0; attempt < 3 && !tx; attempt++) {
          try {
            tx = await wallets[p.side].writeContract({ account, chain: chainOf(p.side), address: p.executor, abi: executorAbi, functionName: 'execute', args: executeArgs(p, prepared.digest), value: BigInt(p.value), gas: limit, ...fee })
          } catch (cause) {
            // Another worker's execution landed between our simulation and our send: nothing to send.
            if (String(cause).includes(OPERATION_DONE) || await executed(p.side, p.operation, 'pending') === prepared.digest) return
            if (attempt === 2 || !/nonce|underpriced|already known/i.test(String(cause))) throw cause
          }
        }
        options.afterSend?.(step, tx!)
        db.query('INSERT OR IGNORE INTO multispoke_broadcasts(operation, side, tx, sent_at) VALUES(?,?,?,?)').run(p.operation, p.side, tx!, Date.now())
        const receipt = await client.waitForTransactionReceipt({ hash: tx!, timeout: config.receiptTimeoutMs ?? 120_000 })
        if (receipt.status !== 'success' && await executed(p.side, p.operation, receipt.blockNumber) !== prepared.digest) throw new Error(`${step.id} execution reverted in ${tx}`)
      }
      const next = sending[p.side].then(run, run)
      sending[p.side] = next.catch(() => undefined)
      await next
    },
  }
  return adapter
}
export type MultispokeAdapter = ReturnType<typeof multispokeAdapter>
