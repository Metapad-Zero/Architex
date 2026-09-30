import type { Hex } from 'viem'
import type { Atoms, StepKind } from '../types'
import type { ChainConfig, EvmAdapterConfig, PilotScope } from './types'
import { localGuardian, wormholescan } from './vaa'

/** The on-disk form: no keys. Keys come from the environment of the process that signs. */
export interface ChainFile extends Omit<ChainConfig, 'usdcAtomsPerNative' | 'fromBlock' | 'priorityFeeWei'> { usdcAtomsPerNative: string; fromBlock: string; priorityFeeWei?: string }
export interface EvmFileConfig {
  mode: 'fork' | 'testnet'
  arc: ChainFile
  base: ChainFile
  vaa: { kind: 'local-guardian'; guardianSetIndex: number } | { kind: 'wormholescan'; api: string }
  limits: { outbound: string; inbound: string }
  budgets: Record<StepKind, Atoms>
  receiptTimeoutMs?: number
  scope?: PilotScope
}

const chainFrom = (c: ChainFile): ChainConfig => ({ ...c, usdcAtomsPerNative: BigInt(c.usdcAtomsPerNative), fromBlock: BigInt(c.fromBlock), priorityFeeWei: c.priorityFeeWei === undefined ? undefined : BigInt(c.priorityFeeWei) })
const chainTo = (c: ChainConfig): ChainFile => ({ ...c, usdcAtomsPerNative: c.usdcAtomsPerNative.toString(), fromBlock: c.fromBlock.toString(), priorityFeeWei: c.priorityFeeWei?.toString() })

export function fromFile(file: EvmFileConfig, env: Record<string, string | undefined> = process.env): EvmAdapterConfig {
  const operatorKey = env.EQUILIBRIUM_OPERATOR_KEY
  if (!operatorKey || !/^0x[0-9a-fA-F]{64}$/.test(operatorKey)) throw new Error('EQUILIBRIUM_OPERATOR_KEY must hold the executor owner key.')
  let vaa
  if (file.vaa.kind === 'local-guardian') {
    // A local guardian can only sign on a fork: the public Guardian set would reject it anyway.
    if (file.mode !== 'fork') throw new Error('A local guardian is fork-only.')
    const key = env.EQUILIBRIUM_FORK_GUARDIAN_KEY
    if (!key) throw new Error('EQUILIBRIUM_FORK_GUARDIAN_KEY is required for a fork guardian.')
    vaa = localGuardian(key as Hex, file.vaa.guardianSetIndex)
  } else vaa = wormholescan(file.vaa.api)
  // A public-chain configuration without a scope would authorize unbounded launches and gas.
  if (file.mode !== 'fork' && !file.scope) throw new Error('A testnet configuration must carry the approved pilot scope.')
  return { mode: file.mode, operatorKey: operatorKey as Hex, arc: chainFrom(file.arc), base: chainFrom(file.base), vaa,
    limits: { outbound: BigInt(file.limits.outbound), inbound: BigInt(file.limits.inbound) }, budgets: file.budgets, receiptTimeoutMs: file.receiptTimeoutMs, scope: file.scope }
}

export function toFile(config: EvmAdapterConfig, guardianSetIndex = 0): EvmFileConfig {
  return { mode: config.mode, arc: chainTo(config.arc), base: chainTo(config.base),
    vaa: config.vaa.kind === 'local-guardian' ? { kind: 'local-guardian', guardianSetIndex } : { kind: 'wormholescan', api: 'https://api.testnet.wormholescan.io' },
    limits: { outbound: config.limits.outbound.toString(), inbound: config.limits.inbound.toString() }, budgets: config.budgets, receiptTimeoutMs: config.receiptTimeoutMs, scope: config.scope }
}
