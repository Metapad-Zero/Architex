import type { Database } from 'bun:sqlite'
import {
  BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, createPublicClient, createWalletClient, decodeEventLog, defineChain, encodeAbiParameters, encodeFunctionData, getAddress,
  http, parseSignature, zeroAddress, type Address, type Hex, type PublicClient, type TransactionReceipt, type WalletClient,
} from 'viem'
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { hash, identity } from '../request'
import { LaunchError, type Atoms, type EffectContext, type EffectResult, type Job, type LaunchRequest, type PreparedEffect, type PromotionalTokenAdapter, type Step, type StepKind } from '../types'
import {
  CODE, NTT_COMMIT, architexFactoryAbi, architexPairAbi, coreAbi, erc20Abi, executorAbi, linked, nttAbi, predict, proxyInit, spokeAbi, transceiverAbi,
  universal, usdcAbi, v3FactoryAbi, v3PoolAbi, withArgs,
} from './contracts'
import { plan as v3Plan } from './v3'
import { publishedFrom } from './vaa'
import type { ChainConfig, EvmAdapterConfig } from './types'

export type { ChainConfig, EvmAdapterConfig, Venue } from './types'

const LOCKING = 0
const GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000F' as const
const gasPriceOracleAbi = [{ type: 'function', name: 'getL1FeeUpperBound', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] }] as const
/** Selector of EquilibriumExecutor.OperationDone(bytes32,bytes32). */
const OPERATION_DONE = '0x3a140fc2'
const ZERO: Hex = `0x${'0'.repeat(64)}`
const BURNING = 1
const DAY = 86_400n

/** The immutable plan for one step: the exact executor call, persisted before anything is sent. */
interface Plan {
  chain: 'arc' | 'base'
  chainId: number
  executor: Address
  operation: Hex
  calls: { target: Address; value: string; data: Hex }[]
  value: string
  fromBlock: string
  /** Addresses the result is checked against. */
  expect: Record<string, Address>
}

/** Every address a job will create, derived before any of it exists. */
export function layout(job: Pick<Job, 'id' | 'request'>, config: Pick<EvmAdapterConfig, 'arc' | 'base'>) {
  const op = (step: string) => hash([job.id, step])
  const { arc, base } = config
  const { name, symbol, issuance } = job.request.canonical
  const canonicalInit = withArgs(linked(CODE.EquilibriumCanonical), [{ type: 'string' }, { type: 'string' }, { type: 'address' }, { type: 'uint64' }], [name, symbol, arc.executor, BigInt(issuance)])
  const canonical = predict(arc.executor, op('canonical:arc'), 0, canonicalInit)
  const manager = (chain: ChainConfig, token: Address, mode: number, operation: Hex, first: number) => {
    const lib = { TransceiverStructs: chain.transceiverStructs }
    const managerInit = withArgs(linked(CODE.NttManager, lib), [{ type: 'address' }, { type: 'uint8' }, { type: 'uint16' }, { type: 'uint64' }, { type: 'bool' }], [token, mode, chain.wormholeChainId, DAY, false])
    const implementation = predict(chain.executor, operation, first, managerInit)
    const proxy = predict(chain.executor, operation, first + 1, proxyInit(implementation))
    const transceiverInit = withArgs(linked(CODE.WormholeTransceiver, lib), [{ type: 'address' }, { type: 'address' }, { type: 'uint8' }, { type: 'uint8' }, { type: 'uint16' }, { type: 'address' }], [proxy, chain.core, 0, 0, 0, zeroAddress])
    const transceiverImplementation = predict(chain.executor, operation, first + 3, transceiverInit)
    const transceiver = predict(chain.executor, operation, first + 4, proxyInit(transceiverImplementation))
    return { managerInit, implementation, proxy, transceiverInit, transceiverImplementation, transceiver }
  }
  const spokeInit = withArgs(linked(CODE.EquilibriumSpoke), [{ type: 'string' }, { type: 'string' }, { type: 'address' }, { type: 'uint64' }], [name, symbol, base.executor, BigInt(issuance)])
  const spoke = predict(base.executor, op('manager:base'), 0, spokeInit)
  return { op, canonicalInit, canonical, hub: manager(arc, canonical, LOCKING, op('manager:arc'), 0), spokeInit, spoke, spokeManager: manager(base, spoke, BURNING, op('manager:base'), 1) }
}

