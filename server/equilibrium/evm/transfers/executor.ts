import type { Database } from 'bun:sqlite'
import {
  BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, createPublicClient, createWalletClient, defineChain, encodeFunctionData, http,
  type Address, type Hex, type PublicClient, type TransactionReceipt, type WalletClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { hash } from '../../request'
import { LaunchError, type PreparedEffect } from '../../types'
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

const ZERO: Hex = `0x${'0'.repeat(64)}`
const OPERATION_DONE = '0x3a140fc2'
const GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000F' as const
const gasPriceOracleAbi = [{ type: 'function', name: 'getL1FeeUpperBound', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] }] as const

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
 * transaction can only waste its own gas. Spend is recorded in its own table against its own cap,
 * never against the launch pilot's.
 */
export function executorSender(config: SenderConfig, db: Database) {
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
    CREATE TABLE IF NOT EXISTS evm_transfer_spend (tx TEXT PRIMARY KEY, chain TEXT NOT NULL, wei TEXT NOT NULL);`)
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
  const weiOf = (receipt: TransactionReceipt) => receipt.gasUsed * receipt.effectiveGasPrice + ((receipt as TransactionReceipt & { l1Fee?: bigint }).l1Fee ?? 0n)
  const spent = (chain: EvmChain) => db.query<{ wei: string }, [string]>('SELECT wei FROM evm_transfer_spend WHERE chain=?').all(chain).reduce((n, r) => n + BigInt(r.wei), 0n)
  const args = (p: ExecutorPlan, digest: Hex) => [p.operation, digest, p.calls.map((x) => ({ target: x.target, value: BigInt(x.value), data: x.data }))] as const

  async function fees(chain: EvmChain) {
    const tip = chains[chain].priorityFeeWei
    if (tip === undefined) {
      const { maxFeePerGas, maxPriorityFeePerGas } = await clients[chain].estimateFeesPerGas()
      return { maxFeePerGas, maxPriorityFeePerGas }
    }
    const block = await clients[chain].getBlock()
    return { maxPriorityFeePerGas: tip, maxFeePerGas: (block.baseFeePerGas ?? 0n) * 2n + tip }
  }

  return {
    account, clients, chains, finalizedBlock, executed,
    /** Operator gas of a receipt in USDC atoms, rounded up. */
    cost: (chain: EvmChain, receipt: TransactionReceipt) => toAtoms(chain, weiOf(receipt)).toString(),
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
        const current = await executed(p, await client.getBlockNumber({ cacheTime: 0 }))
        if (current === digest) return
        if (current !== ZERO) throw new Error('Operation already bound to other bytes')
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
        let worst = limit * fee.maxFeePerGas
        if (chains[p.chain].opStackL1Fee) {
          const data = encodeFunctionData({ abi: executorAbi, functionName: 'execute', args: args(p, digest) })
          worst += await client.readContract({ address: GAS_PRICE_ORACLE, abi: gasPriceOracleAbi, functionName: 'getL1FeeUpperBound', args: [BigInt((data.length - 2) / 2 + 68)] })
        }
        const cap = config.operatorGas?.[p.chain]
        if (cap !== undefined && spent(p.chain) + worst > BigInt(cap)) throw new LaunchError(409, 'gas_cap', `${p.chain} transfer gas would exceed the approved ${cap} wei. Nothing was sent.`)
        let tx: Hex | undefined
        for (let attempt = 0; attempt < 3 && !tx; attempt++) {
          try {
            tx = await wallets[p.chain].writeContract({ account, chain: chainOf(chains[p.chain]), address: p.executor, abi: executorAbi, functionName: 'execute', args: args(p, digest), value: BigInt(p.value), gas: limit, ...fee })
          } catch (cause) {
            // Another worker's execution landed between our simulation and our send: nothing to send.
            if (String(cause).includes(OPERATION_DONE) || await client.readContract({ address: p.executor, abi: executorAbi, functionName: 'digestOf', args: [p.operation], blockTag: 'pending' }) === digest) return
            if (attempt === 2 || !/nonce|underpriced|already known/i.test(String(cause))) throw cause
          }
        }
        db.query('INSERT OR IGNORE INTO evm_transfer_broadcasts(operation, chain, tx, sent_at) VALUES(?,?,?,?)').run(p.operation, p.chain, tx!, Date.now())
        const receipt = await client.waitForTransactionReceipt({ hash: tx!, timeout: config.receiptTimeoutMs ?? 120_000 })
        db.query('INSERT OR IGNORE INTO evm_transfer_spend(tx, chain, wei) VALUES(?,?,?)').run(tx!, p.chain, weiOf(receipt).toString())
        if (receipt.status !== 'success' && await executed(p, receipt.blockNumber) !== digest) throw new Error(`${p.operation} execution reverted in ${tx}`)
      }
      const next = sending[p.chain].then(run, run)
      sending[p.chain] = next.catch(() => undefined)
      await next
    },
  }
}
export type ExecutorSender = ReturnType<typeof executorSender>
