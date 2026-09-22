import { useMemo, useState } from 'react'
import { useConnectSheet } from '../hooks/useConnectSheet'
import type { LaunchAllowances } from '../hooks/useLaunch'
import { useLaunchTrade, type LaunchSide } from '../hooks/useLaunchTrade'
import { useSettings } from '../hooks/useSettings'
import { GHOST, formatAmount, formatPct, parseAmount } from '../lib/format'
import type { LaunchRecord } from '../lib/launch'
import { destinationLabel, feeDestination } from '../lib/plugins/destination'
import type { Token } from '../lib/tokens'
import { AmountField } from './AmountField'
import { FeeGauge } from './FeeGauge'
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
  usdcAllowance: LaunchAllowances
  initialSide?: LaunchSide
  onConfirmed: () => void | Promise<void>
}

export function LaunchTradeSheet({
  launch,
  token,
  usdc,
  tokenBalance,
  usdcBalance,
  usdcAllowance,
  initialSide = 'buy',
  onConfirmed,
}: LaunchTradeSheetProps) {
  const { open } = useConnectSheet()
  const switchToArc = useSwitchToArc()
  const settings = useSettings()
  const [side, setSide] = useState<LaunchSide>(initialSide)
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
    deadlineMinutes: settings.deadlineMinutes,
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

  const quote = trade.quote
  const pool = trade.venue === 'pool'
  const destination = feeDestination(launch)
  const receiveAmount = quote ? formatAmount(quote.amountOut, receiveToken.decimals) : ''
  const impact = quote
    ? `${formatPct(quote.priceImpactBps)}${quote.priceImpactBps > 500n ? ' · High price impact' : ''}`
    : GHOST
  const impactShort = quote
    ? `${formatPct(quote.priceImpactBps)}${quote.priceImpactBps > 500n ? ' · High impact' : ''}`
    : GHOST
  const bound = quote ? `${formatAmount(quote.minReceived, receiveToken.decimals)} ${receiveToken.symbol}` : GHOST
  // Always quoted the same way round (tokens per 1 USDC), fees included, so buys and sells compare at a glance.
  const rate = quote && quote.amountIn > 0n && quote.amountOut > 0n
    ? `1 USDC = ${formatAmount(
        side === 'buy' ? (quote.amountOut * 1_000_000n) / quote.amountIn : (quote.amountIn * 1_000_000n) / quote.amountOut,
        18,
      )} ${launch.symbol}`
    : GHOST
  const platformFee = quote ? `0.50% · ${formatAmount(quote.platformFee, usdc.decimals)} USDC` : '0.50%'
  const creatorFee = `${formatPct(launch.creatorFeeBps)}${quote ? ` · ${formatAmount(quote.creatorFee, usdc.decimals)} USDC` : ''}`
  const sellsOut = quote?.graduates && quote.amountIn < quote.offer

  return (
    <div className="swap-sheet">
      {trade.isLoading && <span className="rule-sweep" aria-hidden="true" />}
      <div className="sheet-tools">
        {/* Curve and launch-pool trades both take the deadline and the slippage set here. */}
        <SettingsPopover
          slippageBps={settings.slippageBps}
          onSlippage={settings.setSlippageBps}
          deadlineMinutes={settings.deadlineMinutes}
          onDeadline={settings.setDeadlineMinutes}
        />
      </div>
      <p className="trade-venue">
        {pool ? 'Trading in the launch pool' : 'Trading on the curve'}
        <span aria-hidden="true"> · </span>
        <span className="text-g500">fees to {destinationLabel(destination)}</span>
      </p>
      <div className="grid grid-cols-2 gap-2 pb-4 pt-3">
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
      <dl className="receipt-lines" data-live={Boolean(quote)}>
        <div>
          <dt>Rate</dt>
          <dd className={quote ? '' : 'text-g500'}>{rate}</dd>
        </div>
        <div>
          <dt>Price impact</dt>
          <dd className={quote && quote.priceImpactBps > 500n ? 'text-loss' : quote ? '' : 'text-g500'}>
            <span className="hidden sm:inline">{impact}</span>
            <span className="sm:hidden">{impactShort}</span>
          </dd>
        </div>
        <div><dt>Platform fee</dt><dd>{platformFee}</dd></div>
        <div>
          <dt>Creator fee</dt>
          <dd>
            <span className="inline-flex items-center gap-2">
              <FeeGauge bps={launch.creatorFeeBps} showValue={false} decorative />
              {creatorFee}
            </span>
          </dd>
        </div>
        <div>
          <dt>Minimum received</dt>
          <dd className={quote ? '' : 'text-g500'}>{bound}</dd>
        </div>
      </dl>
      {sellsOut && quote && (
        <p className="quote-message" role="status">
          This buy sells out the curve and graduates {launch.symbol}. It spends {formatAmount(quote.amountIn, usdc.decimals)} of the {formatAmount(quote.offer, usdc.decimals)} USDC offered.
        </p>
      )}
      <PrimaryButton className="mt-6 w-full" loading={trade.isLoading} disabled={trade.isDisabled} onClick={() => void handlePrimary()}>
        {trade.label}
      </PrimaryButton>
      {trade.hint && <p className="hint-line" role="status">{trade.hint}</p>}
      <TxStatus status={trade.txStatus} />
    </div>
  )
}
