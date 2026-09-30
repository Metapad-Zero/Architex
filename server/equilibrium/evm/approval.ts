import { createHash } from 'node:crypto'

/**
 * The funded-deployment gate. Approval is a digest over the exact release preview and the exact
 * adapter configuration, so approving one preview cannot authorize a different config, and editing
 * either after approval invalidates it. Forks need no approval: they touch no public chain.
 */
export function approvalDigest(preview: string, config: string): string {
  return createHash('sha256').update('equilibrium-release-approval-v1\n').update(preview).update('\n--config--\n').update(config).digest('hex')
}

export function assertApproved(mode: 'fork' | 'testnet', preview: string, config: string, approval: string | undefined, rpcs: string[]) {
  if (mode === 'fork') {
    if (rpcs.some((rpc) => !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(rpc))) throw new Error('A fork configuration must point at local anvil forks only.')
    return
  }
  const required = approvalDigest(preview, config)
  if (approval !== required) {
    throw new Error(`Refusing to broadcast in ${mode} mode without owner approval of this exact preview and configuration.\nRequired EQUILIBRIUM_APPROVAL=${required}`)
  }
}
