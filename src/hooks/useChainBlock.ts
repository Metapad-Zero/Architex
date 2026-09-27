import { useEffect, useState } from 'react'
import { useBlockNumber } from 'wagmi'
import { activeChain } from '../chain'
import { launchFixtureApi } from '../lib/launchFixtureApi'

const fixtureOn = import.meta.env.DEV && import.meta.env.VITE_LAUNCHPAD_FIXTURE === '1'

/** While an anti-sniping window is open its fee falls every block (about two a second): read the block every second. */
const OPEN_WINDOW_POLL_MS = 1_000

/**
 * The chain's latest block, for v1.4's anti-sniping fee (lib/launchV14.ts snipeBps): read once when `enabled`, then
 * every second for as long as it is below `windowEnd` (the first block without the fee), and not again after. A quote
 * made at this block is the one the chain would give now; a buy lands a block or more later, when the fee is lower.
 */
export function useChainBlock(enabled: boolean, windowEnd: bigint | undefined): bigint | undefined {
  const query = useBlockNumber({
    chainId: activeChain.id,
    query: {
      enabled: enabled && !fixtureOn,
      staleTime: OPEN_WINDOW_POLL_MS,
      refetchInterval: (current) => {
        const block = current.state.data
        return windowEnd !== undefined && (block === undefined || block < windowEnd) ? OPEN_WINDOW_POLL_MS : false
      },
    },
  })
  const fixtureBlock = useFixtureBlock(enabled && fixtureOn, windowEnd)
  return fixtureOn ? fixtureBlock : query.data
}

/** The dev fixture's simulated block, ticking the same way. */
function useFixtureBlock(enabled: boolean, windowEnd: bigint | undefined): bigint | undefined {
  const [block, setBlock] = useState<bigint | undefined>(() => (enabled ? launchFixtureApi()?.blockNumber() : undefined))
  const live = enabled && (windowEnd === undefined ? block === undefined : block === undefined || block < windowEnd)
  useEffect(() => {
    if (!enabled) return
    const read = () => setBlock(launchFixtureApi()?.blockNumber())
    const first = window.setTimeout(read, 0)
    if (!live) return () => window.clearTimeout(first)
    const timer = window.setInterval(read, OPEN_WINDOW_POLL_MS)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(timer)
    }
  }, [enabled, live])
  return enabled ? block : undefined
}
