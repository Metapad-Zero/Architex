import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Hex } from 'viem'
import type { Job } from '../../types'
import type { EvmAdapterConfig } from '../types'
import { executorSender } from './executor'
import { returnRoute, type ReturnConfig } from './returns'

/** Transfer settings, kept apart from the launch configuration so the launch approval stays untouched. */
export interface TransferSettings {
  returns: ReturnConfig
  /** Cumulative operator gas for transfers, native wei per chain. Required outside forks. */
  operatorGas?: { arc: string; base: string }
}

export function transferRoutes(adapter: EvmAdapterConfig, settings: TransferSettings, db: Database, launchOf: (id: Hex) => Job | undefined) {
  if (adapter.mode !== 'fork' && !settings.operatorGas) throw new Error('A testnet transfer configuration must carry approved operator gas caps.')
  const sender = executorSender({ operatorKey: adapter.operatorKey, arc: adapter.arc, base: adapter.base, receiptTimeoutMs: adapter.receiptTimeoutMs, operatorGas: settings.operatorGas }, db)
  return { sender, returns: returnRoute(adapter, settings.returns, sender, db, launchOf) }
}

/** Every file on the transfer path. Changing any of them invalidates a transfer approval. */
export const TRANSFER_FILES = [
  'server/equilibrium/evm/transfers/config.ts', 'server/equilibrium/evm/transfers/executor.ts', 'server/equilibrium/evm/transfers/ntt.ts',
  'server/equilibrium/evm/transfers/returns.ts', 'server/equilibrium/evm/transfers/runner.ts', 'server/equilibrium/evm/transfers/store.ts',
  'server/equilibrium/evm/transfers/types.ts', 'server/equilibrium/evm/adapter.ts', 'server/equilibrium/evm/contracts.ts', 'server/equilibrium/evm/vaa.ts',
  'server/equilibrium/evm/bytecode.json', 'contracts/equilibrium/EquilibriumExecutor.sol',
] as const

/**
 * The transfer gate: one digest over the exact launch configuration, the transfer settings and the
 * transfer code. It is separate from the launch approval, which authorizes one launch and nothing else.
 */
export function transferApprovalDigest(adapterConfig: string, settings: string, root = '.'): string {
  const h = createHash('sha256').update('equilibrium-transfer-approval-v1\n').update(adapterConfig).update('\n--settings--\n').update(settings).update('\n--code--\n')
  for (const file of TRANSFER_FILES) h.update(`${createHash('sha256').update(readFileSync(`${root}/${file}`)).digest('hex')}  ${file}\n`)
  return h.digest('hex')
}
export function assertTransfersApproved(mode: 'fork' | 'testnet', adapterConfig: string, settings: string, approval: string | undefined, rpcs: string[]) {
  if (mode === 'fork') {
    if (rpcs.some((rpc) => !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(rpc))) throw new Error('A fork configuration must point at local anvil forks only.')
    return
  }
  const required = transferApprovalDigest(adapterConfig, settings)
  if (approval !== required) throw new Error(`Refusing to send transfers in ${mode} mode without owner approval of this exact configuration and code.\nRequired EQUILIBRIUM_TRANSFER_APPROVAL=${required}`)
}
