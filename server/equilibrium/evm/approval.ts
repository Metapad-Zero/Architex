import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Everything that decides what a launch sends: the deployed bytecode bundle and every off-chain
 * file on the path from HTTP request to broadcast. Changing any of them invalidates an approval.
 */
export const CODE_FILES = [
  'server/equilibrium/evm/bytecode.json',
  'server/equilibrium/evm/adapter.ts', 'server/equilibrium/evm/approval.ts', 'server/equilibrium/evm/config.ts', 'server/equilibrium/evm/contracts.ts',
  'server/equilibrium/evm/serve.ts', 'server/equilibrium/evm/types.ts', 'server/equilibrium/evm/v3.ts', 'server/equilibrium/evm/vaa.ts',
  'server/equilibrium/payment.ts', 'server/equilibrium/request.ts', 'server/equilibrium/runner.ts', 'server/equilibrium/service.ts',
  'server/equilibrium/store.ts', 'server/equilibrium/types.ts',
  'contracts/equilibrium/EquilibriumExecutor.sol', 'contracts/equilibrium/EquilibriumToken.sol',
  'scripts/equilibrium-infra.ts',
] as const

export type Manifest = { file: string; sha256: string }[]
export function codeManifest(root = '.'): Manifest {
  return CODE_FILES.map((file) => ({ file, sha256: createHash('sha256').update(readFileSync(join(root, file))).digest('hex') }))
}

/**
 * The funded-deployment gate. One digest over the exact release preview, the exact adapter
 * configuration (chains, executors, limits, budgets and the pilot scope: launch count, payer,
 * recipient, allocation, total and gas caps) and the code manifest. Approving it authorizes that
 * combination and nothing else; editing any part afterwards invalidates it. Forks need no approval.
 */
export function approvalDigest(preview: string, config: string, manifest: Manifest = codeManifest()): string {
  return createHash('sha256').update('equilibrium-release-approval-v2\n').update(preview).update('\n--config--\n').update(config)
    .update('\n--code--\n').update(manifest.map((m) => `${m.sha256}  ${m.file}`).join('\n')).digest('hex')
}

export function assertApproved(mode: 'fork' | 'testnet', preview: string, config: string, approval: string | undefined, rpcs: string[], manifest: Manifest = codeManifest()) {
  if (mode === 'fork') {
    if (rpcs.some((rpc) => !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(rpc))) throw new Error('A fork configuration must point at local anvil forks only.')
    return
  }
  const required = approvalDigest(preview, config, manifest)
  if (approval !== required) {
    throw new Error(`Refusing to broadcast in ${mode} mode without owner approval of this exact preview, configuration and code.\nRequired EQUILIBRIUM_APPROVAL=${required}`)
  }
}