function chainOf(config: ChainConfig) {
  return defineChain({ id: config.chainId, name: config.chain, nativeCurrency: { name: 'native', symbol: 'NATIVE', decimals: 18 }, rpcUrls: { default: { http: [config.rpc] } } })
}
const call = (target: Address, data: Hex, value = 0n) => ({ target, value: value.toString(), data })
const create = (init: Hex) => ({ target: zeroAddress as Address, value: '0', data: init })
/** eth_call as the executor, with no fee fields, returning the address the call would create. */
async function dryRun(client: PublicClient, from: Address, to: Address, data: Hex): Promise<Address> {
  // The executor may hold no native gas; the dry run must not depend on it.
  const { data: out } = await client.call({ account: from, to, data, stateOverride: [{ address: from, balance: 10n ** 24n }] })
  if (!out || out.length < 66) throw new Error(`Dry run of ${to} returned no address`)
  return getAddress(`0x${out.slice(26, 66)}`)
}
const destination = (request: LaunchRequest, chain: 'arc' | 'base') => request.destinations.find((d) => d.chain === chain)

/**
 * Real RPC adapter for the Arc hub and Base spoke. Idempotency lives on-chain: each step is one
 * `EquilibriumExecutor.execute(operation, digest, calls)`, and the executor refuses a second
 * execution of an operation, so a stale worker, a restart or a replayed transaction cannot
 * repeat an issuance, debit, credit or pool deposit. Results come from finalized receipts.
 */
/** Test seam: runs right after a transaction is handed to the RPC, before anything about it is recorded. */
export interface EvmAdapterOptions { afterSend?: (step: Step, tx: Hex) => void }

/**
 * An OP Stack receipt's L1 fee as a bigint. viem leaves `l1Fee` as the raw hex string unless the
 * chain uses the OP Stack formatter, and a string added to a bigint concatenates instead of adding.
 */
