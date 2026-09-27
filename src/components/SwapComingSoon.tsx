import type { AmmPair } from '../lib/amm'
import { GHOST } from '../lib/format'
import { isLaunchViewAvailable, isV14Available } from '../lib/deployment'
import { SWAP_OPENING_GOAL_USD, goalBps, wholeUsd } from '../lib/swapOpening'
import { navigate } from '../hooks/useHashRoute'
import { GhostButton } from './GhostButton'

/**
 * Where a launch goes once its curve fills, in the owner's words (2026-09-27). It is shown only once v1.4 is live:
 * v1.3's launches graduate into Architex's own launch pools, so before then the sentence would not be true.
 */
export const UNISWAP_NOTE =
  'Today, launches graduate immutably to Uniswap. Architex aims for independence in the coming weeks with a fully audited v2 update.'

/** A pool's liquidity against the $50,000 its swaps open at: the launch meter's bar, run the width of the sheet. */
export function PoolGoal({ label, liquidityUsd }: { label: string; liquidityUsd: bigint | undefined }) {
  const bps = liquidityUsd === undefined ? 0 : goalBps(liquidityUsd)
  const figure = liquidityUsd === undefined ? GHOST : `${wholeUsd(liquidityUsd)} of ${wholeUsd(SWAP_OPENING_GOAL_USD)}`
  return (
    <div className="pool-goal">
      <div className="pool-goal-head">
        <span>{label}</span>
        <span className="tabular-nums">{figure}</span>
      </div>
      <div
        role="meter"
        className="launch-meter w-full"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={bps / 100}
        aria-valuetext={liquidityUsd === undefined ? 'Loading' : figure}
      >
        <span style={{ width: `${bps / 100}%` }} />
      </div>
    </div>
  )
}

interface SwapComingSoonProps {
  /** The pool whose liquidity decides it, once the pools have loaded. */
  pool: AmmPair | undefined
  /** "USDC / EURC". */
  pairLabel: string
  liquidityUsd: bigint | undefined
}

/** In place of the swap sheet while a pair's pool is under the goal: the goal, its bar, and where to trade now. */
export function SwapComingSoon({ pool, pairLabel, liquidityUsd }: SwapComingSoonProps) {
  return (
    <section className="coming-soon" aria-labelledby="coming-soon-title">
      <span className="coming-soon-chip">Coming soon</span>
      <h2 id="coming-soon-title">Swaps open when the pool holds {wholeUsd(SWAP_OPENING_GOAL_USD)}</h2>
      <PoolGoal label={`${pairLabel} pool`} liquidityUsd={liquidityUsd} />
      {isV14Available && <p>{UNISWAP_NOTE}</p>}
      {isLaunchViewAvailable && <p>Launched tokens trade now, each on its own page.</p>}
      <div className="coming-soon-actions">
        {isLaunchViewAvailable && <GhostButton onClick={() => navigate({ view: 'launch' })}>Trade launched tokens</GhostButton>}
        {pool && <GhostButton onClick={() => navigate({ view: 'pools', pair: pool.pair })}>Add liquidity</GhostButton>}
      </div>
    </section>
  )
}
