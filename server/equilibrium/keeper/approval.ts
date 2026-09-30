import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { KeeperError } from './types'

/**
 * Everything that decides what the keeper sends: the keeper bytecode manifest, its own contract, and
 * every off-chain file on the path from a quote to a broadcast.
 *
 * Deliberately disjoint from the launch adapter's manifest. The keeper is a separate authorization:
 * approving a launch never authorizes trading, and a keeper change must never silently invalidate or
 * re-validate an approved launch.
 *
 * The fork harness (`fork.ts`) and the fork rehearsal (`rehearse.ts`) are deliberately absent: they
 * cannot run against a public chain, so editing them must not invalidate a live approval.
 */
export const KEEPER_FILES = [
  'server/equilibrium/keeper/bytecode.json',
  'server/equilibrium/keeper/approval.ts', 'server/equilibrium/keeper/cli.ts', 'server/equilibrium/keeper/config.ts',
  'server/equilibrium/keeper/contracts.ts', 'server/equilibrium/keeper/fees.ts', 'server/equilibrium/keeper/keeper.ts', 'server/equilibrium/keeper/policy.ts',
  'server/equilibrium/keeper/preview.ts', 'server/equilibrium/keeper/quotes.ts', 'server/equilibrium/keeper/run.ts',
  'server/equilibrium/keeper/store.ts', 'server/equilibrium/keeper/types.ts',
  'contracts/equilibrium/EquilibriumKeeper.sol',
  'scripts/equilibrium-keeper-bytecode.ts',
] as const

export type Manifest = { file: string; sha256: string }[]
export function keeperManifest(root = '.'): Manifest {
  return KEEPER_FILES.map((file) => ({ file, sha256: createHash('sha256').update(readFileSync(join(root, file))).digest('hex') }))
}

/**
 * The keeper trading gate. One digest over the exact keeper preview, the exact keeper configuration
 * (vaults, pools, on-chain bounds and the off-chain policy) and the keeper code manifest. Approving
 * it authorizes that combination and nothing else.
 */
export function keeperApprovalDigest(preview: string, config: string, manifest: Manifest = keeperManifest()): string {
  return createHash('sha256').update('equilibrium-keeper-approval-v1\n').update(preview).update('\n--config--\n').update(config)
    .update('\n--code--\n').update(manifest.map((m) => `${m.sha256}  ${m.file}`).join('\n')).digest('hex')
}

export function assertKeeperApproved(
  mode: 'fork' | 'testnet', preview: string, config: string, approval: string | undefined, rpcs: string[], manifest: Manifest = keeperManifest(),
): void {
  if (mode === 'fork') {
    if (rpcs.some((rpc) => !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(rpc))) {
      throw new KeeperError('invalid_configuration', 'A fork keeper must point at local anvil forks only.')
    }
    return
  }
  const required = keeperApprovalDigest(preview, config, manifest)
  if (approval !== required) {
    throw new KeeperError('not_approved', `Refusing to trade in ${mode} mode without owner approval of this exact keeper preview, configuration and code.\nRequired EQUILIBRIUM_KEEPER_APPROVAL=${required}`)
  }
}
