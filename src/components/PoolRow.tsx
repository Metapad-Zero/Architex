import type { AmmPair } from '../lib/amm'
import { formatAmount, formatUsd } from '../lib/format'
import type { Token } from '../lib/tokens'
import { ChevronIcon } from './Icons'
import { AddLiquidityForm } from './AddLiquidityForm'
import { PoolDetail } from './PoolDetail'

interface PoolRowProps {
  pair: AmmPair
  token0: Token
  token1: Token
  tvl: bigint
  expanded: boolean
  balances: ReadonlyMap<string, bigint>
  allowances: ReadonlyMap<string, bigint>
  lpBalance?: bigint
  onToggle: () => void
  onConfirmed: () => void | Promise<void>
}

export function PoolRow({ pair, token0, token1, tvl, expanded, balances, allowances, lpBalance, onToggle, onConfirmed }: PoolRowProps) {
  return (
    <>
      <tr className="pool-row" data-expanded={expanded}>
        <th scope="row">
          <button type="button" className="pool-toggle" onClick={onToggle} aria-expanded={expanded}>
            <span className="font-semibold">{token0.symbol} / {token1.symbol}</span>
            <ChevronIcon className={expanded ? 'rotate-180' : ''} />
          </button>
        </th>
        <td data-label="TVL">{formatUsd(tvl)}</td>
        <td data-label="Reserves"><span>{formatAmount(pair.reserve0, token0.decimals)} {token0.symbol}</span><span>{formatAmount(pair.reserve1, token1.decimals)} {token1.symbol}</span></td>
      </tr>
      {expanded && (
        <tr className="expanded-row">
          <td colSpan={3}>
            <div className="border-t border-ink pt-6">
              <PoolDetail pair={pair} token0={token0} token1={token1} lpBalance={lpBalance} />
              <h3 className="mb-6 text-lg font-semibold">Add liquidity</h3>
              <AddLiquidityForm pair={pair} tokenA={token0} tokenB={token1} tokens={[token0, token1]} balances={balances} allowances={allowances} onConfirmed={onConfirmed} />
            </div>
          </td>
        </tr>
      )}
    </>
  )
}
