import type { Database } from 'bun:sqlite'
import {
  BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, HttpRequestError, TimeoutError, createPublicClient, createWalletClient, decodeEventLog, defineChain, encodeAbiParameters,
  encodeFunctionData, http, parseAbi, zeroAddress, type Address, type Hex, type PublicClient, type TransactionReceipt, type WalletClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { hash } from '../request'
import { LaunchError } from '../types'
import { CODE, coreAbi, erc20Abi, executorAbi, linked, nttAbi, predict, proxyInit, spokeAbi, transceiverAbi, universal, v3FactoryAbi, v3PoolAbi, withArgs } from '../evm/contracts'
import { plan as v3Plan } from '../evm/v3'
import { publishedFrom, type VaaSource } from '../evm/vaa'

/**
 * FORK-ONLY route engine for the EQUILIBRIUM Robinhood spoke: an Arc locking hub and a Robinhood
 * burning spoke on NTT, a Uniswap v3 pool on Robinhood, and outbound/return transfers between them.
 *
 * Every effect is one `EquilibriumExecutor.execute(operation, digest, calls)` whose bytes are
 * persisted before anything is sent, so a restart, a stale worker or a replayed transaction cannot
 * repeat a deployment, debit, credit or pool deposit: the executor refuses a second execution of an
 * operation on-chain. Transfers advance debit -> source confirmations -> signed VAA -> credit, and
 * each stage is re-derived from chain state after a restart instead of trusted from memory.
 *
 * It refuses any non-loopback RPC. Public Robinhood routes stay closed (see adapter.ts).
 */
export type Side = 'arc' | 'robinhood'
export interface RouteChain {
  side: Side
  rpc: string
  chainId: number
  wormholeChainId: number
  core: Address
  executor: Address
  transceiverStructs: Address
  /** Confirmations on top of the debit block before its message is treated as final and fetched. */
  confirmations: number
  /** Lowest block searched for executor logs: the fork point + 1. */
  fromBlock: bigint
  /** Priority fee in wei. Unset lets the RPC suggest one; anvil's 1 gwei suggestion misstates an Arbitrum chain, which ignores tips. */
  priorityFeeWei?: bigint
}
export interface RobinhoodRouteConfig {
  mode: 'fork'
  /** Always this label: an Arc testnet fork paired with a Robinhood mainnet fork proves compatibility, not a route. */
  environment: 'mixed:arc-testnet-fork+robinhood-mainnet-fork'
  operatorKey: Hex
  arc: RouteChain
  robinhood: RouteChain & { venue: { factory: Address; quoterV2: Address; fee: number; tickSpacing: number }; quote: Address }
  /** Signs a published message for verification by the named DESTINATION chain's core. */
  vaa: Record<Side, VaaSource>
  /** NTT rate limits in atoms per 24 hours. A transfer above either is refused before any debit. */
  limits: { outbound: bigint; inbound: bigint }
  asset: { id: string; name: string; symbol: string; issuance: bigint }
  receiptTimeoutMs?: number
}
export type Direction = 'outbound' | 'return'
export type TransferState = 'planned' | 'debited' | 'attested' | 'credited'
export interface Transfer {
  id: string
  direction: Direction
  amount: bigint
  recipient: Address
  state: TransferState
  debitTx: Hex | null
  debitBlock: bigint | null
  vaa: Hex | null
  creditTx: Hex | null
}
export type Progress = TransferState | 'awaiting_finality' | 'awaiting_attestation'
/** Test seam: runs right after a transaction is handed to the RPC, before anything about it is recorded. */
export interface RouteOptions {
  afterSend?: (name: string, tx: Hex) => void
  /**
   * Runs for every send, after the operation is known to be neither executed nor pending and before
   * gas estimation. It may refuse by throwing. A returned function is called only if the attempt
   * then fails before anything was handed to the RPC, so whatever the guard recorded can be undone.
   */
  guard?: (side: Side, name: string, operation: Hex, calls: Plan['calls']) => Promise<(() => void) | void>
}

const LOCKING = 0
const BURNING = 1
const DAY = 86_400n
const ZERO: Hex = `0x${'0'.repeat(64)}`
const OPERATION_DONE = '0x3a140fc2'
const quoterAbi = parseAbi([
  'struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }',
  'function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
])

const isLoopback = (url: string) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(url)
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const other = (side: Side): Side => (side === 'arc' ? 'robinhood' : 'arc')

/** Every address the rehearsal creates, derived before any of it exists. */
export function layout(config: Pick<RobinhoodRouteConfig, 'arc' | 'robinhood' | 'asset'>) {
  const op = (name: string) => hash([config.asset.id, name])
  const { name, symbol, issuance } = config.asset
  const canonicalInit = withArgs(linked(CODE.EquilibriumCanonical), [{ type: 'string' }, { type: 'string' }, { type: 'address' }, { type: 'uint64' }], [name, symbol, config.arc.executor, issuance])
  const canonical = predict(config.arc.executor, op('canonical:arc'), 0, canonicalInit)
  const manager = (chain: RouteChain, token: Address, mode: number, operation: Hex, first: number) => {
    const lib = { TransceiverStructs: chain.transceiverStructs }
    const managerInit = withArgs(linked(CODE.NttManager, lib), [{ type: 'address' }, { type: 'uint8' }, { type: 'uint16' }, { type: 'uint64' }, { type: 'bool' }], [token, mode, chain.wormholeChainId, DAY, false])
    const implementation = predict(chain.executor, operation, first, managerInit)
    const proxy = predict(chain.executor, operation, first + 1, proxyInit(implementation))
    const transceiverInit = withArgs(linked(CODE.WormholeTransceiver, lib), [{ type: 'address' }, { type: 'address' }, { type: 'uint8' }, { type: 'uint8' }, { type: 'uint16' }, { type: 'address' }], [proxy, chain.core, 0, 0, 0, zeroAddress])
    const transceiverImplementation = predict(chain.executor, operation, first + 3, transceiverInit)
    const transceiver = predict(chain.executor, operation, first + 4, proxyInit(transceiverImplementation))
    return { managerInit, implementation, proxy, transceiverInit, transceiverImplementation, transceiver }
  }
  const spokeInit = withArgs(linked(CODE.EquilibriumSpoke), [{ type: 'string' }, { type: 'string' }, { type: 'address' }, { type: 'uint64' }], [name, symbol, config.robinhood.executor, issuance])
  const spoke = predict(config.robinhood.executor, op('manager:robinhood'), 0, spokeInit)
  return { op, canonicalInit, canonical, hub: manager(config.arc, canonical, LOCKING, op('manager:arc'), 0), spokeInit, spoke, spokeManager: manager(config.robinhood, spoke, BURNING, op('manager:robinhood'), 1) }
}

export interface Plan { side: Side; chainId: number; executor: Address; operation: Hex; calls: { target: Address; value: string; data: Hex }[]; value: string }
const call = (target: Address, data: Hex, value = 0n) => ({ target, value: value.toString(), data })
const create = (init: Hex) => ({ target: zeroAddress as Address, value: '0', data: init })

export function robinhoodRoute(config: RobinhoodRouteConfig, db: Database, options: RouteOptions = {}) {
  if (config.mode !== 'fork' || config.environment !== 'mixed:arc-testnet-fork+robinhood-mainnet-fork') throw new LaunchError(503, 'route_closed', 'The Robinhood route engine runs on local forks only.')
  for (const side of ['arc', 'robinhood'] as const) {
    if (!isLoopback(config[side].rpc)) throw new LaunchError(503, 'route_closed', `${side} RPC ${config[side].rpc} is not a local fork. Public Robinhood routes are closed.`)
  }
  const account = privateKeyToAccount(config.operatorKey)
  const chainOf = (c: RouteChain) => defineChain({ id: c.chainId, name: c.side, nativeCurrency: { name: 'native', symbol: 'NATIVE', decimals: 18 }, rpcUrls: { default: { http: [c.rpc] } } })
  const clients: Record<Side, PublicClient> = {
    arc: createPublicClient({ chain: chainOf(config.arc), transport: http(config.arc.rpc) }),
    robinhood: createPublicClient({ chain: chainOf(config.robinhood), transport: http(config.robinhood.rpc) }),
  }
  const wallets: Record<Side, WalletClient> = {
    arc: createWalletClient({ account, chain: chainOf(config.arc), transport: http(config.arc.rpc) }),
    robinhood: createWalletClient({ account, chain: chainOf(config.robinhood), transport: http(config.robinhood.rpc) }),
  }
  db.exec(`CREATE TABLE IF NOT EXISTS robinhood_ops (operation TEXT PRIMARY KEY, name TEXT NOT NULL, side TEXT NOT NULL, digest TEXT NOT NULL, bytes TEXT NOT NULL, tx TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS robinhood_transfers (id TEXT PRIMARY KEY, direction TEXT NOT NULL, amount TEXT NOT NULL, recipient TEXT NOT NULL, state TEXT NOT NULL,
      debit_tx TEXT, debit_block TEXT, vaa TEXT, credit_tx TEXT, created_at INTEGER NOT NULL);`)
  const sending: Record<Side, Promise<unknown>> = { arc: Promise.resolve(), robinhood: Promise.resolve() }
  const L = layout(config)

  async function digestOf(side: Side, operation: Hex, at: 'latest' | 'pending' | bigint = 'latest'): Promise<Hex> {
    const block = typeof at === 'bigint' ? { blockNumber: at } : { blockTag: at }
    try { return await clients[side].readContract({ address: config[side].executor, abi: executorAbi, functionName: 'digestOf', args: [operation], ...block }) } catch (cause) {
      if (cause instanceof BaseError && cause.walk((e) => e instanceof ContractFunctionZeroDataError)) return ZERO
      throw cause
    }
  }
  async function executedReceipt(side: Side, operation: Hex): Promise<TransactionReceipt> {
    const logs = await clients[side].getLogs({ address: config[side].executor, event: executorAbi.find((x) => x.type === 'event' && x.name === 'Executed')!, args: { operation }, fromBlock: config[side].fromBlock, toBlock: 'latest' })
    if (logs.length !== 1) throw new Error(`Operation ${operation} has ${logs.length} Executed logs on ${side}; expected exactly one`)
    return clients[side].getTransactionReceipt({ hash: logs[0].transactionHash })
  }

  /** Wait for an execution already in the mempool. Pending is never treated as absent; a dropped copy falls through to a resend on the next call. */
  async function landed(side: Side, operation: Hex, name: string): Promise<TransactionReceipt> {
    const deadline = Date.now() + (config.receiptTimeoutMs ?? 120_000)
    while (Date.now() < deadline) {
      if (await digestOf(side, operation) !== ZERO) return executedReceipt(side, operation)
      if (await digestOf(side, operation, 'pending') === ZERO) throw new LaunchError(409, 'pending_dropped', `${name} left the mempool without executing; retry to resend the same bytes.`)
      await new Promise((r) => setTimeout(r, 250))
    }
    throw new LaunchError(409, 'pending', `${name} is still pending on ${side}; not resending.`)
  }

  /**
   * Execute operation `name` on `side` exactly once. The plan is built once and persisted; a
   * restarted worker reuses the persisted bytes, never a re-plan. Returns the executing receipt,
   * whoever sent it.
   */
  /**
   * Build and persist the plan for operation `name` once, without sending anything. The first
   * persisted bytes win: a later call returns them unchanged, whatever `build` would now produce.
   */
  async function persist(name: string, side: Side, build: () => Promise<Plan['calls']> | Plan['calls']): Promise<{ operation: Hex; digest: Hex; bytes: string }> {
    const operation = L.op(name)
    let row = db.query<{ side: string; digest: Hex; bytes: string }, [string]>('SELECT side, digest, bytes FROM robinhood_ops WHERE operation=?').get(operation)
    if (!row) {
      const calls = await build()
      const p: Plan = { side, chainId: config[side].chainId, executor: config[side].executor, operation, calls, value: calls.reduce((n, x) => n + BigInt(x.value), 0n).toString() }
      const bytes = JSON.stringify(p)
      db.query('INSERT OR IGNORE INTO robinhood_ops(operation, name, side, digest, bytes, created_at) VALUES(?,?,?,?,?,?)').run(operation, name, side, hash(bytes), bytes, Date.now())
      row = db.query<{ side: string; digest: Hex; bytes: string }, [string]>('SELECT side, digest, bytes FROM robinhood_ops WHERE operation=?').get(operation)!
    }
    if (row.side !== side || hash(row.bytes) !== row.digest) throw new Error(`Persisted plan for ${name} is inconsistent`)
    return { operation, digest: row.digest, bytes: row.bytes }
  }

  async function execute(name: string, side: Side, build: () => Promise<Plan['calls']> | Plan['calls']): Promise<TransactionReceipt> {
    const { operation, digest, bytes } = await persist(name, side, build)
    const p = JSON.parse(bytes) as Plan
    const args = [operation, digest, p.calls.map((x) => ({ target: x.target, value: BigInt(x.value), data: x.data }))] as const
    const run = async (): Promise<TransactionReceipt> => {
      const current = await digestOf(side, operation)
      if (current === digest) return executedReceipt(side, operation)
      if (current !== ZERO) throw new LaunchError(409, 'operation_conflict', `${name} already executed with other bytes (${current}).`)
      // A crashed or stale worker's copy may still be in the mempool: wait for it instead of paying for a second send.
      if (await digestOf(side, operation, 'pending') === digest) return landed(side, operation, name)
      const abandon = await options.guard?.(side, name, operation, p.calls)
      let gas: bigint
      try {
        gas = await clients[side].estimateContractGas({ account, address: p.executor, abi: executorAbi, functionName: 'execute', args, value: BigInt(p.value) })
      } catch (cause) {
        abandon?.()
        const revert = cause instanceof BaseError ? cause.walk((e) => e instanceof ContractFunctionRevertedError) : null
        if (revert instanceof ContractFunctionRevertedError && revert.data?.errorName === 'OperationDone') return executedReceipt(side, operation)
        throw cause
      }
      const tip = config[side].priorityFeeWei
      const fees = tip === undefined ? {} : { maxPriorityFeePerGas: tip, maxFeePerGas: ((await clients[side].getBlock()).baseFeePerGas ?? 0n) * 2n + tip }
      let tx: Hex
      try {
        tx = await wallets[side].writeContract({ account, chain: chainOf(config[side]), address: p.executor, abi: executorAbi, functionName: 'execute', args, value: BigInt(p.value), gas: (gas * 12n) / 10n, ...fees })
      } catch (cause) {
        if (String(cause).includes(OPERATION_DONE) || await digestOf(side, operation, 'pending') === digest) return executedReceipt(side, operation)
        // A transport failure may still have delivered the transaction: its outcome is unknown, not failed.
        if (cause instanceof BaseError && cause.walk((e) => e instanceof HttpRequestError || e instanceof TimeoutError)) throw new LaunchError(409, 'broadcast_uncertain', `${name} may have been sent; observe it before resending.`)
        throw cause
      }
      options.afterSend?.(name, tx)
      db.query('UPDATE robinhood_ops SET tx=? WHERE operation=?').run(tx, operation)
      let receipt: TransactionReceipt
      try {
        receipt = await clients[side].waitForTransactionReceipt({ hash: tx, timeout: config.receiptTimeoutMs ?? 120_000 })
      } catch {
        // The transaction is on the wire. Without a receipt it is neither done nor failed.
        throw new LaunchError(409, 'broadcast_uncertain', `${name} was sent in ${tx} and has no receipt yet; observe it before resending.`)
      }
      if (receipt.status === 'success') return receipt
      // Our copy lost a race to another worker's identical operation: the other one is the effect.
      if (await digestOf(side, operation) === digest) return executedReceipt(side, operation)
      throw new Error(`${name} reverted in ${tx}`)
    }
    const next = sending[side].then(run, run)
    sending[side] = next.catch(() => undefined)
    return next
  }

  const fee = (side: Side) => clients[side].readContract({ address: config[side].core, abi: coreAbi, functionName: 'messageFee' })
  function transfersIn(receipt: TransactionReceipt, token: Address) {
    return receipt.logs.filter((l) => same(l.address, token)).flatMap((l) => {
      try {
        const e = decodeEventLog({ abi: erc20Abi, data: l.data, topics: l.topics })
        return e.eventName === 'Transfer' ? [e.args] : []
      } catch { return [] }
    })
  }

  async function deployHub() {
    const h = L.hub; const s = L.spokeManager
    const f = await fee('arc')
    await execute('canonical:arc', 'arc', () => [create(L.canonicalInit)])
    return execute('manager:arc', 'arc', () => [create(h.managerInit), create(proxyInit(h.implementation)), call(h.proxy, encodeFunctionData({ abi: nttAbi, functionName: 'initialize' })),
      create(h.transceiverInit), create(proxyInit(h.transceiverImplementation)), call(h.transceiver, encodeFunctionData({ abi: transceiverAbi, functionName: 'initialize' }), f),
      call(h.proxy, encodeFunctionData({ abi: nttAbi, functionName: 'setTransceiver', args: [h.transceiver] })),
      call(h.proxy, encodeFunctionData({ abi: nttAbi, functionName: 'setThreshold', args: [1] })),
      call(h.proxy, encodeFunctionData({ abi: nttAbi, functionName: 'setOutboundLimit', args: [config.limits.outbound] })),
      call(h.proxy, encodeFunctionData({ abi: nttAbi, functionName: 'setPeer', args: [config.robinhood.wormholeChainId, universal(s.proxy), 6, config.limits.inbound] })),
      call(h.transceiver, encodeFunctionData({ abi: transceiverAbi, functionName: 'setWormholePeer', args: [config.robinhood.wormholeChainId, universal(s.transceiver)] }), f)])
  }
  /** The spoke token, its burning manager and transceiver, peered to the hub: one executor operation. */
  async function spokeCalls(): Promise<Plan['calls']> {
    const h = L.hub; const s = L.spokeManager
    const f = await fee('robinhood')
    return [create(L.spokeInit), create(s.managerInit), create(proxyInit(s.implementation)), call(s.proxy, encodeFunctionData({ abi: nttAbi, functionName: 'initialize' })),
      create(s.transceiverInit), create(proxyInit(s.transceiverImplementation)), call(s.transceiver, encodeFunctionData({ abi: transceiverAbi, functionName: 'initialize' }), f),
      call(s.proxy, encodeFunctionData({ abi: nttAbi, functionName: 'setTransceiver', args: [s.transceiver] })),
      call(s.proxy, encodeFunctionData({ abi: nttAbi, functionName: 'setThreshold', args: [1] })),
      call(s.proxy, encodeFunctionData({ abi: nttAbi, functionName: 'setOutboundLimit', args: [config.limits.outbound] })),
      call(s.proxy, encodeFunctionData({ abi: nttAbi, functionName: 'setPeer', args: [config.arc.wormholeChainId, universal(h.proxy), 6, config.limits.inbound] })),
      call(s.transceiver, encodeFunctionData({ abi: transceiverAbi, functionName: 'setWormholePeer', args: [config.arc.wormholeChainId, universal(h.transceiver)] }), f),
      call(L.spoke, encodeFunctionData({ abi: spokeAbi, functionName: 'setMinter', args: [s.proxy] }))]
  }
  const deploySpoke = () => execute('manager:robinhood', 'robinhood', spokeCalls)

  /** Seed the Robinhood v3 pool from the executor's spoke balance and quote inventory. */
  async function seedPool(tokens: bigint, quote: bigint) {
    const rh = config.robinhood; const venue = rh.venue
    return execute('pool:robinhood', 'robinhood', async () => {
      const existing = await clients.robinhood.readContract({ address: venue.factory, abi: v3FactoryAbi, functionName: 'getPool', args: [L.spoke, rh.quote, venue.fee] })
      if (existing !== zeroAddress) throw new LaunchError(409, 'pool_exists', `A ${venue.fee} pool for the spoke already exists at ${existing}; refusing to seed a pool this rehearsal did not create.`)
      const { data } = await clients.robinhood.call({ account: rh.executor, to: venue.factory, data: encodeFunctionData({ abi: v3FactoryAbi, functionName: 'createPool', args: [L.spoke, rh.quote, venue.fee] }) })
      const pool: Address = `0x${data!.slice(26, 66)}`
      const tokenFirst = L.spoke.toLowerCase() < rh.quote.toLowerCase()
      const total0 = tokenFirst ? tokens : quote; const total1 = tokenFirst ? quote : tokens
      const p = v3Plan(total0, total1, venue.tickSpacing)
      return [call(venue.factory, encodeFunctionData({ abi: v3FactoryAbi, functionName: 'createPool', args: [L.spoke, rh.quote, venue.fee] })),
        call(pool, encodeFunctionData({ abi: v3PoolAbi, functionName: 'initialize', args: [p.sqrtPriceX96] })),
        call(pool, encodeFunctionData({ abi: v3PoolAbi, functionName: 'mint', args: [rh.executor, p.lower, p.upper, p.liquidity, encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [total0, total1])] }))]
    })
  }
  const pool = () => clients.robinhood.readContract({ address: config.robinhood.venue.factory, abi: v3FactoryAbi, functionName: 'getPool', args: [L.spoke, config.robinhood.quote, config.robinhood.venue.fee] })

  /** Executable quote from the real QuoterV2: the amount a swap of `amountIn` would return now, fees and impact included. */
  async function quote(amountIn: bigint, sell: 'spoke' | 'quote') {
    const rh = config.robinhood
    const [tokenIn, tokenOut] = sell === 'spoke' ? [L.spoke, rh.quote] : [rh.quote, L.spoke]
    const { result } = await clients.robinhood.simulateContract({ address: rh.venue.quoterV2, abi: quoterAbi, functionName: 'quoteExactInputSingle', args: [{ tokenIn, tokenOut, amountIn, fee: rh.venue.fee, sqrtPriceLimitX96: 0n }] })
    return { tokenIn, tokenOut, amountIn, amountOut: result[0], gasEstimate: result[3] }
  }

  const readTransfer = (id: string): Transfer | undefined => {
    const r = db.query<{ id: string; direction: string; amount: string; recipient: string; state: string; debit_tx: string | null; debit_block: string | null; vaa: string | null; credit_tx: string | null }, [string]>('SELECT * FROM robinhood_transfers WHERE id=?').get(id)
    if (!r) return undefined
    return { id: r.id, direction: r.direction as Direction, amount: BigInt(r.amount), recipient: r.recipient as Address, state: r.state as TransferState, debitTx: r.debit_tx as Hex | null,
      debitBlock: r.debit_block === null ? null : BigInt(r.debit_block), vaa: r.vaa as Hex | null, creditTx: r.credit_tx as Hex | null }
  }

  /** Register a transfer. The same id with other parameters is a conflict, never a second transfer. */
  function transfer(id: string, direction: Direction, amount: bigint, recipient: Address): Transfer {
    if (amount <= 0n) throw new LaunchError(400, 'amount', 'Transfer amount must be positive.')
    if (amount > config.limits.outbound || amount > config.limits.inbound) throw new LaunchError(409, 'rate_limit', 'The amount exceeds the configured NTT rate limit and would queue.')
    db.query('INSERT OR IGNORE INTO robinhood_transfers(id, direction, amount, recipient, state, created_at) VALUES(?,?,?,?,?,?)').run(id, direction, amount.toString(), recipient.toLowerCase(), 'planned', Date.now())
    const t = readTransfer(id)!
    if (t.direction !== direction || t.amount !== amount || !same(t.recipient, recipient)) throw new LaunchError(409, 'transfer_conflict', `Transfer ${id} is already bound to other parameters.`)
    return t
  }

  /**
   * The debit or credit leg of a transfer as an (operation name, chain, plan) triple, the same for
   * `advance` and for callers that persist a leg's bytes before sending it.
   */
  function leg(t: Transfer, kind: 'debit' | 'credit') {
    const source: Side = t.direction === 'outbound' ? 'arc' : 'robinhood'
    const destination = other(source)
    if (kind === 'debit') {
      const [sourceToken, sourceManager] = source === 'arc' ? [L.canonical, L.hub.proxy] : [L.spoke, L.spokeManager.proxy]
      return { name: `transfer:${t.id}:debit`, side: source, build: async () => [
        call(sourceToken, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [sourceManager, t.amount] })),
        call(sourceManager, encodeFunctionData({ abi: nttAbi, functionName: 'transfer', args: [t.amount, config[destination].wormholeChainId, universal(t.recipient)] }), await fee(source))] }
    }
    if (!t.vaa) throw new Error(`Transfer ${t.id} has no attested VAA to credit`)
    const transceiver = destination === 'arc' ? L.hub.transceiver : L.spokeManager.transceiver
    return { name: `transfer:${t.id}:credit`, side: destination, build: () => [call(transceiver, encodeFunctionData({ abi: transceiverAbi, functionName: 'receiveMessage', args: [t.vaa!] }))] }
  }

  /**
   * Advance one transfer as far as chain state allows, or no further than `stopAt`. Safe to call
   * from any worker, any number of times.
   */
  async function advance(id: string, stopAt: TransferState = 'credited'): Promise<Progress> {
    const t = readTransfer(id)
    if (!t) throw new Error(`Unknown transfer ${id}`)
    const source: Side = t.direction === 'outbound' ? 'arc' : 'robinhood'
    const destination = other(source)
    const [sourceToken, sourceManager] = source === 'arc' ? [L.canonical, L.hub.proxy] : [L.spoke, L.spokeManager.proxy]
    if (t.state === stopAt) return t.state
    if (t.state === 'planned') {
      const debit = leg(t, 'debit')
      const receipt = await execute(debit.name, debit.side, debit.build)
      const moved = transfersIn(receipt, sourceToken).filter((x) => same(x.from, config[source].executor) && same(x.to, sourceManager)).reduce((n, x) => n + x.value, 0n)
      if (moved !== t.amount) throw new Error(`Debit ${id} moved ${moved}, not ${t.amount}`)
      db.query("UPDATE robinhood_transfers SET state='debited', debit_tx=?, debit_block=? WHERE id=? AND state='planned'").run(receipt.transactionHash, receipt.blockNumber.toString(), id)
      return advance(id, stopAt)
    }
    if (t.state === 'debited') {
      const latest = await clients[source].getBlockNumber({ cacheTime: 0 })
      if (latest < t.debitBlock! + BigInt(config[source].confirmations)) return 'awaiting_finality'
      // Re-read the debit from chain: it must still be in the canonical history at the same block.
      const receipt = await clients[source].getTransactionReceipt({ hash: t.debitTx! })
      if (receipt.blockNumber !== t.debitBlock) throw new Error(`Debit ${id} moved from block ${t.debitBlock} to ${receipt.blockNumber}; reorg`)
      const block = await clients[source].getBlock({ blockNumber: receipt.blockNumber })
      const messages = publishedFrom(receipt.logs, config[source].core, config[source].wormholeChainId, Number(block.timestamp))
      if (messages.length !== 1) throw new Error(`Debit ${id} published ${messages.length} Wormhole messages; expected exactly one`)
      const vaa = await config.vaa[destination].signed(messages[0])
      if (!vaa) return 'awaiting_attestation'
      db.query("UPDATE robinhood_transfers SET state='attested', vaa=? WHERE id=? AND state='debited'").run(vaa, id)
      return advance(id, stopAt)
    }
    if (t.state === 'attested') {
      const [destToken, destManager] = destination === 'arc' ? [L.canonical, L.hub.proxy] : [L.spoke, L.spokeManager.proxy]
      const credit = leg(t, 'credit')
      const receipt = await execute(credit.name, credit.side, credit.build)
      // Outbound credits mint on Robinhood; return credits unlock from the hub's custody on Arc.
      const from = destination === 'arc' ? destManager : zeroAddress
      const credited = transfersIn(receipt, destToken).filter((x) => same(x.from, from) && same(x.to, t.recipient)).reduce((n, x) => n + x.value, 0n)
      if (credited !== t.amount) throw new Error(`Credit ${id} delivered ${credited}, not ${t.amount}: the inbound transfer is queued or was not redeemed`)
      db.query("UPDATE robinhood_transfers SET state='credited', credit_tx=? WHERE id=? AND state='attested'").run(receipt.transactionHash, id)
      return 'credited'
    }
    return t.state
  }

  /**
   * Supply accounting from chain state plus journalled in-flight claims, in token atoms. Hub custody
   * must equal spoke supply plus claims debited but not yet credited, in either direction, and the
   * total accounted for must equal the fixed issuance.
   */
  async function supply() {
    const totalSupply = (side: Side, address: Address) => clients[side].readContract({ address, abi: erc20Abi, functionName: 'totalSupply' })
    const issued = await totalSupply('arc', L.canonical)
    const custody = await clients.arc.readContract({ address: L.canonical, abi: erc20Abi, functionName: 'balanceOf', args: [L.hub.proxy] })
    const spokeSupply = await totalSupply('robinhood', L.spoke)
    const pending = db.query<{ amount: string }, []>("SELECT amount FROM robinhood_transfers WHERE state IN ('debited','attested')").all().reduce((n, r) => n + BigInt(r.amount), 0n)
    const accounted = issued - custody + spokeSupply + pending
    return { issued, custody, spokeSupply, pending, accounted, reconciled: issued === config.asset.issuance && accounted === config.asset.issuance && custody === spokeSupply + pending }
  }

  return { config, clients, layout: L, persist, execute, leg, executedReceipt, deployHub, spokeCalls, deploySpoke, seedPool, pool, quote, transfer, advance, get: readTransfer, supply, digestOf }
}
export type RobinhoodRoute = ReturnType<typeof robinhoodRoute>
