import { useMemo, useState } from 'react'
import { formatUnits } from 'viem'
import { useAccount } from 'wagmi'
import { useConnectSheet } from '../hooks/useConnectSheet'
import { activeChain } from '../chain'
import { removeAmounts } from '../lib/amm'
import { formatAmount, formatLp, formatPct, parseAmount } from '../lib/format'
import type { Token } from '../lib/tokens'
import type { PositionInfo } from '../hooks/usePositions'
import { useLiquidity } from '../hooks/useLiquidity'
import { useSettings } from '../hooks/useSettings'
import { ChevronIcon } from './Icons'
import { PrimaryButton } from './PrimaryButton'
import { TxStatus } from './TxStatus'
import { useSwitchToArc } from '../hooks/useSwitchToArc'

function editable(value: bigint): string {
  return formatUnits(value, 18).replace(/0+$/, '').replace(/\.$/, '')
}

interface PositionRowProps {
  position: PositionInfo
  token0: Token
  token1: Token
  onConfirmed: () => void | Promise<void>
}

export function PositionRow({ position, token0, token1, onConfirmed }: PositionRowProps) {
  const { address, chainId } = useAccount()
  const { open } = useConnectSheet()
  const switchToArc = useSwitchToArc()
  const settings = useSettings()
  const liquidity = useLiquidity(onConfirmed)
  const [expanded, setExpanded] = useState(false)
  const [lpAmount, setLpAmount] = useState('')
  const rawLiquidity = useMemo(() => {
    try { return parseAmount(lpAmount, 18) } catch { return 0n }
  }, [lpAmount])
  const [amount0, amount1] = removeAmounts(rawLiquidity, position.reserve0, position.reserve1, position.lpTotalSupply)
  const [pooled0, pooled1] = removeAmounts(position.lpBalance, position.reserve0, position.reserve1, position.lpTotalSupply)
  const shareBps = position.lpTotalSupply > 0n ? (position.lpBalance * 10_000n) / position.lpTotalSupply : 0n
  const pending = liquidity.status?.kind === 'pending'
  const buttonLabel = !address
    ? 'Connect wallet'
    : chainId !== activeChain.id
      ? activeChain.isTestnet ? 'Switch to Arc Testnet' : 'Switch to Arc'
      : 'Remove liquidity'

  const remove = async () => {
    if (!address) return open()
    if (chainId !== activeChain.id) return void switchToArc()
    if (rawLiquidity <= 0n || rawLiquidity > position.lpBalance) return
    await liquidity.removeLiquidity({
      pair: position.pair,
      tokenA: token0.address,
      tokenB: token1.address,
      liquidity: rawLiquidity,
      amountA: amount0,
      amountB: amount1,
      routerAllowance: position.routerAllowance,
      slippageBps: settings.slippageBps,
      deadlineMinutes: settings.deadlineMinutes,
    })
    setLpAmount('')
  }

  return (
    <article className="position-row">
      <button type="button" className="position-summary" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        <span><strong>{token0.symbol} / {token1.symbol}</strong><small>{formatLp(position.lpBalance)} LP</small></span>
        <span><small>Pooled amounts</small>{formatAmount(pooled0, token0.decimals)} {token0.symbol} · {formatAmount(pooled1, token1.decimals)} {token1.symbol}</span>
        <span><small>Your share</small>{formatPct(shareBps)}</span>
        <ChevronIcon className={expanded ? 'rotate-180' : ''} />
      </button>
      {expanded && (
        <div className="inline-form border-t border-ink">
          {pending && <span className="rule-sweep" aria-hidden="true" />}
          <h3 className="mb-5 text-lg font-semibold">Remove liquidity</h3>
          <div className="mb-3 grid grid-cols-4 gap-2">
            {[25, 50, 75, 100].map((percent) => (
              <button
                type="button"
                className="choice-button"
                key={percent}
                data-active={rawLiquidity === (position.lpBalance * BigInt(percent)) / 100n}
                onClick={() => setLpAmount(editable((position.lpBalance * BigInt(percent)) / 100n))}
              >
                {percent}%
              </button>
            ))}
          </div>
          <label className="block text-sm text-g500" htmlFor={`lp-${position.pair}`}>LP amount</label>
          <div className="field-with-suffix mt-2">
            <input id={`lp-${position.pair}`} inputMode="decimal" value={lpAmount} onChange={(event) => {
              if (/^\d*(?:\.\d{0,18})?$/.test(event.target.value)) setLpAmount(event.target.value)
            }} placeholder="0" />
            <span>LP</span>
          </div>
          {rawLiquidity > position.lpBalance && <p className="mt-2 text-sm text-loss">Not enough LP tokens</p>}
          <dl className="receipt-lines mt-5">
            <div><dt>You receive</dt><dd>{formatAmount(amount0, token0.decimals)} {token0.symbol}</dd></div>
            <div><dt>You receive</dt><dd>{formatAmount(amount1, token1.decimals)} {token1.symbol}</dd></div>
          </dl>
          <PrimaryButton className="mt-6 w-full sm:w-auto sm:min-w-56" loading={pending} disabled={pending || (Boolean(address) && chainId === activeChain.id && (rawLiquidity <= 0n || rawLiquidity > position.lpBalance))} onClick={() => void remove()}>
            {pending ? liquidity.status?.label : buttonLabel}
          </PrimaryButton>
          <TxStatus status={liquidity.status} />
        </div>
      )}
    </article>
  )
}
