import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react'
import type { Address } from 'viem'
import { useAccount } from 'wagmi'
import { useConnectSheet } from '../hooks/useConnectSheet'
import { activeChain } from '../chain'
import { quote as ratioQuote, reservesFor, type QuoteMode } from '../lib/amm'
import { isDeployed, isLaunchViewAvailable } from '../lib/deployment'
import { formatAmount, formatPct, formatUsd, parseAmount } from '../lib/format'
import {
  impactSizeHint,
  isHighImpact,
  maxRouteInput,
  swapImpactLossUsd,
  swapImpactLossUsdFromOutput,
} from '../lib/impactGuard'
import { useRecent } from '../lib/recent'
import { findTokenByRef, formatSwapUrl, parseSwapUrl, readLastPair, tokenRef, writeLastPair } from '../lib/swapUrl'
import type { Token } from '../lib/tokens'
import { useAllowances } from '../hooks/useAllowances'
import { useBalances } from '../hooks/useBalances'
import { usePairs } from '../hooks/usePairs'
import { useQuote } from '../hooks/useQuote'
import { useSettings } from '../hooks/useSettings'
import { useSwap } from '../hooks/useSwap'
import { useTokens } from '../hooks/useTokens'
import { AmountField } from './AmountField'
import { FlipIcon } from './Icons'
import { ImpactGuard } from './ImpactGuard'
import { PrimaryButton } from './PrimaryButton'
import { ReceiptLines } from './ReceiptLines'
import { RecentLedger } from './RecentLedger'
import { SettingsPopover } from './SettingsPopover'
import type { PickerExtra } from './TokenSelect'
import { TxStatus } from './TxStatus'
import { useSwitchToArc } from '../hooks/useSwitchToArc'

// Below the sheet and not needed to swap: kept out of the first chunk.
const SwapPriceChart = lazy(() => import('./SwapPriceChart'))
// Launch tokens in the picker: loaded the first time a picker opens, and only where the launchpad is live.
const LaunchPickerGroup = lazy(() => import('./LaunchPickerGroup'))

/** Graduated launch tokens under the picker's tokens, each opening its own trade sheet on `side` [D12]. */
function launchTokensIn(side: 'buy' | 'sell'): PickerExtra | undefined {
  if (!isLaunchViewAvailable) return undefined
  return ({ query }) => (
    <Suspense fallback={null}>
      <LaunchPickerGroup query={query} side={side} />
    </Suspense>
  )
}
const PAY_SIDE_LAUNCHES = launchTokensIn('sell')
const RECEIVE_SIDE_LAUNCHES = launchTokensIn('buy')

function findToken(tokens: readonly Token[], address: Address | undefined): Token | undefined {
  return tokens.find((token) => token.address.toLowerCase() === address?.toLowerCase())
}