export function l1FeeOf(receipt: TransactionReceipt): bigint {
  const value = (receipt as TransactionReceipt & { l1Fee?: unknown }).l1Fee
  if (value === undefined || value === null) return 0n
  if (typeof value === 'bigint' && value >= 0n) return value
  if ((typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
    || (typeof value === 'string' && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(value))) return BigInt(value)
  throw new Error(`Unreadable l1Fee ${String(value)} on ${receipt.transactionHash}`)
}
export const weiOf = (receipt: TransactionReceipt) => receipt.gasUsed * receipt.effectiveGasPrice + l1FeeOf(receipt)

export function evmAdapter(config: EvmAdapterConfig, db: Database, options: EvmAdapterOptions = {}): PromotionalTokenAdapter & {
  verify(): Promise<void>; clients: Record<'arc' | 'base', PublicClient>; committed(chain: 'arc' | 'base'): bigint; settleGas(chain: 'arc' | 'base'): Promise<void>
} {
  const account: PrivateKeyAccount = privateKeyToAccount(config.operatorKey)
  const chains = { arc: config.arc, base: config.base }
  const clients = {
    arc: createPublicClient({ chain: chainOf(config.arc), transport: http(config.arc.rpc) }) as PublicClient,
    base: createPublicClient({ chain: chainOf(config.base), transport: http(config.base.rpc) }) as PublicClient,
  }
  const wallets: Record<'arc' | 'base', WalletClient> = {
    arc: createWalletClient({ account, chain: chainOf(config.arc), transport: http(config.arc.rpc) }),
    base: createWalletClient({ account, chain: chainOf(config.base), transport: http(config.base.rpc) }),
  }
  db.exec(`CREATE TABLE IF NOT EXISTS evm_broadcasts (operation TEXT NOT NULL, chain TEXT NOT NULL, tx TEXT NOT NULL, sent_at INTEGER NOT NULL, PRIMARY KEY (operation, tx));
    CREATE TABLE IF NOT EXISTS evm_vaas (operation TEXT PRIMARY KEY, vaa TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS evm_payments (operation TEXT PRIMARY KEY, sent_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS evm_gas (id INTEGER PRIMARY KEY AUTOINCREMENT, chain TEXT NOT NULL, operation TEXT NOT NULL, worst TEXT NOT NULL, tx TEXT, actual TEXT, reserved_at INTEGER NOT NULL);`)
  // One sender per chain in this process, so two jobs never race for the operator's nonce.
  const sending: Record<'arc' | 'base', Promise<unknown>> = { arc: Promise.resolve(), base: Promise.resolve() }
  const pinned = { mode: config.mode, ntt: NTT_COMMIT, code: Object.fromEntries(Object.entries(CODE).map(([k, v]) => [k, v.sha256])),
    chains: [config.arc, config.base].map((c) => ({ ...c, rpc: undefined, fromBlock: undefined, priorityFeeWei: undefined, maxFeePerGasWei: c.maxFeePerGasWei?.toString(), usdcAtomsPerNative: c.usdcAtomsPerNative.toString() })),
    limits: { outbound: config.limits.outbound.toString(), inbound: config.limits.inbound.toString() }, budgets: config.budgets, vaa: config.vaa.kind, scope: config.scope ?? null }
  const version = `evm-arc-base-v1:${hash(pinned).slice(2, 18)}`

  const chainForStep = (step: Step): 'arc' | 'base' => (step.kind === 'debit' || step.chain === 'arc' ? 'arc' : 'base')

  async function finalizedBlock(chain: 'arc' | 'base'): Promise<bigint> {
    const finality = chains[chain].finality
    if (finality === 'finalized') return (await clients[chain].getBlock({ blockTag: 'finalized' })).number
    const latest = await clients[chain].getBlockNumber({ cacheTime: 0 })
    return latest - BigInt(finality)
  }

  async function plan({ job, step }: EffectContext): Promise<Plan> {
    const L = layout(job, config)
    const chain = chainForStep(step)
    const c = chains[chain]
    const operation = L.op(step.id)
    const request = job.request
    const calls: Plan['calls'] = []
    const expect: Record<string, Address> = {}
    const fee = await clients[chain].readContract({ address: c.core, abi: coreAbi, functionName: 'messageFee' })
    if (step.kind === 'payment') {
      const payment = job.payment
      if (!payment) throw new Error('Payment step without a verified authorization')
      const a = payment.authorization
      if (a.to.toLowerCase() !== c.executor.toLowerCase()) throw new Error('Authorization does not pay the Arc executor')
      const { r, s, v } = parseSignature(payment.signature)
      calls.push(call(c.usdc, encodeFunctionData({ abi: usdcAbi, functionName: 'transferWithAuthorization', args: [a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, Number(v ?? 27n), r, s] })))
      expect.payer = a.from
    } else if (step.kind === 'canonical') {
      calls.push(create(L.canonicalInit)); expect.token = L.canonical
    } else if (step.kind === 'manager' && step.chain === 'arc') {
      const h = L.hub; const s = L.spokeManager
      calls.push(create(h.managerInit), create(proxyInit(h.implementation)), call(h.proxy, encodeFunctionData({ abi: nttAbi, functionName: 'initialize' })),
        create(h.transceiverInit), create(proxyInit(h.transceiverImplementation)), call(h.transceiver, encodeFunctionData({ abi: transceiverAbi, functionName: 'initialize' }), fee),
        call(h.proxy, encodeFunctionData({ abi: nttAbi, functionName: 'setTransceiver', args: [h.transceiver] })),
        call(h.proxy, encodeFunctionData({ abi: nttAbi, functionName: 'setThreshold', args: [1] })),
        call(h.proxy, encodeFunctionData({ abi: nttAbi, functionName: 'setOutboundLimit', args: [config.limits.outbound] })),
        call(h.proxy, encodeFunctionData({ abi: nttAbi, functionName: 'setPeer', args: [config.base.wormholeChainId, universal(s.proxy), 6, config.limits.inbound] })),
        call(h.transceiver, encodeFunctionData({ abi: transceiverAbi, functionName: 'setWormholePeer', args: [config.base.wormholeChainId, universal(s.transceiver)] }), fee))
      expect.manager = h.proxy; expect.transceiver = h.transceiver
    } else if (step.kind === 'manager') {
      const h = L.hub; const s = L.spokeManager
      calls.push(create(L.spokeInit), create(s.managerInit), create(proxyInit(s.implementation)), call(s.proxy, encodeFunctionData({ abi: nttAbi, functionName: 'initialize' })),
        create(s.transceiverInit), create(proxyInit(s.transceiverImplementation)), call(s.transceiver, encodeFunctionData({ abi: transceiverAbi, functionName: 'initialize' }), fee),
        call(s.proxy, encodeFunctionData({ abi: nttAbi, functionName: 'setTransceiver', args: [s.transceiver] })),
        call(s.proxy, encodeFunctionData({ abi: nttAbi, functionName: 'setThreshold', args: [1] })),
        call(s.proxy, encodeFunctionData({ abi: nttAbi, functionName: 'setOutboundLimit', args: [config.limits.outbound] })),
        call(s.proxy, encodeFunctionData({ abi: nttAbi, functionName: 'setPeer', args: [config.arc.wormholeChainId, universal(h.proxy), 6, config.limits.inbound] })),
        call(s.transceiver, encodeFunctionData({ abi: transceiverAbi, functionName: 'setWormholePeer', args: [config.arc.wormholeChainId, universal(h.transceiver)] }), fee),
        call(L.spoke, encodeFunctionData({ abi: spokeAbi, functionName: 'setMinter', args: [s.proxy] })))
      expect.manager = s.proxy; expect.transceiver = s.transceiver; expect.token = L.spoke
    } else if (step.kind === 'debit') {
      const amount = BigInt(destination(request, 'base')!.amount)
      calls.push(call(L.canonical, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [L.hub.proxy, amount] })),
        call(L.hub.proxy, encodeFunctionData({ abi: nttAbi, functionName: 'transfer', args: [amount, config.base.wormholeChainId, universal(config.base.executor)] }), fee))
      expect.token = L.canonical; expect.manager = L.hub.proxy
    } else if (step.kind === 'credit') {
      const vaa = db.query<{ vaa: string }, [string]>('SELECT vaa FROM evm_vaas WHERE operation=?').get(L.op('debit:base'))?.vaa
      if (!vaa) throw new Error('No signed VAA is recorded for the finalized debit')
      calls.push(call(L.spokeManager.transceiver, encodeFunctionData({ abi: transceiverAbi, functionName: 'receiveMessage', args: [vaa as Hex] })))
      expect.token = L.spoke
    } else if (step.kind === 'pool' && step.chain === 'arc') {
      if (c.venue.kind !== 'architex') throw new Error('Arc pools use the Architex factory')
      const d = destination(request, 'arc')!
      const tokens = BigInt(d.poolTokens); const quote = BigInt(d.poolQuote)
      let pair = await clients.arc.readContract({ address: c.venue.factory, abi: architexFactoryAbi, functionName: 'getPair', args: [L.canonical, c.usdc] })
      if (pair === zeroAddress) {
        pair = await dryRun(clients.arc, c.executor, c.venue.factory, encodeFunctionData({ abi: architexFactoryAbi, functionName: 'createPair', args: [L.canonical, c.usdc] }))
        calls.push(call(c.venue.factory, encodeFunctionData({ abi: architexFactoryAbi, functionName: 'createPair', args: [L.canonical, c.usdc] })))
      }
      calls.push(call(L.canonical, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [pair, tokens] })),
        call(c.usdc, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [pair, quote] })),
        call(pair, encodeFunctionData({ abi: architexPairAbi, functionName: 'mint', args: [c.executor] })))
      // Allocations leave custody here: the Arc recipient's share, then whatever no destination claimed.
      const arcRemainder = BigInt(d.amount) - tokens
      if (arcRemainder > 0n) calls.push(call(L.canonical, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [d.recipient as Address, arcRemainder] })))
      const unallocated = BigInt(request.canonical.issuance) - request.destinations.reduce((n, x) => n + BigInt(x.amount), 0n)
      if (unallocated > 0n) calls.push(call(L.canonical, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [request.canonical.recipient, unallocated] })))
      expect.pool = pair; expect.token = L.canonical; expect.quote = c.usdc
    } else if (step.kind === 'pool') {
      if (c.venue.kind !== 'uniswap-v3') throw new Error('Base pools use Uniswap v3')
      const d = destination(request, 'base')!
      const venue = c.venue
      const pool = await dryRun(clients.base, c.executor, venue.factory, encodeFunctionData({ abi: v3FactoryAbi, functionName: 'createPool', args: [L.spoke, c.usdc, venue.fee] }))
      const tokenFirst = L.spoke.toLowerCase() < c.usdc.toLowerCase()
      const total0 = BigInt(tokenFirst ? d.poolTokens : d.poolQuote); const total1 = BigInt(tokenFirst ? d.poolQuote : d.poolTokens)
      const p = v3Plan(total0, total1, venue.tickSpacing)
      calls.push(call(venue.factory, encodeFunctionData({ abi: v3FactoryAbi, functionName: 'createPool', args: [L.spoke, c.usdc, venue.fee] })),
        call(pool, encodeFunctionData({ abi: v3PoolAbi, functionName: 'initialize', args: [p.sqrtPriceX96] })),
        call(pool, encodeFunctionData({ abi: v3PoolAbi, functionName: 'mint', args: [c.executor, p.lower, p.upper, p.liquidity, encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [total0, total1])] })))
      const remainder = BigInt(d.amount) - BigInt(d.poolTokens)
      if (remainder > 0n) calls.push(call(L.spoke, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [d.recipient as Address, remainder] })))
      expect.pool = pool; expect.token = L.spoke; expect.quote = c.usdc
    } else throw new Error(`No EVM plan for ${step.id}`)
    const value = calls.reduce((n, x) => n + BigInt(x.value), 0n)
    const fromBlock = await clients[chain].getBlockNumber({ cacheTime: 0 })
    return { chain, chainId: c.chainId, executor: c.executor, operation, calls, value: value.toString(), fromBlock: (fromBlock > c.fromBlock ? fromBlock : c.fromBlock).toString(), expect }
  }

  const parse = (prepared: PreparedEffect, step: Step, job: Job): Plan => {
    if (hash(prepared.bytes) !== prepared.digest || prepared.operation !== hash([job.id, step.id])) throw new Error('Prepared bytes changed')
    return JSON.parse(prepared.bytes) as Plan
  }
  const executeArgs = (p: Plan, digest: Hex) => [p.operation, digest, p.calls.map((x) => ({ target: x.target, value: BigInt(x.value), data: x.data }))] as const

  function transfers(receipt: TransactionReceipt, token: Address) {
    return receipt.logs.filter((l) => l.address.toLowerCase() === token.toLowerCase()).flatMap((l) => {
      try {
        const e = decodeEventLog({ abi: erc20Abi, data: l.data, topics: l.topics })
        return e.eventName === 'Transfer' ? [e.args] : []
      } catch { return [] }
    })
  }
  const sum = (items: { value: bigint }[]) => items.reduce((n, x) => n + x.value, 0n).toString()
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

  async function result(p: Plan, step: Step, job: Job, receipt: TransactionReceipt): Promise<EffectResult | 'pending'> {
    const c = chains[p.chain]
    const wei = weiOf(receipt)
    const cost = ((wei * c.usdcAtomsPerNative + 10n ** 18n - 1n) / 10n ** 18n).toString()
    const base: EffectResult = { operation: p.operation, transaction: receipt.transactionHash, finalized: true, cost }
    const X = p.executor
    if (step.kind === 'payment') return { ...base, amount: sum(transfers(receipt, c.usdc).filter((t) => same(t.from, p.expect.payer) && same(t.to, X))) }
    if (step.kind === 'canonical') {
      const minted = transfers(receipt, p.expect.token).filter((t) => t.from === zeroAddress && same(t.to, X))
      return { ...base, address: p.expect.token, amount: sum(minted) }
    }
    if (step.kind === 'manager') {
      const owner = await clients[p.chain].readContract({ address: p.expect.manager, abi: nttAbi, functionName: 'owner', blockNumber: receipt.blockNumber })
      if (!same(owner, X)) throw new Error('Manager owner is not the executor')
      return { ...base, address: p.expect.manager }
    }
    if (step.kind === 'debit') {
      const locked = transfers(receipt, p.expect.token).filter((t) => same(t.from, X) && same(t.to, p.expect.manager))
      // The debit is only usable once the Guardians (or the fork's local guardian) signed it.
      const block = await clients.arc.getBlock({ blockNumber: receipt.blockNumber })
      const messages = publishedFrom(receipt.logs, c.core, c.wormholeChainId, Number(block.timestamp))
      if (messages.length !== 1) throw new Error(`Debit published ${messages.length} Wormhole messages; expected exactly one`)
      const vaa = await config.vaa.signed(messages[0])
      if (!vaa) return 'pending'
      db.query('INSERT OR IGNORE INTO evm_vaas(operation, vaa) VALUES(?, ?)').run(p.operation, vaa)
      return { ...base, amount: sum(locked) }
    }
    if (step.kind === 'credit') {
      const minted = transfers(receipt, p.expect.token).filter((t) => t.from === zeroAddress && same(t.to, X))
      if (!minted.length) throw new Error('Credit executed without a mint: the inbound transfer is queued or was not redeemed')
      return { ...base, amount: sum(minted) }
    }
    // Pool: what left the executor into the pool, token and quote, straight from the receipt.
    const token = sum(transfers(receipt, p.expect.token).filter((t) => same(t.from, X) && same(t.to, p.expect.pool)))
    const quote = sum(transfers(receipt, p.expect.quote).filter((t) => same(t.from, X) && same(t.to, p.expect.pool)))
    return { ...base, address: p.expect.pool, amount: token, quoteAmount: quote }
  }

  /** Explicit EIP-1559 fees, so the worst-case cost checked before sending is the one the tx may pay. */
  async function fees(chain: 'arc' | 'base') {
    const { priorityFeeWei: tip, maxFeePerGasWei: ceiling } = chains[chain]
    let result: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
    if (tip === undefined) {
      const { maxFeePerGas, maxPriorityFeePerGas } = await clients[chain].estimateFeesPerGas()
      result = { maxFeePerGas, maxPriorityFeePerGas }
    } else {
      const block = await clients[chain].getBlock()
      result = { maxPriorityFeePerGas: tip, maxFeePerGas: (block.baseFeePerGas ?? 0n) * 2n + tip }
    }
    if (ceiling === undefined) return result
    return { maxFeePerGas: ceiling, maxPriorityFeePerGas: result.maxPriorityFeePerGas < ceiling ? result.maxPriorityFeePerGas : ceiling }
  }
  /**
   * Operator gas this store has committed on a chain: the actual cost of every settled send plus the
   * worst case of every reservation not yet settled. A process that dies after sending leaves its
   * reservation at worst case, so the cap can only ever over-count, never under-count.
   */
  const committed = (chain: 'arc' | 'base') => db.query<{ worst: string; actual: string | null }, [string]>('SELECT worst, actual FROM evm_gas WHERE chain=?').all(chain)
    .reduce((n, r) => n + BigInt(r.actual ?? r.worst), 0n)
  /** Replace worst case with the receipt's actual cost wherever the transaction is known and mined. */
  async function settleGas(chain: 'arc' | 'base') {
    for (const row of db.query<{ id: number; tx: string }, [string]>('SELECT id, tx FROM evm_gas WHERE chain=? AND tx IS NOT NULL AND actual IS NULL').all(chain)) {
      const receipt = await clients[chain].getTransactionReceipt({ hash: row.tx as Hex }).catch(() => null)
      if (receipt) db.query('UPDATE evm_gas SET actual=? WHERE id=?').run(weiOf(receipt).toString(), row.id)
    }
  }
  const toAtoms = (chain: 'arc' | 'base', wei: bigint) => (wei * chains[chain].usdcAtomsPerNative + 10n ** 18n - 1n) / 10n ** 18n

  /**
   * Refuse to send anything whose worst-case cost (gas limit x max fee, plus the OP Stack L1 fee
   * upper bound) could exceed the step budget or, with a scope, the approved cumulative operator gas.
   */
  async function worstCase(chain: 'arc' | 'base', step: Step, gas: bigint, maxFeePerGas: bigint, data: Hex): Promise<bigint> {
    let worst = gas * maxFeePerGas
    if (chains[chain].opStackL1Fee) {
      worst += await clients[chain].readContract({ address: GAS_PRICE_ORACLE, abi: gasPriceOracleAbi, functionName: 'getL1FeeUpperBound', args: [BigInt((data.length - 2) / 2 + 68)] })
    }
    if (toAtoms(chain, worst) > BigInt(step.budget)) throw new LaunchError(409, 'budget', `${step.id} could cost up to ${toAtoms(chain, worst)} USDC atoms, above its ${step.budget} budget. Nothing was sent.`)
    return worst
  }

  /**
   * One IMMEDIATE transaction takes the SQLite write lock, so every process sharing this store
   * serializes here: the one-launch payment slot and the gas reservation are checked and taken
   * together, or not at all. Returns the reservation id.
   */
  const reserve = (chain: 'arc' | 'base', operation: Hex, worst: bigint, payment: boolean) => db.transaction(() => {
    const scope = config.scope
    if (payment && scope) {
      const paid = db.query<{ count: number }, [string]>('SELECT COUNT(*) AS count FROM evm_payments WHERE operation != ?').get(operation)!.count
      if (paid >= scope.launches) throw new LaunchError(403, 'pilot_scope', 'The approved number of launches has already been paid. Nothing was sent.')
      db.query('INSERT OR IGNORE INTO evm_payments(operation, sent_at) VALUES(?, ?)').run(operation, Date.now())
    }
    const cap = scope?.operatorGas[chain]
    if (cap !== undefined && committed(chain) + worst > BigInt(cap)) throw new LaunchError(409, 'gas_cap', `${chain} operator gas would exceed the approved ${cap} wei. Nothing was sent.`)
    return Number(db.query('INSERT INTO evm_gas(chain, operation, worst, reserved_at) VALUES(?,?,?,?)').run(chain, operation, worst.toString(), Date.now()).lastInsertRowid)
  }).immediate()

  async function executed(p: Plan, blockNumber: bigint): Promise<Hex> {
    try {
      return await clients[p.chain].readContract({ address: p.executor, abi: executorAbi, functionName: 'digestOf', args: [p.operation], blockNumber })
    } catch (cause) {
      // Before the executor existed nothing could have executed; anything else is a real read failure.
      if (cause instanceof BaseError && cause.walk((e) => e instanceof ContractFunctionZeroDataError)) return ZERO
      throw cause
    }
  }

  return {
    mode: config.mode,
    version,
    terms: { chainId: config.arc.chainId, asset: config.arc.usdc, payTo: config.arc.executor, name: 'USDC', version: '2' },
    clients,
    committed,
    settleGas,
    assertReady(request) {
      if (request.destinations.some((d) => d.chain !== 'arc' && d.chain !== 'base') || !destination(request, 'base')) {
        throw new LaunchError(503, 'route_closed', 'This adapter executes the Arc hub and Base spoke only. Solana and Robinhood remain closed.')
      }
      const base = destination(request, 'base')!
      if (BigInt(base.amount) > config.limits.inbound || BigInt(base.amount) > config.limits.outbound) throw new LaunchError(409, 'rate_limit', 'The Base allocation exceeds the configured NTT rate limit and would queue.')
      const scope = config.scope
      if (!scope) return
      const out = (message: string): never => { throw new LaunchError(403, 'pilot_scope', `${message} The approval covers one exact pilot.`) }
      if (!same(request.payer, scope.payer)) out('Only the approved payer may launch.')
      if (!same(request.canonical.recipient, scope.recipient) || request.destinations.some((d) => !same(d.recipient, scope.recipient))) out('Only the approved recipient may receive allocations.')
      if (request.canonical.issuance !== scope.issuance) out('The issuance differs from the approved allocation.')
      const wanted = JSON.stringify(scope.destinations.map(({ chain, amount, poolTokens, poolQuote }) => ({ chain, amount, poolTokens, poolQuote })))
      if (JSON.stringify(request.destinations.map(({ chain, amount, poolTokens, poolQuote }) => ({ chain, amount, poolTokens, poolQuote }))) !== wanted) out('The destinations differ from the approved allocation.')
      const b = config.budgets
      const total = [b.payment, b.canonical, b.manager, b.pool, b.manager, b.debit, b.credit, b.pool].reduce((n, x) => n + BigInt(x), 0n) + request.destinations.reduce((n, d) => n + BigInt(d.poolQuote), 0n)
      if (total > BigInt(scope.maxTotal)) out(`The quoted total ${total} exceeds the approved ${scope.maxTotal}.`)
      // A job already holding an authorization may always resume; a new one may not exceed the launch count.
      const others = db.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM jobs WHERE identity != ? AND json_extract(data, '$.payment') IS NOT NULL").get(identity(request))!.count
      if (others >= scope.launches) out(`${others} approved launch(es) already hold an authorization.`)
    },
    budgets: () => config.budgets,
    async verify() {
      for (const chain of ['arc', 'base'] as const) {
        const c = chains[chain]
        if (await clients[chain].getChainId() !== c.chainId) throw new Error(`${chain} RPC reports a different chain id`)
        if (await clients[chain].readContract({ address: c.core, abi: coreAbi, functionName: 'chainId' }) !== c.wormholeChainId) throw new Error(`${chain} Wormhole core reports a different chain`)
        const owner = await clients[chain].readContract({ address: c.executor, abi: executorAbi, functionName: 'owner' })
        if (!same(owner, account.address)) throw new Error(`${chain} executor is owned by ${owner}, not the operator ${account.address}`)
        const factory = await clients[chain].readContract({ address: c.executor, abi: executorAbi, functionName: 'v3Factory' })
        if (!same(factory, c.venue.kind === 'uniswap-v3' ? c.venue.factory : zeroAddress)) throw new Error(`${chain} executor v3 factory differs from the venue`)
        for (const address of [c.transceiverStructs, c.usdc, c.venue.factory]) if (!(await clients[chain].getCode({ address }))) throw new Error(`${chain}: no code at ${address}`)
      }
    },
    async prepare(context) {
      const p = await plan(context)
      const bytes = JSON.stringify(p)
      return { operation: p.operation, digest: hash(bytes), bytes }
    },
    async observe({ job, step }, prepared) {
      const p = parse(prepared, step, job)
      const client = clients[p.chain]
      const finalized = await finalizedBlock(p.chain)
      const atFinal = await executed(p, finalized)
      if (atFinal !== ZERO) {
        if (atFinal !== prepared.digest) throw new Error('Operation already bound to other bytes')
        const [log] = await client.getLogs({ address: p.executor, event: executorAbi.find((x) => x.type === 'event' && x.name === 'Executed')!, args: { operation: p.operation }, fromBlock: BigInt(p.fromBlock), toBlock: finalized }) as { transactionHash: Hex }[]
        if (!log) throw new Error('Executed operation has no log in the searched range')
        const receipt = await client.getTransactionReceipt({ hash: log.transactionHash })
        return result(p, step, job, receipt)
      }
      // Executed but not yet final, or a submission still in the mempool: pending, never absent.
      if (await executed(p, await client.getBlockNumber({ cacheTime: 0 })) === prepared.digest) return 'pending'
      const sent = db.query<{ tx: string }, [string]>('SELECT tx FROM evm_broadcasts WHERE operation=?').all(p.operation)
      for (const { tx } of sent) {
        const pending = await client.getTransaction({ hash: tx as Hex }).then((t) => t.blockNumber === null, () => false)
        if (pending) return 'pending'
      }
      return 'absent'
    },
    async broadcast({ job, step }, prepared) {
      const p = parse(prepared, step, job)
      const client = clients[p.chain]
      const run = async () => {
        const current = await executed(p, await client.getBlockNumber({ cacheTime: 0 }))
        if (current === prepared.digest) return
        if (current !== ZERO) throw new Error('Operation already bound to other bytes')
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
        const fee = await fees(p.chain)
        const data = encodeFunctionData({ abi: executorAbi, functionName: 'execute', args: executeArgs(p, prepared.digest) })
        const worst = await worstCase(p.chain, step, limit, fee.maxFeePerGas, data)
        // Settle known receipts first so a finished send counts at its actual cost, then reserve.
        await settleGas(p.chain)
        const reservation = reserve(p.chain, p.operation, worst, step.kind === 'payment')
        let tx: Hex | undefined
        for (let attempt = 0; attempt < 3 && !tx; attempt++) {
          try { tx = await wallets[p.chain].writeContract({ account, chain: chainOf(chains[p.chain]), address: p.executor, abi: executorAbi, functionName: 'execute',
            args: executeArgs(p, prepared.digest), value: BigInt(p.value), gas: limit, ...fee }) } catch (cause) {
            // Another worker's execution landed between our simulation and our send: nothing to send.
            // Observe decides afterwards whether that execution is final, pending or was dropped.
            // The rejection came from the fill step, before anything was signed, so the reservation is released.
            if (String(cause).includes(OPERATION_DONE) || await client.readContract({ address: p.executor, abi: executorAbi, functionName: 'digestOf', args: [p.operation], blockTag: 'pending' }) === prepared.digest) {
              db.query('DELETE FROM evm_gas WHERE id=? AND tx IS NULL').run(reservation)
              return
            }
            if (attempt === 2 || !/nonce|underpriced|already known/i.test(String(cause))) throw cause
          }
        }
        options.afterSend?.(step, tx!)
        db.query('UPDATE evm_gas SET tx=? WHERE id=?').run(tx!, reservation)
        db.query('INSERT OR IGNORE INTO evm_broadcasts(operation, chain, tx, sent_at) VALUES(?,?,?,?)').run(p.operation, p.chain, tx!, Date.now())
        const receipt = await client.waitForTransactionReceipt({ hash: tx!, timeout: config.receiptTimeoutMs ?? 120_000 })
        db.query('UPDATE evm_gas SET actual=? WHERE id=?').run(weiOf(receipt).toString(), reservation)
        if (receipt.status !== 'success' && await executed(p, receipt.blockNumber) !== prepared.digest) throw new Error(`${step.id} execution reverted in ${tx}`)
      }
      const next = sending[p.chain].then(run, run)
      sending[p.chain] = next.catch(() => undefined)
      await next
    },
  }
}
