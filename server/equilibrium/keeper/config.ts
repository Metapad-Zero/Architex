import type { Hex } from 'viem'
import { KeeperError, type KeeperChainConfig, type KeeperConfig, type KeeperMaintenancePolicy, type KeeperPolicy } from './types'

/** The on-disk form: no keys. The key comes from the environment of the process that signs. */
export interface KeeperChainFile extends Omit<KeeperChainConfig, 'quoteAtomsPerNative' | 'fromBlock' | 'priorityFeeWei'> {
  quoteAtomsPerNative: string
  fromBlock: string
  priorityFeeWei?: string
}
export interface KeeperFileConfig {
  mode: 'fork' | 'testnet'
  arc: KeeperChainFile
  base: KeeperChainFile
  policy: KeeperPolicy
  receiptTimeoutMs?: number
  maintenance?: KeeperMaintenancePolicy
}

const chainFrom = (c: KeeperChainFile): KeeperChainConfig => ({
  ...c, quoteAtomsPerNative: BigInt(c.quoteAtomsPerNative), fromBlock: BigInt(c.fromBlock),
  priorityFeeWei: c.priorityFeeWei === undefined ? undefined : BigInt(c.priorityFeeWei),
})
export const chainTo = (c: KeeperChainConfig): KeeperChainFile => ({
  ...c, quoteAtomsPerNative: c.quoteAtomsPerNative.toString(), fromBlock: c.fromBlock.toString(), priorityFeeWei: c.priorityFeeWei?.toString(),
})

/** Bounds that must hold for any configuration, before a single quote is read. */
export function assertPolicy(policy: KeeperPolicy): void {
  const positive: (keyof KeeperPolicy)[] = ['maxTokens', 'minEdge', 'spendCap', 'lossCap', 'recoveryReserve', 'recoveryCost', 'maxLegCost']
  for (const key of positive) {
    const value = policy[key]
    if (typeof value !== 'string' || !/^\d+$/.test(value) || BigInt(value) <= 0n) {
      throw new KeeperError('invalid_configuration', `policy.${key} must be a positive decimal atom string; received ${JSON.stringify(value)}.`)
    }
  }
  if (!/^\d+$/.test(policy.buffer)) throw new KeeperError('invalid_configuration', 'policy.buffer must be a decimal atom string.')
  for (const key of ['maxQuoteAgeSeconds', 'maxBlockLag', 'maxHeadAgeSeconds', 'legTtlSeconds', 'slippageBps', 'maxOpenCycles'] as const) {
    if (!Number.isSafeInteger(policy[key]) || policy[key] < 0) throw new KeeperError('invalid_configuration', `policy.${key} must be a non-negative whole number.`)
  }
  if (policy.maxOpenCycles < 1) throw new KeeperError('invalid_configuration', 'policy.maxOpenCycles must be at least 1.')
  if (policy.legTtlSeconds < 1) throw new KeeperError('invalid_configuration', 'policy.legTtlSeconds must be at least one second.')
  if (policy.slippageBps > 1_000) throw new KeeperError('invalid_configuration', 'policy.slippageBps above 1000 would let a leg execute 10% away from its quote.')
  if (BigInt(policy.spendCap) < BigInt(policy.recoveryReserve)) throw new KeeperError('invalid_configuration', 'policy.spendCap must cover policy.recoveryReserve.')
  // A keeper that could lose more than it may spend is not bounded in any useful sense.
  if (BigInt(policy.lossCap) > BigInt(policy.spendCap)) throw new KeeperError('invalid_configuration', 'policy.lossCap must not exceed policy.spendCap.')
  // A leg allowed to cost more than the reserve held for recovery could strand its own unwind.
  if (BigInt(policy.maxLegCost) > BigInt(policy.recoveryReserve)) throw new KeeperError('invalid_configuration', 'policy.maxLegCost must not exceed policy.recoveryReserve.')
}

export function fromFile(file: KeeperFileConfig, env: Record<string, string | undefined> = process.env): KeeperConfig {
  const operatorKey = env.EQUILIBRIUM_OPERATOR_KEY
  if (!operatorKey || !/^0x[0-9a-fA-F]{64}$/.test(operatorKey)) throw new KeeperError('invalid_configuration', 'EQUILIBRIUM_OPERATOR_KEY must hold the keeper vault owner key.')
  assertPolicy(file.policy)
  if (file.mode === 'fork') {
    for (const rpc of [file.arc.rpc, file.base.rpc]) {
      if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(rpc)) throw new KeeperError('invalid_configuration', 'A fork configuration must point at local anvil forks only.')
    }
  }
  const approval = env.EQUILIBRIUM_KEEPER_APPROVAL
  if (file.mode !== 'fork' && !approval) throw new KeeperError('not_approved', 'A testnet keeper requires EQUILIBRIUM_KEEPER_APPROVAL over the approved keeper preview.')
  return { mode: file.mode, operatorKey: operatorKey as Hex, arc: chainFrom(file.arc), base: chainFrom(file.base), policy: file.policy, receiptTimeoutMs: file.receiptTimeoutMs, approval: approval as Hex | undefined, maintenance: file.maintenance }
}

export function toFile(config: KeeperConfig): KeeperFileConfig {
  return { mode: config.mode, arc: chainTo(config.arc), base: chainTo(config.base), policy: config.policy, receiptTimeoutMs: config.receiptTimeoutMs, maintenance: config.maintenance }
}
