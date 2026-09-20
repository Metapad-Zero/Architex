import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react'
import type { Address } from 'viem'
import { useAccount, useSwitchChain } from 'wagmi'
import { useConnectSheet } from '../hooks/useConnectSheet'
import { activeChain } from '../chain'
import { quote as ratioQuote, reservesFor, type QuoteMode } from '../lib/amm'
import { isDeployed } from '../lib/deployment'
import { isCanonicalToken } from '../lib/tokens'
import { formatAmount, formatUsd, parseAmount } from '../lib/format'
import { useRecent } from '../lib/recent'
import { formatSwapUrl, parseSwapUrl, readLastPair, writeLastPair } from '../lib/swapUrl'
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
import { PrimaryButton } from './PrimaryButton'
import { ReceiptLines } from './ReceiptLines'
import { RecentLedger } from './RecentLedger'
import { SettingsPopover } from './SettingsPopover'
import { TxStatus } from './TxStatus'

// Below the sheet and not needed to swap: kept out of the first chunk.
const SwapPriceChart = lazy(() => import('./SwapPriceChart'))

function findToken(tokens: readonly Token[], address: Address | undefined): Token | undefined {
  return tokens.find((token) => token.address.toLowerCase() === address?.toLowerCase())
}

function findTokenByRef(tokens: readonly Token[], ref: string | undefined): Token | undefined {
  if (!ref) return undefined
  const needle = ref.toLowerCase()
  const byAddress = tokens.find((token) => token.address.toLowerCase() === needle)
  if (byAddress) return byAddress
  return tokens.find((token) => token.symbol.toLowerCase() === needle && isCanonicalToken(token.address))
}

export function SwapSheet() {
  const { address: account } = useAccount()
  const { open } = useConnectSheet()
  const { switchChainAsync } = useSwitchChain()
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
  const recent = useRecent(activeChain.id)

  // The pair comes from the shareable URL, else the last pair used in this browser, else the registry order.
  const tokenIn = findToken(tokens, selectedTokenIn) ?? findTokenByRef(tokens, initialState.in) ?? tokens[0]
  const preferredOut = findTokenByRef(tokens, initialState.out)
  const tokenOut =
    findToken(tokens, selectedTokenOut)
    ?? (preferredOut && preferredOut.address !== tokenIn?.address ? preferredOut : undefined)
    ?? tokens.find((token) => token.address !== tokenIn?.address)
  const enteredAmount = mode === 'exactIn' ? amountIn : amountOut

  // Keep the URL shareable and remember the pair; replaceState so the back button is not spammed.
  useEffect(() => {
    if (!tokenIn || !tokenOut) return
    writeLastPair({ in: tokenIn.symbol, out: tokenOut.symbol })
    const next = formatSwapUrl({ in: tokenIn.symbol, out: tokenOut.symbol, amount: enteredAmount || undefined, mode })
    if (window.location.hash !== next && (window.location.hash.startsWith('#swap') || window.location.hash === '')) {
      window.history.replaceState(null, '', next)
    }
  }, [enteredAmount, mode, tokenIn, tokenOut])

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
      setAnnouncement(quote && tokenOut ? `You receive ${formatAmount(quote.amountOut, tokenOut.decimals)} ${tokenOut.symbol}` : '')
    }, 300)
    return () => window.clearTimeout(timer)
  }, [quote, tokenOut])

  const tokenUsdValue = useCallback(
    (token: Token | undefined, rawAmount: bigint | undefined): string | undefined => {
      if (!token || rawAmount === undefined) return undefined
      if (token.address.toLowerCase() === activeChain.usdc.toLowerCase()) return formatUsd(rawAmount, token.decimals)
      const pair = pairs.find(
        (item) =>
          [item.token0.toLowerCase(), item.token1.toLowerCase()].includes(token.address.toLowerCase()) &&
          [item.token0.toLowerCase(), item.token1.toLowerCase()].includes(activeChain.usdc.toLowerCase()),
      )
      if (!pair) return undefined
      const [reserveToken, reserveUsdc] = reservesFor(pair, token.address)
      if (reserveToken === 0n || reserveUsdc === 0n) return undefined
      return formatUsd(ratioQuote(rawAmount, reserveToken, reserveUsdc), 6)
    },
    [pairs],
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
  }, [])

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
  })

  // Changing a token keeps the amount the user typed; only the derived side is recomputed by the quote.
  const selectIn = (token: Token) => {
    if (token.address.toLowerCase() === tokenOut?.address.toLowerCase()) setSelectedTokenOut(tokenIn?.address)
    setSelectedTokenIn(token.address)
    if (mode === 'exactOut') setAmountIn('')
    else setAmountOut('')
  }
  const selectOut = (token: Token) => {
    if (token.address.toLowerCase() === tokenIn?.address.toLowerCase()) setSelectedTokenIn(tokenOut?.address)
    setSelectedTokenOut(token.address)
    if (mode === 'exactOut') setAmountIn('')
    else setAmountOut('')
  }
  const flip = () => {
    setSelectedTokenIn(tokenOut?.address)
    setSelectedTokenOut(tokenIn?.address)
    setAmountIn(displayedOut.replace(/,/g, ''))
    setAmountOut(displayedIn.replace(/,/g, ''))
    setMode(mode === 'exactIn' ? 'exactOut' : 'exactIn')
    setFlipCount((value) => value + 1)
  }

  const handlePrimary = async () => {
    if (swap.buttonState === 'disconnected') {
      open()
      return
    }
    if (swap.buttonState === 'wrongChain') {
      await switchChainAsync({ chainId: activeChain.id })
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
          }}
          token={tokenIn}
          tokens={tokens.filter((token) => token.address.toLowerCase() !== tokenOut?.address.toLowerCase())}
          onToken={selectIn}
          balances={balances}
          usdValue={payUsd}
          onSubmit={() => { if (!swap.isDisabled && !swap.isLoading) void handlePrimary() }}
          hotkey="pay-token"
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
          }}
          token={tokenOut}
          tokens={tokens.filter((token) => token.address.toLowerCase() !== tokenIn?.address.toLowerCase())}
          onToken={selectOut}
          balances={balances}
          usdValue={receiveUsd}
          checkBalance={false}
          onSubmit={() => { if (!swap.isDisabled && !swap.isLoading) void handlePrimary() }}
        />

        <ReceiptLines quote={quote} mode={mode} tokenIn={tokenIn} tokenOut={tokenOut} tokens={tokens} />
        {enteredAmount && reason && reason !== 'ZeroAmount' && (
          <p className="quote-message" role="status">
            {reason === 'InsufficientLiquidity'
              ? 'Not enough liquidity in this pool for that amount.'
              : 'No pool connects these tokens yet.'}
          </p>
        )}

        <PrimaryButton className="mt-6 w-full" loading={swap.isLoading} disabled={swap.isDisabled} onClick={() => void handlePrimary()}>
          {swap.label}
        </PrimaryButton>
        {swap.hint && <p className="hint-line" role="status">{swap.hint}</p>}
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
