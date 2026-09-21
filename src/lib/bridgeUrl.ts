import { FOREIGN_CHAINS, type BridgeSide, type ForeignChain } from './cctp'

export interface BridgeUrlState {
  side: BridgeSide
  foreign: ForeignChain
  amount?: string
}

function isForeign(value: string | null): value is ForeignChain {
  return (FOREIGN_CHAINS as readonly (string | null)[]).includes(value)
}

export function parseBridgeUrl(hash: string): BridgeUrlState {
  const query = hash.startsWith('#bridge') ? hash.slice('#bridge'.length) : hash
  const params = new URLSearchParams(query.startsWith('?') ? query.slice(1) : '')
  const from = params.get('from')
  const to = params.get('to')
  const amount = params.get('amount')?.trim() || undefined
  if (from === 'arc' && isForeign(to)) return { side: 'out', foreign: to, amount }
  if (isForeign(from)) return { side: 'in', foreign: from, amount }
  if (isForeign(to)) return { side: 'out', foreign: to, amount }
  return { side: 'in', foreign: 'ethereum', amount }
}

export function formatBridgeUrl(state: BridgeUrlState): string {
  const params = new URLSearchParams()
  if (state.side === 'in') {
    params.set('from', state.foreign)
    params.set('to', 'arc')
  } else {
    params.set('from', 'arc')
    params.set('to', state.foreign)
  }
  if (state.amount) params.set('amount', state.amount)
  return `#bridge?${params.toString()}`
}