export function SwapSheet() {
  const { address: account } = useAccount()
  const { open } = useConnectSheet()
  const switchToArc = useSwitchToArc()
  const { pairs, refetch: refetchPairs } = usePairs()
  const { tokens } = useTokens(pairs)
  const { balances, refetch: refetchBalances } = useBalances(account, tokens)
  const { allowances, refetch: refetchAllowances } = useAllowances(account, tokens)
  const settings = useSettings()
  const [selectedTokenIn, setSelectedTokenIn] = useState<Address>()
  const [selectedTokenOut, setSelectedTokenOut] = useState<Address>()
  const initialState = useMemo(() => ({ ...readLastPair(), ...parseSwapUrl(window.location.hash) }), [])
  const [amountIn, setAmountIn] = useState(() => (initialState.mode === 'exactOut' ? '' : initialState.amount ?? ''))
  const [amountOut, setAmountOut] = useState(() => (initialState.mode === 'exactOut' ? initialState.amount ?? '' : ''))
  const [mode, setMode] = useState<QuoteMode>(() => initialState.mode ?? 'exactIn')
  const [flipCount, setFlipCount] = useState(0)
  const [announcement, setAnnouncement] = useState('')
  // The price-impact acknowledgment the trader ticked, kept as the key of the trade it was given for (useSwap).
  const [impactAcknowledgedKey, setImpactAcknowledgedKey] = useState<string>()
  const recent = useRecent(activeChain.id)

  // The pair comes from the shareable URL, else the last pair used in this browser, else the registry order.
  const tokenIn = findToken(tokens, selectedTokenIn) ?? findTokenByRef(tokens, initialState.in) ?? tokens[0]
  const preferredOut = findTokenByRef(tokens, initialState.out)
  const tokenOut =
    findToken(tokens, selectedTokenOut)
    ?? (preferredOut && preferredOut.address !== tokenIn?.address ? preferredOut : undefined)
    ?? tokens.find((token) => token.address !== tokenIn?.address)
  const enteredAmount = mode === 'exactIn' ? amountIn : amountOut

  // A token named in the URL (a shared link, say) may not be in the list yet — the pairs are still
  // loading, or the read failed. Until the user picks, don't overwrite it with the fallback pair.
  const unresolvedRef =
    (initialState.in !== undefined && !findTokenByRef(tokens, initialState.in))
    || (initialState.out !== undefined && !findTokenByRef(tokens, initialState.out))
  const userPicked = selectedTokenIn !== undefined || selectedTokenOut !== undefined

  // Keep the URL shareable and remember the pair; replaceState so the back button is not spammed.
  useEffect(() => {
    if (!tokenIn || !tokenOut) return
    if (unresolvedRef && !userPicked) return
    const pair = { in: tokenRef(tokenIn), out: tokenRef(tokenOut) }
    writeLastPair(pair)
    const next = formatSwapUrl({ ...pair, amount: enteredAmount || undefined, mode })
    if (window.location.hash !== next && (window.location.hash.startsWith('#swap') || window.location.hash === '')) {
      window.history.replaceState(null, '', next)
    }
  }, [enteredAmount, mode, tokenIn, tokenOut, unresolvedRef, userPicked])

  // ⌘K / Ctrl+K opens the "You pay" token picker from anywhere on the sheet.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        document.querySelector<HTMLButtonElement>('[data-hotkey="pay-token"]')?.click()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const { quote, reason } = useQuote(tokenIn, tokenOut, enteredAmount, mode, pairs, activeChain.usdc, settings.slippageBps)
  const displayedIn = mode === 'exactIn' ? amountIn : quote ? formatAmount(quote.amountIn, tokenIn?.decimals ?? 18) : ''
  const displayedOut = mode === 'exactOut' ? amountOut : quote ? formatAmount(quote.amountOut, tokenOut?.decimals ?? 18) : ''

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const high = quote && isHighImpact(quote.priceImpactBps) ? `. High price impact: ${formatPct(quote.priceImpactBps)}.` : ''
      setAnnouncement(quote && tokenOut ? `You receive ${formatAmount(quote.amountOut, tokenOut.decimals)} ${tokenOut.symbol}${high}` : '')
    }, 300)
    return () => window.clearTimeout(timer)
  }, [quote, tokenOut])

  /** A token amount in USD (6 decimals) at its USDC pool's price now; undefined without a funded USDC pool. */
  const tokenUsd = useCallback(
    (token: Token | undefined, rawAmount: bigint | undefined): bigint | undefined => {
      if (!token || rawAmount === undefined) return undefined
      if (token.address.toLowerCase() === activeChain.usdc.toLowerCase()) {
        return token.decimals === 6 ? rawAmount : (rawAmount * 10n ** 6n) / 10n ** BigInt(token.decimals)
      }
      const pair = pairs.find(
        (item) =>
          [item.token0.toLowerCase(), item.token1.toLowerCase()].includes(token.address.toLowerCase()) &&
          [item.token0.toLowerCase(), item.token1.toLowerCase()].includes(activeChain.usdc.toLowerCase()),
      )
      if (!pair) return undefined
      const [reserveToken, reserveUsdc] = reservesFor(pair, token.address)
      if (reserveToken === 0n || reserveUsdc === 0n) return undefined
      return ratioQuote(rawAmount, reserveToken, reserveUsdc)
    },
    [pairs],
  )
  const tokenUsdValue = useCallback(
    (token: Token | undefined, rawAmount: bigint | undefined): string | undefined => {
      const usd = tokenUsd(token, rawAmount)
      return usd === undefined ? undefined : formatUsd(usd, 6)
    },
    [tokenUsd],
  )

  const parseDisplayed = (value: string, token: Token | undefined) => {
    if (!value || !token) return undefined
    try {
      return parseAmount(value, token.decimals)
    } catch {
      return undefined
    }
  }

  const payUsd = tokenUsdValue(tokenIn, quote?.amountIn ?? parseDisplayed(displayedIn, tokenIn))
  const receiveUsd = tokenUsdValue(tokenOut, quote?.amountOut ?? parseDisplayed(displayedOut, tokenOut))
  const balance = tokenIn ? balances.get(tokenIn.address.toLowerCase()) ?? 0n : 0n
  const allowance = tokenIn ? allowances.get(tokenIn.address.toLowerCase()) ?? 0n : 0n
  const afterTransaction = useCallback(async () => {
    await Promise.all([refetchPairs(), refetchBalances(), refetchAllowances()])
  }, [refetchAllowances, refetchBalances, refetchPairs])
  const clearAmounts = useCallback(() => {
    setAmountIn('')
    setAmountOut('')
    setImpactAcknowledgedKey(undefined)
  }, [])

  // What the price impact costs, in USD (lib/impactGuard.ts): from what is paid, else from what is received.
  const impactLossUsd = useMemo(() => {
    if (!quote) return undefined
    const paid = tokenUsd(tokenIn, quote.amountIn)
    if (paid !== undefined) return swapImpactLossUsd(paid, quote.priceImpactBps, quote.pairs.length)
    const received = tokenUsd(tokenOut, quote.amountOut)
    return received === undefined ? undefined : swapImpactLossUsdFromOutput(received, quote.priceImpactBps)
  }, [quote, tokenIn, tokenOut, tokenUsd])
  // From 5% impact: the largest trade on this route that stays under 1%, in the token paid.
  const impactHint = useMemo(
    () => (quote && tokenIn && isHighImpact(quote.priceImpactBps) ? impactSizeHint(maxRouteInput(quote), tokenIn.decimals, tokenIn.symbol) : undefined),
    [quote, tokenIn],
  )

  const swap = useSwap({
    tokenIn,
    tokenOut,
    quote,
    reason,
    mode,
    allowance,
    balance,
    deadlineMinutes: settings.deadlineMinutes,
    onConfirmed: afterTransaction,
    onClear: clearAmounts,
    impactLossUsd,
    impactAcknowledgedKey,
  })

  // Changing a token keeps the amount the user typed; only the derived side is recomputed by the quote. Any edit
  // (a token, an amount, a flip) clears the price-impact acknowledgment: it is ticked again for the new trade.
  const selectIn = (token: Token) => {
    if (token.address.toLowerCase() === tokenOut?.address.toLowerCase()) setSelectedTokenOut(tokenIn?.address)
    setSelectedTokenIn(token.address)
    if (mode === 'exactOut') setAmountIn('')
    else setAmountOut('')
    setImpactAcknowledgedKey(undefined)
  }
  const selectOut = (token: Token) => {
    if (token.address.toLowerCase() === tokenIn?.address.toLowerCase()) setSelectedTokenIn(tokenOut?.address)
    setSelectedTokenOut(token.address)
    if (mode === 'exactOut') setAmountIn('')
    else setAmountOut('')
    setImpactAcknowledgedKey(undefined)
  }
  const flip = () => {
    setSelectedTokenIn(tokenOut?.address)
    setSelectedTokenOut(tokenIn?.address)
    setAmountIn(displayedOut.replace(/,/g, ''))
    setAmountOut(displayedIn.replace(/,/g, ''))
    setMode(mode === 'exactIn' ? 'exactOut' : 'exactIn')
    setFlipCount((value) => value + 1)
    setImpactAcknowledgedKey(undefined)
  }

  const handlePrimary = async () => {
    if (swap.buttonState === 'disconnected') {
      open()
      return
    }
    if (swap.buttonState === 'wrongChain') {
      await switchToArc()
      return
    }
    await swap.execute()
  }

  return (
    <div className="swap-column">
      <h1 className="sr-only">Swap</h1>
      <div className="swap-sheet">
        {swap.isLoading && <span className="rule-sweep" aria-hidden="true" />}
        <div className="sheet-tools">
          <SettingsPopover
            slippageBps={settings.slippageBps}
            deadlineMinutes={settings.deadlineMinutes}
            onSlippage={settings.setSlippageBps}
            onDeadline={settings.setDeadlineMinutes}
          />
        </div>
        <AmountField
          id="swap-pay"
          label="You pay"
          amount={displayedIn}
          onAmount={(value) => {
            setMode('exactIn')
            setAmountIn(value)
            setAmountOut('')
            setImpactAcknowledgedKey(undefined)
          }}
          token={tokenIn}
          tokens={tokens.filter((token) => token.address.toLowerCase() !== tokenOut?.address.toLowerCase())}
          onToken={selectIn}
          balances={balances}
          usdValue={payUsd}
          onSubmit={() => { if (!swap.isDisabled && !swap.isLoading) void handlePrimary() }}
          hotkey="pay-token"
          pickerExtra={PAY_SIDE_LAUNCHES}
        />

        <div className="flip-rule">
          <button type="button" className="flip-button" onClick={flip} disabled={!tokenIn || !tokenOut} aria-label="Flip tokens">
            <FlipIcon style={{ transform: `rotate(${flipCount * 180}deg)` }} />
          </button>
        </div>

        <AmountField
          id="swap-receive"
          label="You receive"
          amount={displayedOut}
          onAmount={(value) => {
            setMode('exactOut')
            setAmountOut(value)
            setAmountIn('')
            setImpactAcknowledgedKey(undefined)
          }}
          token={tokenOut}
          tokens={tokens.filter((token) => token.address.toLowerCase() !== tokenIn?.address.toLowerCase())}
          onToken={selectOut}
          balances={balances}
          usdValue={receiveUsd}
          checkBalance={false}
          onSubmit={() => { if (!swap.isDisabled && !swap.isLoading) void handlePrimary() }}
          pickerExtra={RECEIVE_SIDE_LAUNCHES}
        />

        <ReceiptLines quote={quote} mode={mode} tokenIn={tokenIn} tokenOut={tokenOut} tokens={tokens} impactLossUsd={impactLossUsd} />
        {enteredAmount && reason && reason !== 'ZeroAmount' && (
          <p className="quote-message" role="status">
            {reason === 'InsufficientLiquidity'
              ? 'Not enough liquidity in this pool for that amount.'
              : 'No pool connects these tokens yet.'}
          </p>
        )}
        <ImpactGuard
          id="swap-impact-accept"
          bps={quote?.priceImpactBps}
          hint={impactHint}
          acknowledgment={swap.impactAcknowledgment}
          acknowledged={swap.impactAcknowledged}
          onAcknowledge={(checked) => setImpactAcknowledgedKey(checked ? swap.impactKey : undefined)}
        />

        <PrimaryButton className="mt-6 w-full" loading={swap.isLoading} disabled={swap.isDisabled} onClick={() => void handlePrimary()}>
          {swap.label}
        </PrimaryButton>
        {swap.hint && <p className="hint-line" role="status">{swap.hint}</p>}
        {account && (balances.get(activeChain.usdc.toLowerCase()) ?? 0n) === 0n && (
          <p className="hint-line" role="status">
            No USDC on Arc.{' '}
            <button type="button" className="font-semibold underline" onClick={() => { window.location.hash = '#bridge' }}>
              Bridge from Ethereum or Solana
            </button>
          </p>
        )}
        <TxStatus status={swap.txStatus} />
        <div className="sr-only" aria-live="polite">{announcement}</div>
      </div>
      {tokenIn && tokenOut && (
        <Suspense fallback={null}>
          <SwapPriceChart tokenIn={tokenIn} tokenOut={tokenOut} pairs={pairs} />
        </Suspense>
      )}
      <RecentLedger entries={recent} />
      {!isDeployed && (
        <p className="mt-6 border-t border-g300 pt-4 text-sm leading-6 text-g500">
          Architex contracts are not deployed on this network yet. Quotes and transactions will become available when deployment addresses are configured.
        </p>
      )}
    </div>
  )
}
