import { useMemo, useState } from 'react'
import { activeChain } from '../chain'
import { useConnectSheet } from '../hooks/useConnectSheet'
import { useLaunchTrade, type LaunchSide } from '../hooks/useLaunchTrade'
import { useSettings } from '../hooks/useSettings'
import { formatAmount, formatPct, parseAmount } from '../lib/format'
import { formatSwapUrl } from '../lib/swapUrl'
import type { LaunchRecord } from '../lib/launch'
import type { Token } from '../lib/tokens'
import { AmountField } from './AmountField'
import { GhostButton } from './GhostButton'
import { PrimaryButton } from './PrimaryButton'
import { SettingsPopover } from './SettingsPopover'
import { TxStatus } from './TxStatus'
import { useSwitchToArc } from '../hooks/useSwitchToArc'

interface LaunchTradeSheetProps {
  launch: LaunchRecord
  token: Token
  usdc: Token
  tokenBalance: bigint
  usdcBalance: bigint
  usdcAllowance: bigint
  onConfirmed: () => void | Promise<void>
}

const GHOST = '—'

export function LaunchTradeSheet({
  launch,
  token,
  usdc,
  tokenBalance,
  usdcBalance,
  usdcAllowance,
  onConfirmed,
}: LaunchTradeSheetProps) {
  const { open } = useConnectSheet()
  const switchToArc = useSwitchToArc()
  const settings = useSettings()
  const [side, setSide] = useState<LaunchSide>('buy')
  const [amount, setAmount] = useState('')

  const payToken = side === 'buy' ? usdc : token
  const receiveToken = side === 'buy' ? token : usdc
  const parsedIn = useMemo(() => {
    try {
      return amount ? parseAmount(amount, payToken.decimals) : 0n
    } catch {
      return 0n
    }
  }, [amount, payToken.decimals])

  const balances = useMemo(() => {
    const map = new Map<string, bigint>()
    map.set(token.address.toLowerCase(), tokenBalance)
    map.set(usdc.address.toLowerCase(), usdcBalance)
    return map
  }, [token.address, tokenBalance, usdc.address, usdcBalance])

  const trade = useLaunchTrade({
    launch,
    token,
    usdc,
    side,
    parsedIn,
    slippageBps: settings.slippageBps,
    tokenBalance,
    usdcBalance,
    usdcAllowance,
    onConfirmed,
    onClear: () => setAmount(''),
  })

  const handlePrimary = async () => {
    if (trade.buttonState === 'disconnected') {
      open()
      return
    }
    if (trade.buttonState === 'wrongChain') {
      await switchToArc()
      return
    }
    await trade.execute()
  }

  if (launch.graduated) {
    return (
      <div className="swap-sheet">
        <p className="py-7 text-sm leading-6 text-g700">
          This curve sold out. Its liquidity is locked in an Architex pool for good, and every swap leaves its fee there. Anyone can add more and earn a share of those fees.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <GhostButton className="w-full" onClick={() => { window.location.hash = formatSwapUrl({ in: 'USDC', out: launch.token }) }}>
            Trade on Swap
          </GhostButton>
          <GhostButton className="w-full" onClick={() => { window.location.hash = `#pools/${launch.pair}` }}>
            Add liquidity
          </GhostButton>
        </div>
      </div>
    )
  }

  const receiveAmount = trade.quote ? formatAmount(trade.quote.amountOut, receiveToken.decimals) : ''
  const impact = trade.quote
    ? `${formatPct(trade.quote.priceImpactBps)}${trade.quote.priceImpactBps > 500n ? ' · High price impact' : ''}`
    : GHOST
  const impactShort = trade.quote
    ? `${formatPct(trade.quote.priceImpactBps)}${trade.quote.priceImpactBps > 500n ? ' · High impact' : ''}`
    : GHOST
  const bound = trade.quote ? `${formatAmount(trade.quote.minReceived, receiveToken.decimals)} ${receiveToken.symbol}` : GHOST
  // Always quoted the same way round (tokens per 1 USDC), fee included, so buys and sells compare at a glance.
  const rate = trade.quote && trade.quote.amountIn > 0n && trade.quote.amountOut > 0n
    ? `1 USDC = ${formatAmount(
        payToken.address === usdc.address
          ? (trade.quote.amountOut * 1_000_000n) / trade.quote.amountIn
          : (trade.quote.amountIn * 1_000_000n) / trade.quote.amountOut,
        18,
      )} ${launch.symbol}`
    : GHOST

  return (
    <div className="swap-sheet">
      {trade.isLoading && <span className="rule-sweep" aria-hidden="true" />}
      <div className="sheet-tools">
        <SettingsPopover
          slippageBps={settings.slippageBps}
          deadlineMinutes={settings.deadlineMinutes}
          onSlippage={settings.setSlippageBps}
          onDeadline={settings.setDeadlineMinutes}
        />
      </div>
      <div className="grid grid-cols-2 gap-2 pb-4 pt-6">
        {(['buy', 'sell'] as const).map((value) => (
          <button
            key={value}
            type="button"
            className="choice-button"
            data-active={side === value}
            aria-pressed={side === value}
            onClick={() => {
              setSide(value)
              setAmount('')
            }}
          >
            {value === 'buy' ? 'Buy' : 'Sell'}
          </button>
        ))}
      </div>
      <AmountField
        id="launch-pay"
        label="You pay"
        amount={amount}
        onAmount={setAmount}
        token={payToken}
        tokens={[payToken]}
        onToken={() => undefined}
        balances={balances}
        disableTokenSelect
        onSubmit={() => { if (!trade.isDisabled && !trade.isLoading) void handlePrimary() }}
      />
      <AmountField
        id="launch-receive"
        label="You receive"
        amount={receiveAmount}
        onAmount={() => undefined}
        token={receiveToken}
        tokens={[receiveToken]}
        onToken={() => undefined}
        balances={balances}
        readOnly
        checkBalance={false}
        disableTokenSelect
      />
      <dl className="receipt-lines" data-live={Boolean(trade.quote)}>
        <div>
          <dt>Rate</dt>
          <dd className={trade.quote ? '' : 'text-g500'}>{rate}</dd>
        </div>
        <div>
          <dt>Price impact</dt>
          <dd className={trade.quote && trade.quote.priceImpactBps > 500n ? 'text-loss' : trade.quote ? '' : 'text-g500'}>
            <span className="hidden sm:inline">{impact}</span>
            <span className="sm:hidden">{impactShort}</span>
          </dd>
        </div>
        <div><dt>Fee</dt><dd>0.50%</dd></div>
        <div>
          <dt>Minimum received</dt>
          <dd className={trade.quote ? '' : 'text-g500'}>{bound}</dd>
        </div>
      </dl>
      <PrimaryButton className="mt-6 w-full" loading={trade.isLoading} disabled={trade.isDisabled} onClick={() => void handlePrimary()}>
        {trade.label}
      </PrimaryButton>
      {trade.hint && <p className="hint-line" role="status">{trade.hint}</p>}
      <TxStatus status={trade.txStatus} />
    </div>
  )
}
