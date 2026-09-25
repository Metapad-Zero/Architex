import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Hex } from 'viem'
import { useAccount, usePublicClient, useWriteContract } from 'wagmi'
import { activeChain } from '../chain'
import { erc20Abi, launchRouterAbi, launchpadAbi, launchpadV14Abi, v4RouterAbi } from '../lib/abi'
import { launchSuite, launchSuiteV14 } from '../lib/deployment'
import { isUserRejection, revertReason } from '../lib/errors'
import { formatAmount } from '../lib/format'
import {
  acknowledgmentKey,
  acknowledgmentText,
  impactAllows,
  impactTier,
  isHighImpact,
  launchImpactLossUsd,
} from '../lib/impactGuard'
import { isPriced, launchVersion, type LaunchRecord, type TradeVenue } from '../lib/launch'
import { quoteLaunchTrade, quoteV4Trade, type LaunchQuote, type LaunchSide } from '../lib/launchQuote'
import { snipeBps } from '../lib/launchV14'
import { pushRecent } from '../lib/recent'
import type { Token } from '../lib/tokens'
import { launchFixtureApi } from '../lib/launchFixtureApi'
import { spendableBalance } from '../lib/gasReserve'
import type { LaunchAllowances } from './useLaunch'
import type { SwapTxStatus } from './useSwap'

const fixtureOn = import.meta.env.DEV && import.meta.env.VITE_LAUNCHPAD_FIXTURE === '1'
/** A pool quote is a call to the chain: it waits until typing pauses. */
const POOL_QUOTE_DEBOUNCE_MS = 250

export type { LaunchQuote, LaunchSide }

export type LaunchButtonState =
  | 'disconnected'
  | 'wrongChain'
  | 'enterAmount'
  | 'poolLoading'
  | 'quoting'
  | 'insufficientBalance'
  | 'needsApproval'
  | 'approving'
  | 'ready'
  | 'quoteMoved'
  | 'pending'
  | 'impactTooHigh'

interface UseLaunchTradeArgs {
  launch: LaunchRecord | undefined
  token: Token | undefined
  usdc: Token
  side: LaunchSide
  parsedIn: bigint
  slippageBps: number
  deadlineMinutes: number
  tokenBalance: bigint
  usdcBalance: bigint
  usdcAllowance: LaunchAllowances
  /** The chain's latest block (hooks/useChainBlock.ts), for v1.4's anti-sniping fee; undefined until read. */
  block?: bigint
  onConfirmed: () => void | Promise<void>
  onClear: () => void
  /** The `impactKey` the trader ticked the price-impact acknowledgment for, if any. */
  impactAcknowledgedKey: string | undefined
}

/** The typed amount, once it has held still for a moment. */
function useSettled(value: bigint, delayMs: number): bigint {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delayMs)
    return () => window.clearTimeout(timer)
  }, [delayMs, value])
  return settled
}

