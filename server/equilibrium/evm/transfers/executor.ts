import type { Database } from 'bun:sqlite'
import {
  BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, createPublicClient, createWalletClient, defineChain, encodeFunctionData, http, keccak256, parseTransaction,
  type Address, type Hex, type PublicClient, type TransactionReceipt, type WalletClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { hash } from '../../request'
import { LaunchError, type PreparedEffect } from '../../types'
import { weiOf } from '../adapter'
import { executorAbi } from '../contracts'
import type { ChainConfig } from '../types'
import type { EvmChain } from './types'

/** One executor operation, persisted before anything is sent. The same shape the launch adapter uses. */
export interface ExecutorPlan {
  chain: EvmChain
  chainId: number
  executor: Address
  operation: Hex
  calls: { target: Address; value: string; data: Hex }[]
  value: string
  fromBlock: string
  expect: Record<string, string>
}
export interface SenderConfig {
  operatorKey: Hex
  arc: ChainConfig
  base: ChainConfig
  receiptTimeoutMs?: number
  /** Cumulative operator gas for transfers, native wei per chain, L1 fee included. Required outside forks. */
  operatorGas?: { arc: string; base: string }
}
/** Test seams around the one irreversible call: signed and recorded but not yet sent, and sent but not yet accounted. */
export interface SenderOptions { beforeSend?: (tx: Hex) => void; afterSend?: (tx: Hex) => void; checkpoint?: (point: string, operation: Hex) => void }

const ZERO: Hex = `0x${'0'.repeat(64)}`
const OPERATION_DONE = '0x3a140fc2'
const GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000F' as const
const gasPriceOracleAbi = [{ type: 'function', name: 'getL1FeeUpperBound', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] }] as const
const DECIMAL = /^(0|[1-9]\d*)$/

export const chainOf = (c: ChainConfig) => defineChain({ id: c.chainId, name: c.chain, nativeCurrency: { name: 'native', symbol: 'NATIVE', decimals: 18 }, rpcUrls: { default: { http: [c.rpc] } } })
export const call = (target: Address, data: Hex, value = 0n) => ({ target, value: value.toString(), data })
export function prepared(plan: ExecutorPlan): PreparedEffect {
  const bytes = JSON.stringify(plan)
  return { operation: plan.operation, digest: hash(bytes), bytes }
}
export function parsePlan(effect: PreparedEffect, operation: Hex): ExecutorPlan {
  if (hash(effect.bytes) !== effect.digest || effect.operation !== operation) throw new Error('Prepared bytes changed')
  return JSON.parse(effect.bytes) as ExecutorPlan
}

/**
 * Sends and observes executor operations for transfers. Exactly-once is the executor's: an
 * operation id executes at most once, so a stale worker, a restarted worker or a replayed
 * transaction can only waste its own gas.
 *
 * Gas follows the launch adapter's ledger (PR #12, 49TH-25), in its own table against its own cap:
 * the worst case is reserved in one IMMEDIATE transaction before anything is signed, so competing
 * processes sharing the store serialize on the cap. The signed transaction's hash is recorded on
 * the reservation before it is broadcast, so a process that dies at any point after sending is
 * settled later from the receipt. A reservation whose transaction never mined stays at worst case:
 * the ledger can over-count, never under-count.
 */
