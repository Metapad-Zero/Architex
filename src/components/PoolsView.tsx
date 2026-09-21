import { useCallback, useMemo, useState } from 'react'
import { useAccount } from 'wagmi'
import type { Address } from 'viem'
import { activeChain } from '../chain'
import { quote as ratioQuote, reservesFor, type AmmPair } from '../lib/amm'
import { useAllowances } from '../hooks/useAllowances'
import { useBalances } from '../hooks/useBalances'
import { usePairs } from '../hooks/usePairs'
import { usePositions } from '../hooks/usePositions'
import { useTokens } from '../hooks/useTokens'
import type { Token } from '../lib/tokens'
import { AddLiquidityForm } from './AddLiquidityForm'
import { FaucetPanel } from './FaucetPanel'
import { GhostButton } from './GhostButton'
import { PoolRow } from './PoolRow'
import { PositionRow } from './PositionRow'
import { TableSkeleton } from './Skeleton'

interface PoolsViewProps {
  selectedPair?: Address
  onSelectPair: (pair?: Address) => void
}

function tokenFor(tokens: readonly Token[], address: Address): Token | undefined {
  return tokens.find((token) => token.address.toLowerCase() === address.toLowerCase())
}

function reserveValueInUsdc(token: Token, amount: bigint, pairs: readonly AmmPair[]): bigint {
  if (token.address.toLowerCase() === activeChain.usdc.toLowerCase()) return amount
  const usdcPair = pairs.find(
    (pair) =>
      [pair.token0.toLowerCase(), pair.token1.toLowerCase()].includes(token.address.toLowerCase()) &&
      [pair.token0.toLowerCase(), pair.token1.toLowerCase()].includes(activeChain.usdc.toLowerCase()),
  )
  if (!usdcPair) return 0n
  const [reserveToken, reserveUsdc] = reservesFor(usdcPair, token.address)
  return ratioQuote(amount, reserveToken, reserveUsdc)
}

export function PoolsView({ selectedPair, onSelectPair }: PoolsViewProps) {
  const { address } = useAccount()
  const { pairs, heldBack, isLoading, refetch: refetchPairs } = usePairs()
  const { tokens } = useTokens(pairs)
  const { balances, refetch: refetchBalances } = useBalances(address, tokens)
  const { allowances, refetch: refetchAllowances } = useAllowances(address, tokens)
  const { positions, isLoading: positionsLoading, refetch: refetchPositions } = usePositions(address)
  const [creating, setCreating] = useState(false)

  const refresh = useCallback(async () => {
    await Promise.all([refetchPairs(), refetchBalances(), refetchAllowances(), refetchPositions()])
  }, [refetchAllowances, refetchBalances, refetchPairs, refetchPositions])

  const lpByPair = useMemo(() => new Map(positions.map((position) => [position.pair.toLowerCase(), position.lpBalance])), [positions])

  const rows = useMemo(
    () =>
      pairs
        .map((pair) => {
          const token0 = tokenFor(tokens, pair.token0)
          const token1 = tokenFor(tokens, pair.token1)
          if (!token0 || !token1) return undefined
          const tvl = reserveValueInUsdc(token0, pair.reserve0, pairs) + reserveValueInUsdc(token1, pair.reserve1, pairs)
          return { pair, token0, token1, tvl }
        })
        .filter((row): row is NonNullable<typeof row> => Boolean(row))
        .sort((a, b) => (a.tvl === b.tvl ? 0 : a.tvl > b.tvl ? -1 : 1)),
    [pairs, tokens],
  )

  return (
    <div className="pools-page">
      <div className="mb-10 flex items-end justify-between gap-4">
        <div><h1 className="text-xl font-semibold tracking-[-0.02em]">Pools</h1><p className="mt-2 max-w-xl text-sm text-g500">Add liquidity to earn the 0.30% fee paid by swaps through a pool.</p></div>
        <GhostButton className="shrink-0 whitespace-nowrap" onClick={() => setCreating((value) => !value)}>Create a pool</GhostButton>
      </div>

      {creating && (
        <section className="mb-14 border-t border-ink">
          <div className="section-heading-row"><h2>Create a pool</h2></div>
          <AddLiquidityForm pairs={pairs} heldBack={heldBack} tokens={tokens} balances={balances} allowances={allowances} onConfirmed={refresh} />
        </section>
      )}

      <section className="ruled-section">
        <div className="section-heading-row"><h2>All pools</h2><span>{rows.length} {rows.length === 1 ? 'pool' : 'pools'}</span></div>
        {isLoading ? (
          <TableSkeleton rows={5} />
        ) : rows.length === 0 ? (
          <div className="empty-state">
            <p>No pools yet. Add liquidity to create the first one.</p>
            {!creating && <GhostButton onClick={() => setCreating(true)}>Create a pool</GhostButton>}
          </div>
        ) : (
          <div className="table-wrap">
            <table className="pools-table">
              <thead><tr><th>Pool</th><th>TVL</th><th>Reserves</th></tr></thead>
              <tbody>
                {rows.map((row) => (
                  <PoolRow
                    key={row.pair.pair}
                    {...row}
                    expanded={selectedPair?.toLowerCase() === row.pair.pair.toLowerCase()}
                    balances={balances}
                    allowances={allowances}
                    lpBalance={lpByPair.get(row.pair.pair.toLowerCase())}
                    onToggle={() => onSelectPair(selectedPair?.toLowerCase() === row.pair.pair.toLowerCase() ? undefined : row.pair.pair)}
                    onConfirmed={refresh}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="ruled-section mt-16">
        <div className="section-heading-row"><h2>Your positions</h2></div>
        {!address ? (
          <div className="empty-state"><p>Connect your wallet to see your positions.</p></div>
        ) : positionsLoading ? (
          <TableSkeleton rows={2} />
        ) : positions.length === 0 ? (
          <div className="empty-state"><p>No positions yet. Add liquidity to a pool to start earning fees.</p></div>
        ) : (
          <div className="border-t border-ink">
            {positions.map((position) => {
              const token0 = tokenFor(tokens, position.token0)
              const token1 = tokenFor(tokens, position.token1)
              return token0 && token1 ? <PositionRow key={position.pair} position={position} token0={token0} token1={token1} onConfirmed={refresh} /> : null
            })}
          </div>
        )}
      </section>

      {activeChain.isTestnet && <FaucetPanel tokens={tokens} onConfirmed={refresh} />}
    </div>
  )
}