export function useLaunchTrade({
  launch,
  token,
  usdc,
  side,
  parsedIn,
  slippageBps,
  deadlineMinutes,
  tokenBalance,
  usdcBalance,
  usdcAllowance,
  block,
  onConfirmed,
  onClear,
  impactAcknowledgedKey,
}: UseLaunchTradeArgs) {
  const { address: account, isConnected, chainId } = useAccount()
  const publicClient = usePublicClient()
  const { writeContractAsync } = useWriteContract()
  const [phase, setPhase] = useState<'idle' | 'approving' | 'quoteMoved' | 'pending'>('idle')
  const [txStatus, setTxStatus] = useState<SwapTxStatus | undefined>()
  const [approvedThisSession, setApprovedThisSession] = useState(false)

  const venue: TradeVenue = launch?.graduated ? 'pool' : 'curve'
  const v14 = launch !== undefined && launchVersion(launch) === 'v14'
  const inV4Pool = v14 && venue === 'pool'

  // v1.4's anti-sniping fee on a buy in the block the chain is at now: on the curve from its creation block, in the
  // pool from the block it opened. A buy lands later, when the fee is lower, so this quote never promises too much.
  const snipe = useMemo(() => {
    if (!launch || !v14 || side !== 'buy' || block === undefined) return 0
    const opened = launch.graduated ? launch.v4?.openBlock : launch.createdBlock
    return opened === undefined ? 0 : snipeBps(opened, block, launch.creatorFeeBps)
  }, [block, launch, side, v14])

  // In a v1.4 pool the quote is the router's (a call to the chain, fees included); everywhere else it is local.
  const settledIn = useSettled(parsedIn, POOL_QUOTE_DEBOUNCE_MS)
  const poolQuoteQuery = useQuery<bigint, Error>({
    queryKey: ['v4Quote', activeChain.id, launch?.token, side, settledIn.toString()],
    enabled: inV4Pool && settledIn > 0n && isPriced(launch) && (fixtureOn || Boolean(publicClient)),
    staleTime: 4_000,
    refetchInterval: 8_000,
    retry: false,
    queryFn: async () => {
      if (!launch) throw new Error('No token')
      if (fixtureOn) {
        const api = launchFixtureApi()
        if (!api) throw new Error('No fixture')
        return api.quoteV4(launch.token, side, settledIn)
      }
      if (!publicClient) throw new Error('No RPC client for Arc')
      return publicClient.readContract({
        address: launchSuiteV14.router,
        abi: v4RouterAbi,
        functionName: side === 'buy' ? 'quoteBuy' : 'quoteSell',
        args: [launch.token, settledIn],
      })
    },
  })
  const poolQuoteFresh = inV4Pool && settledIn === parsedIn && poolQuoteQuery.data !== undefined && !poolQuoteQuery.isPlaceholderData
  const poolQuoteError = inV4Pool && settledIn === parsedIn && parsedIn > 0n && poolQuoteQuery.isError ? revertReason(poolQuoteQuery.error) : undefined

  const quote = useMemo(() => {
    if (!launch) return undefined
    if (inV4Pool) return poolQuoteFresh && poolQuoteQuery.data !== undefined ? quoteV4Trade(launch, side, parsedIn, poolQuoteQuery.data, slippageBps, snipe) : undefined
    return quoteLaunchTrade(launch, side, parsedIn, slippageBps, snipe)
  }, [inV4Pool, launch, parsedIn, poolQuoteFresh, poolQuoteQuery.data, side, slippageBps, snipe])

  // The price-impact guard (lib/impactGuard.ts), as on Swap: a refused trade is neither approved nor sent, and one past
  // the acknowledgment line only while the sheet's checkbox is ticked for this trade (side, typed amount, venue) and
  // for the sentence the trader read.
  const impactLossUsd = launch && quote ? launchImpactLossUsd(launch, side, quote) : undefined
  const impactAcknowledgment = quote ? acknowledgmentText(quote.priceImpactBps, impactLossUsd) : undefined
  const impactKey =
    launch && quote && impactAcknowledgment
      ? acknowledgmentKey([launch.token, side, quote.venue, quote.offer], impactAcknowledgment)
      : undefined
  const impactAcknowledged = impactKey !== undefined && impactAcknowledgedKey === impactKey
  const impactRefused = quote !== undefined && impactTier(quote.priceImpactBps) === 'refused'
  const impactClear = quote === undefined || impactAllows(quote.priceImpactBps, impactAcknowledged)

  // A buy on the curve spends through the token's launchpad, in the pool through its router (v1.3's launch router or
  // v1.4's v4 router). A sell needs no approval at all: the token lets either pull only from whoever is selling.
  const launchpadAddress = v14 ? launchSuiteV14.launchpad : launchSuite.launchpad
  const routerAddress = v14 ? launchSuiteV14.router : launchSuite.launchRouter
  const spender = venue === 'curve' ? launchpadAddress : routerAddress
  const allowance = venue === 'curve' ? usdcAllowance.launchpad : usdcAllowance.router
  const payToken = side === 'buy' ? usdc : token
  const balance = side === 'buy' ? usdcBalance : tokenBalance
  // The whole offer is what the wallet must cover and approve: the curve takes less only on its sell-out buy, and
  // only while nobody else trades first.
  const required = parsedIn

  const buttonState = useMemo<LaunchButtonState>(() => {
    // Refused whatever the wallet's state; an approval or a trade already on its way still shows as one.
    if (impactRefused && phase !== 'approving' && phase !== 'pending') return 'impactTooHigh'
    if (!isConnected || !account) return 'disconnected'
    if (chainId !== activeChain.id) return 'wrongChain'
    if (phase === 'approving') return 'approving'
    if (phase === 'quoteMoved') return 'quoteMoved'
    if (phase === 'pending') return 'pending'
    if (launch && !isPriced(launch)) return 'poolLoading'
    if (!quote) return inV4Pool && parsedIn > 0n && !poolQuoteError ? 'quoting' : 'enterAmount'
    if (!payToken || spendableBalance(payToken.address, balance) < required) return 'insufficientBalance'
    if (side === 'buy' && allowance < required) return 'needsApproval'
    return 'ready'
  }, [account, allowance, balance, chainId, impactRefused, inV4Pool, isConnected, launch, parsedIn, payToken, phase, poolQuoteError, quote, required, side])

  const label = useMemo(() => {
    const symbol = token?.symbol ?? 'token'
    switch (buttonState) {
      case 'disconnected':
        return 'Connect wallet'
      case 'wrongChain':
        return activeChain.isTestnet ? 'Switch to Arc Testnet' : 'Switch to Arc'
      case 'enterAmount':
        return 'Enter an amount'
      case 'poolLoading':
        return 'Reading the pool…'
      case 'quoting':
        return 'Quoting…'
      case 'insufficientBalance':
        return `Not enough ${payToken?.symbol ?? 'balance'}`
      case 'needsApproval':
        return 'Approve USDC'
      case 'approving':
        return 'Approving USDC…'
      case 'quoteMoved':
        return 'Review new quote'
      case 'pending':
        return side === 'buy' ? 'Buying…' : 'Selling…'
      case 'ready':
        return quote && isHighImpact(quote.priceImpactBps)
          ? side === 'buy' ? 'Buy anyway' : 'Sell anyway'
          : side === 'buy' ? `Buy ${symbol}` : `Sell ${symbol}`
      case 'impactTooHigh':
        return 'Price impact too high'
    }
  }, [buttonState, payToken?.symbol, quote, side, token?.symbol])

  const execute = useCallback(async () => {
    if (!account || !launch || !token || !quote) return
    setTxStatus(undefined)

    if (buttonState === 'quoteMoved') {
      setPhase('idle')
      if (inV4Pool) void poolQuoteQuery.refetch()
      return
    }

    // The button is disabled for these already; this holds for any other way in (Enter in a field, say).
    if (!impactClear) return

    try {
      if (buttonState === 'needsApproval') {
        setPhase('approving')
        if (fixtureOn) {
          launchFixtureApi()?.approve(account, usdc.address, spender, required)
        } else {
          if (!publicClient) return
          const hash = await writeContractAsync({
            chainId: activeChain.id,
            address: usdc.address,
            abi: erc20Abi,
            functionName: 'approve',
            args: [spender, required],
          })
          const receipt = await publicClient.waitForTransactionReceipt({ hash })
          if (receipt.status !== 'success') throw new Error('Transaction reverted')
        }
        setPhase('idle')
        setApprovedThisSession(true)
        await onConfirmed()
        return
      }

      if (buttonState !== 'ready') return

      // The chain has the last word: if it now quotes below the bound, stop and show the new amounts.
      if (!fixtureOn && publicClient) {
        let chainOut: bigint
        if (venue === 'curve') {
          const abi = v14 ? launchpadV14Abi : launchpadAbi
          chainOut = side === 'buy'
            ? (await publicClient.readContract({ address: launchpadAddress, abi, functionName: 'quoteBuy', args: [launch.token, quote.offer] }))[0]
            : (await publicClient.readContract({ address: launchpadAddress, abi, functionName: 'quoteSell', args: [launch.token, quote.offer] }))[0]
        } else if (inV4Pool) {
          chainOut = await publicClient.readContract({
            address: routerAddress,
            abi: v4RouterAbi,
            functionName: side === 'buy' ? 'quoteBuy' : 'quoteSell',
            args: [launch.token, quote.offer],
          })
        } else {
          chainOut = side === 'buy'
            ? (await publicClient.readContract({ address: routerAddress, abi: launchRouterAbi, functionName: 'quoteBuy', args: [launch.token, quote.offer] }))[0]
            : (await publicClient.readContract({ address: routerAddress, abi: launchRouterAbi, functionName: 'quoteSell', args: [launch.token, quote.offer] }))[0]
        }
        if (chainOut < quote.minReceived) {
          setPhase('quoteMoved')
          return
        }
      }

      setPhase('pending')
      setTxStatus({ kind: 'pending' })
      let hash: Hex
      if (fixtureOn) {
        const api = launchFixtureApi()
        if (!api) return
        hash = side === 'buy' ? api.buy(account, launch.token, quote.offer).hash : api.sell(account, launch.token, quote.offer).hash
      } else {
        if (!publicClient) return
        // One deadline for every venue, from the sheet's settings: the curve, the launch router and the v4 router all
        // revert Expired once block.timestamp is past it.
        const deadline = BigInt(Math.floor(Date.now() / 1_000) + deadlineMinutes * 60)
        const args = [launch.token, quote.offer, quote.minReceived, account, deadline] as const
        // The offer, not the quoted spend: on the curve's sell-out buy the spend can be one unit below the smallest
        // offer that sells out, so offering only the spend could buy a hair less and not graduate.
        hash = venue === 'curve'
          ? v14
            ? await writeContractAsync({ chainId: activeChain.id, address: launchpadAddress, abi: launchpadV14Abi, functionName: side, args })
            : await writeContractAsync({ chainId: activeChain.id, address: launchpadAddress, abi: launchpadAbi, functionName: side, args })
          : v14
            ? await writeContractAsync({ chainId: activeChain.id, address: routerAddress, abi: v4RouterAbi, functionName: side, args })
            : await writeContractAsync({ chainId: activeChain.id, address: routerAddress, abi: launchRouterAbi, functionName: side, args })
        setTxStatus({ kind: 'pending', hash })
        const receipt = await publicClient.waitForTransactionReceipt({ hash })
        if (receipt.status !== 'success') throw new Error('Transaction reverted')
      }

      const summary = side === 'buy'
        ? `Bought ${formatAmount(quote.amountOut, token.decimals)} ${token.symbol} for ${formatAmount(quote.amountIn, usdc.decimals)} USDC`
        : `Sold ${formatAmount(quote.amountIn, token.decimals)} ${token.symbol} for ${formatAmount(quote.amountOut, usdc.decimals)} USDC`
      setTxStatus({ kind: 'confirmed', hash, summary })
      pushRecent(activeChain.id, { hash, kind: 'launch', summary })
      setPhase('idle')
      onClear()
      await onConfirmed()
    } catch (error) {
      setPhase('idle')
      if (isUserRejection(error)) {
        setTxStatus({ kind: 'cancelled' })
        return
      }
      setTxStatus({ kind: 'failed', reason: revertReason(error) })
    }
  }, [
    account,
    buttonState,
    deadlineMinutes,
    impactClear,
    inV4Pool,
    launch,
    launchpadAddress,
    onClear,
    onConfirmed,
    poolQuoteQuery,
    publicClient,
    quote,
    required,
    routerAddress,
    side,
    spender,
    token,
    usdc.address,
    usdc.decimals,
    v14,
    venue,
    writeContractAsync,
  ])

  const hint = useMemo(() => {
    if (buttonState === 'needsApproval') return 'Step 1 of 2: approve USDC once, then buy.'
    if (buttonState === 'approving') return 'Step 1 of 2: waiting for the USDC approval to confirm.'
    if (buttonState === 'ready' && approvedThisSession && side === 'buy') return 'Step 2 of 2: approved. Buy when you are ready.'
    if (buttonState === 'quoteMoved') {
      return venue === 'curve'
        ? 'The curve moved while you were reading. Check the new amounts, then try again.'
        : 'The pool moved while you were reading. Check the new amounts, then try again.'
    }
    return undefined
  }, [approvedThisSession, buttonState, side, venue])

  return {
    quote,
    venue,
    /** v1.4's anti-sniping fee on a buy in the latest block, in bps; 0 outside the window, for sells and on v1.3. */
    snipeBps: snipe,
    /** Why the pool could not quote the typed amount, in a sentence. */
    quoteError: poolQuoteError,
    buttonState,
    label,
    hint,
    isLoading: buttonState === 'approving' || buttonState === 'pending',
    isDisabled:
      ['enterAmount', 'poolLoading', 'quoting', 'insufficientBalance', 'pending', 'impactTooHigh'].includes(buttonState)
      || (!impactClear && (buttonState === 'needsApproval' || buttonState === 'ready')),
    txStatus,
    execute,
    /** What the price impact costs in USD, the acknowledgment sentence, and the key a tick is kept against. */
    impactLossUsd,
    impactAcknowledgment,
    impactKey,
    impactAcknowledged,
  }
}