export function executorSender(config: SenderConfig, db: Database, options: SenderOptions = {}) {
  const account = privateKeyToAccount(config.operatorKey)
  const chains = { arc: config.arc, base: config.base }
  const clients = {
    arc: createPublicClient({ chain: chainOf(config.arc), transport: http(config.arc.rpc) }) as PublicClient,
    base: createPublicClient({ chain: chainOf(config.base), transport: http(config.base.rpc) }) as PublicClient,
  }
  const wallets: Record<EvmChain, WalletClient> = {
    arc: createWalletClient({ account, chain: chainOf(config.arc), transport: http(config.arc.rpc) }),
    base: createWalletClient({ account, chain: chainOf(config.base), transport: http(config.base.rpc) }),
  }
  db.exec(`CREATE TABLE IF NOT EXISTS evm_transfer_broadcasts (operation TEXT NOT NULL, chain TEXT NOT NULL, tx TEXT NOT NULL, sent_at INTEGER NOT NULL, PRIMARY KEY (operation, tx));
    CREATE TABLE IF NOT EXISTS evm_transfer_gas (id INTEGER PRIMARY KEY AUTOINCREMENT, chain TEXT NOT NULL, operation TEXT NOT NULL, worst TEXT NOT NULL, tx TEXT, actual TEXT, reserved_at INTEGER NOT NULL);`)
  db.transaction(() => {
    if (!db.query<{ name: string }, []>('PRAGMA table_info(evm_transfer_gas)').all().some((c) => c.name === 'signed')) db.exec('ALTER TABLE evm_transfer_gas ADD COLUMN signed TEXT;')
  }).immediate()
  const sending: Record<EvmChain, Promise<unknown>> = { arc: Promise.resolve(), base: Promise.resolve() }

  async function finalizedBlock(chain: EvmChain): Promise<bigint> {
    const finality = chains[chain].finality
    if (finality === 'finalized') return (await clients[chain].getBlock({ blockTag: 'finalized' })).number
    return (await clients[chain].getBlockNumber({ cacheTime: 0 })) - BigInt(finality)
  }
  async function executed(p: ExecutorPlan, blockNumber: bigint): Promise<Hex> {
    try {
      return await clients[p.chain].readContract({ address: p.executor, abi: executorAbi, functionName: 'digestOf', args: [p.operation], blockNumber })
    } catch (cause) {
      if (cause instanceof BaseError && cause.walk((e) => e instanceof ContractFunctionZeroDataError)) return ZERO
      throw cause
    }
  }
  const toAtoms = (chain: EvmChain, wei: bigint) => (wei * chains[chain].usdcAtomsPerNative + 10n ** 18n - 1n) / 10n ** 18n
  const args = (p: ExecutorPlan, digest: Hex) => [p.operation, digest, p.calls.map((x) => ({ target: x.target, value: BigInt(x.value), data: x.data }))] as const
  const legacy = () => (db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='evm_transfer_spend'").get() ? db.query<{ tx: string; chain: string; wei: string }, []>('SELECT tx, chain, wei FROM evm_transfer_spend').all() : [])

  /** Refuse to send from an RPC that is not the approved chain: the check sits before any signing. */
  async function assertChain(chain: EvmChain, planned?: number) {
    const reported = await clients[chain].getChainId()
    if (reported !== chains[chain].chainId || (planned !== undefined && planned !== chains[chain].chainId)) {
      throw new LaunchError(409, 'wrong_chain', `${chain} RPC reports chain ${reported}; the approved chain is ${chains[chain].chainId}${planned !== undefined && planned !== chains[chain].chainId ? ` and the plan names ${planned}` : ''}. Nothing was sent.`)
    }
  }

  /**
   * Operator gas committed on a chain: actual cost of settled sends plus the worst case of every
   * reservation not yet settled. A legacy spend row that is not a decimal integer (the pre-repair
   * hex-L1-fee concatenation) must be recovered by `settleGas` first; until then, sends stop.
   */
  function committed(chain: EvmChain): bigint {
    let total = db.query<{ worst: string; actual: string | null }, [string]>('SELECT worst, actual FROM evm_transfer_gas WHERE chain=?').all(chain).reduce((n, r) => n + BigInt(r.actual ?? r.worst), 0n)
    for (const row of legacy().filter((r) => r.chain === chain)) {
      if (!DECIMAL.test(row.wei)) throw new LaunchError(409, 'gas_ledger', `The ${chain} gas ledger holds an unreadable spend row for ${row.tx}; settle it from its receipt before sending. Nothing was sent.`)
      total += BigInt(row.wei)
    }
    return total
  }

  /**
   * Bring the ledger up to date from finalized receipts, never by resubmitting anything: legacy
   * spend rows move into the reservation table at the receipt's numeric cost, and every sent,
   * unsettled reservation takes its receipt's actual cost. Unknown receipts stay as they are.
   */
  async function settleGas(chain: EvmChain) {
    const finalized = await finalizedBlock(chain)
    for (const row of legacy().filter((r) => r.chain === chain)) {
      const receipt = await clients[chain].getTransactionReceipt({ hash: row.tx as Hex }).catch(() => null)
      if (!receipt || receipt.blockNumber > finalized) continue
      const operation = db.query<{ operation: string }, [string]>('SELECT operation FROM evm_transfer_broadcasts WHERE tx=?').get(row.tx)?.operation ?? ''
      const actual = weiOf(receipt).toString()
      db.transaction(() => {
        if (!db.query('SELECT 1 FROM evm_transfer_gas WHERE tx=?').get(row.tx)) {
          db.query('INSERT INTO evm_transfer_gas(chain, operation, worst, tx, actual, reserved_at) VALUES(?,?,?,?,?,?)').run(chain, operation, actual, row.tx, actual, Date.now())
        }
        db.query('DELETE FROM evm_transfer_spend WHERE tx=?').run(row.tx)
      }).immediate()
    }
    for (const row of db.query<{ id: number; tx: string }, [string]>('SELECT id, tx FROM evm_transfer_gas WHERE chain=? AND tx IS NOT NULL AND actual IS NULL').all(chain)) {
      const receipt = await clients[chain].getTransactionReceipt({ hash: row.tx as Hex }).catch(() => null)
      if (receipt && receipt.blockNumber <= finalized) {
        const operation = db.query<{ operation: Hex }, [number]>('SELECT operation FROM evm_transfer_gas WHERE id=?').get(row.id)!.operation
        options.checkpoint?.('before-cost-write', operation)
        db.query('UPDATE evm_transfer_gas SET actual=? WHERE id=?').run(weiOf(receipt).toString(), row.id)
        options.checkpoint?.('after-cost-write', operation)
      }
    }
  }

  /** Check the cap and take the worst case in one IMMEDIATE transaction; every process sharing the store serializes here. */
  const reserve = (chain: EvmChain, operation: Hex, worst: bigint) => db.transaction(() => {
    const cap = config.operatorGas?.[chain]
    if (cap !== undefined && committed(chain) + worst > BigInt(cap)) throw new LaunchError(409, 'gas_cap', `${chain} transfer gas would exceed the approved ${cap} wei. Nothing was sent.`)
    return Number(db.query('INSERT INTO evm_transfer_gas(chain, operation, worst, reserved_at) VALUES(?,?,?,?)').run(chain, operation, worst.toString(), Date.now()).lastInsertRowid)
  }).immediate()

  /** Explicit EIP-1559 fees, capped by a configured ceiling, so the reserved worst case is the most the send can pay. */
  async function fees(chain: EvmChain) {
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

  return {
    account, clients, chains, finalizedBlock, executed, committed, settleGas,
    /** Operator gas of a receipt in USDC atoms, rounded up. The L1 fee is parsed as a number, hex or decimal. */
    cost: (chain: EvmChain, receipt: TransactionReceipt) => toAtoms(chain, weiOf(receipt)).toString(),
    /** Startup check: each RPC is the approved chain and each executor is owned by this operator. */
    async verify() {
      for (const chain of ['arc', 'base'] as const) {
        await assertChain(chain)
        const owner = await clients[chain].readContract({ address: chains[chain].executor, abi: executorAbi, functionName: 'owner' })
        if (owner.toLowerCase() !== account.address.toLowerCase()) throw new Error(`${chain} executor is owned by ${owner}, not the operator ${account.address}`)
      }
    },
    /**
     * The finalized receipt of an operation's execution, or 'pending' while it is executed but not
     * final or still in a mempool. 'absent' only when neither holds.
     */
    async observe(p: ExecutorPlan, digest: Hex): Promise<TransactionReceipt | 'pending' | 'absent'> {
      const client = clients[p.chain]
      const finalized = await finalizedBlock(p.chain)
      const atFinal = await executed(p, finalized)
      if (atFinal !== ZERO) {
        if (atFinal !== digest) throw new Error('Operation already bound to other bytes')
        const [log] = await client.getLogs({ address: p.executor, event: executorAbi.find((x) => x.type === 'event' && x.name === 'Executed')!, args: { operation: p.operation }, fromBlock: BigInt(p.fromBlock), toBlock: finalized }) as { transactionHash: Hex }[]
        if (!log) throw new Error('Executed operation has no log in the searched range')
        return client.getTransactionReceipt({ hash: log.transactionHash })
      }
      const latest = await executed(p, await client.getBlockNumber({ cacheTime: 0 }))
      if (latest === digest) return 'pending'
      if (latest !== ZERO) throw new Error('Operation already bound to other bytes')
      for (const { tx } of db.query<{ tx: string }, [string]>('SELECT tx FROM evm_transfer_broadcasts WHERE operation=?').all(p.operation)) {
        if (await client.getTransaction({ hash: tx as Hex }).then((t) => t.blockNumber === null, () => false)) return 'pending'
      }
      return 'absent'
    },
    /** Send identical persisted bytes, at most once per operation on-chain, within the transfer gas cap. */
    async broadcast(p: ExecutorPlan, digest: Hex): Promise<void> {
      const client = clients[p.chain]
      const run = async () => {
        await assertChain(p.chain, p.chainId)
        const current = await executed(p, await client.getBlockNumber({ cacheTime: 0 }))
        if (current === digest) return
        if (current !== ZERO) throw new Error('Operation already bound to other bytes')
        // A crash before the send leaves signed bytes and the worst-case reservation intact.
        // Replay that exact transaction; a second reservation would strand the first cost forever.
        const recovery = db.query<{ id: number; tx: Hex; signed: Hex }, [string, string]>(
          'SELECT id,tx,signed FROM evm_transfer_gas WHERE chain=? AND operation=? AND actual IS NULL AND tx IS NOT NULL AND signed IS NOT NULL ORDER BY id LIMIT 1').get(p.chain, p.operation)
        if (recovery) {
          if (keccak256(recovery.signed) !== recovery.tx) throw new Error('Persisted transfer transaction changed.')
          const signed = parseTransaction(recovery.signed)
          if (signed.chainId !== p.chainId || signed.to?.toLowerCase() !== p.executor.toLowerCase()
            || signed.data !== encodeFunctionData({ abi: executorAbi, functionName: 'execute', args: args(p, digest) }) || (signed.value ?? 0n) !== BigInt(p.value)) throw new Error('Persisted transfer transaction differs from its bound plan.')
          const cap = config.operatorGas?.[p.chain]
          if (cap !== undefined && committed(p.chain) > BigInt(cap)) throw new LaunchError(409, 'gas_cap', `${p.chain} reserved transfer gas exceeds the approved ${cap} wei. Nothing was sent.`)
          const known = await client.getTransaction({ hash: recovery.tx }).then(() => true, () => false)
          if (!known) {
            options.checkpoint?.('before-send', p.operation)
            await client.sendRawTransaction({ serializedTransaction: recovery.signed })
            options.checkpoint?.('after-send', p.operation)
          }
          const receipt = await client.waitForTransactionReceipt({ hash: recovery.tx, timeout: config.receiptTimeoutMs ?? 120_000 })
          options.checkpoint?.('before-cost-write', p.operation)
          db.query('UPDATE evm_transfer_gas SET actual=? WHERE id=?').run(weiOf(receipt).toString(), recovery.id)
          options.checkpoint?.('after-cost-write', p.operation)
          if (receipt.status !== 'success') throw new Error(`Persisted transfer reverted in ${recovery.tx}; reconcile before retrying.`)
          return
        }
        let gas: bigint
        try {
          await client.simulateContract({ account, address: p.executor, abi: executorAbi, functionName: 'execute', args: args(p, digest), value: BigInt(p.value) })
          gas = await client.estimateContractGas({ account, address: p.executor, abi: executorAbi, functionName: 'execute', args: args(p, digest), value: BigInt(p.value) })
        } catch (cause) {
          const revert = cause instanceof BaseError ? cause.walk((e) => e instanceof ContractFunctionRevertedError) : null
          if (revert instanceof ContractFunctionRevertedError && revert.data?.errorName === 'OperationDone') return
          throw cause
        }
        const limit = (gas * 12n) / 10n
        const fee = await fees(p.chain)
        const data = encodeFunctionData({ abi: executorAbi, functionName: 'execute', args: args(p, digest) })
        let worst = limit * fee.maxFeePerGas
        if (chains[p.chain].opStackL1Fee) {
          worst += await client.readContract({ address: GAS_PRICE_ORACLE, abi: gasPriceOracleAbi, functionName: 'getL1FeeUpperBound', args: [BigInt((data.length - 2) / 2 + 68)] })
        }
        // Settle what is known first, so finished sends count at their actual cost, then reserve.
        await settleGas(p.chain)
        const reservation = reserve(p.chain, p.operation, worst)
        let tx: Hex | undefined
        for (let attempt = 0; attempt < 3 && !tx; attempt++) {
          let signed: Hex | undefined
          try {
            const request = await wallets[p.chain].prepareTransactionRequest({ account, chain: chainOf(chains[p.chain]), to: p.executor, data, value: BigInt(p.value), gas: limit, ...fee })
            signed = await account.signTransaction(request)
            const hashed = keccak256(signed)
            // Recorded before the irreversible call: a process that dies after it is settled from the receipt.
            db.transaction(() => {
              db.query('UPDATE evm_transfer_gas SET tx=?,signed=? WHERE id=?').run(hashed, signed!, reservation)
              db.query('INSERT OR IGNORE INTO evm_transfer_broadcasts(operation, chain, tx, sent_at) VALUES(?,?,?,?)').run(p.operation, p.chain, hashed, Date.now())
            }).immediate()
            options.beforeSend?.(hashed)
            options.checkpoint?.('before-send', p.operation)
            tx = await client.sendRawTransaction({ serializedTransaction: signed })
            options.checkpoint?.('after-send', p.operation)
            options.afterSend?.(tx)
          } catch (cause) {
            // Another worker's execution landed first, or the RPC refused before accepting anything.
            const known = signed ? await client.getTransaction({ hash: keccak256(signed) }).then(() => true, () => false) : false
            if (!known) db.query('UPDATE evm_transfer_gas SET tx=NULL WHERE id=?').run(reservation)
            if (String(cause).includes(OPERATION_DONE) || await client.readContract({ address: p.executor, abi: executorAbi, functionName: 'digestOf', args: [p.operation], blockTag: 'pending' }) === digest) {
              if (!known) db.query('DELETE FROM evm_transfer_gas WHERE id=? AND tx IS NULL').run(reservation)
              return
            }
            if (attempt === 2 || !/nonce|underpriced|already known/i.test(String(cause))) {
              // Never signed or never accepted: nothing can mine against this reservation.
              if (!known) db.query('DELETE FROM evm_transfer_gas WHERE id=? AND tx IS NULL').run(reservation)
              throw cause
            }
          }
        }
        const receipt = await client.waitForTransactionReceipt({ hash: tx!, timeout: config.receiptTimeoutMs ?? 120_000 })
        options.checkpoint?.('before-cost-write', p.operation)
        db.query('UPDATE evm_transfer_gas SET actual=? WHERE id=?').run(weiOf(receipt).toString(), reservation)
        options.checkpoint?.('after-cost-write', p.operation)
        if (receipt.status !== 'success' && await executed(p, receipt.blockNumber) !== digest) throw new Error(`${p.operation} execution reverted in ${tx}`)
      }
      const next = sending[p.chain].then(run, run)
      sending[p.chain] = next.catch(() => undefined)
      await next
    },
  }
}
export type ExecutorSender = ReturnType<typeof executorSender>
