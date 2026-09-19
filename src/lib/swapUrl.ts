/**
 * Shareable swap state in the hash: `#swap?in=WBTC&out=WETH&amount=0.01`.
 * Tokens are matched by symbol (case-insensitive) or address; anything unknown is ignored.
 */
export interface SwapUrlState {
  in?: string
  out?: string
  amount?: string
  mode?: 'exactIn' | 'exactOut'
}

export function parseSwapUrl(hash: string): SwapUrlState {
  const query = hash.split('?')[1]
  if (!query) return {}
  const params = new URLSearchParams(query)
  const state: SwapUrlState = {}
  const tokenIn = params.get('in')
  const tokenOut = params.get('out')
  const amount = params.get('amount')
  const mode = params.get('mode')
  if (tokenIn) state.in = tokenIn
  if (tokenOut) state.out = tokenOut
  if (amount && /^\d*(?:\.\d*)?$/.test(amount)) state.amount = amount
  if (mode === 'exactOut') state.mode = 'exactOut'
  return state
}

export function formatSwapUrl(state: SwapUrlState): string {
  const params = new URLSearchParams()
  if (state.in) params.set('in', state.in)
  if (state.out) params.set('out', state.out)
  if (state.amount) params.set('amount', state.amount)
  if (state.mode === 'exactOut') params.set('mode', 'exactOut')
  const query = params.toString()
  return query ? `#swap?${query}` : '#swap'
}

const LAST_PAIR_KEY = 'architex.lastPair'

export function readLastPair(): { in?: string; out?: string } {
  try {
    const raw = localStorage.getItem(LAST_PAIR_KEY)
    return raw ? (JSON.parse(raw) as { in?: string; out?: string }) : {}
  } catch {
    return {}
  }
}

export function writeLastPair(pair: { in?: string; out?: string }): void {
  try {
    localStorage.setItem(LAST_PAIR_KEY, JSON.stringify(pair))
  } catch {
    // ignore
  }
}
