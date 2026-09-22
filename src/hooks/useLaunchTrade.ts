import { useCallback, useMemo, useState } from 'react'
import type { Hex } from 'viem'
import { useAccount, usePublicClient, useWriteContract } from 'wagmi'
import { activeChain } from '../chain'
import { erc20Abi, launchRouterAbi, launchpadAbi } from '../lib/abi'
import { deployment, launchSuite } from '../lib/deployment'
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
import type { LaunchRecord, TradeVenue } from '../lib/launch'
import { quoteLaunchTrade, type LaunchQuote, type LaunchSide } from '../lib/launchQuote'
import { pushRecent } from '../lib/recent'
import type { Token } from '../lib/tokens'
import { launchFixtureApi } from '../lib/launchFixtureApi'
import { spendableBalance } from '../lib/gasReserve'
import type { LaunchAllowances } from './useLaunch'
import type { SwapTxStatus } from './useSwap'

const fixtureOn = import.meta.env.DEV && import.meta.env.VITE_LAUNCHPAD_FIXTURE === '1'

export type { LaunchQuote, LaunchSide }

export type LaunchButtonState =
  | 'disconnected'
  | 'wrongChain'
  | 'enterAmount'
  | 'poolLoading'
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
  onConfirmed: () => void | Promise<void>
  onClear: () => void
  /** The `impactKey` the trader ticked the price-impact acknowledgment for, if any. */
  impactAcknowledgedKey: string | undefined
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

  const quote = useMemo(() => (launch ? quoteLaunchTrade(launch, side, parsedIn, slippageBps) : undefined), [launch, parsedIn, side, slippageBps])

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

  const venue: TradeVenue = launch?.graduated ? 'pool' : 'curve'
  // A buy on the curve spends through the launchpad, in the pool through the launch router. A sell needs no
  // approval at all: the token lets either pull only from whoever is selling.
  const spender = venue === 'curve' ? launchSuite.launchpad : launchSuite.launchRouter
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
    if (launch?.graduated && !launch.pool) return 'poolLoading'
    if (!quote) return 'enterAmount'
    if (!payToken || spendableBalance(payToken.address, balance) < required) return 'insufficientBalance'
    if (side === 'buy' && allowance < required) return 'needsApproval'
    return 'ready'
  }, [account, allowance, balance, chainId, impactRefused, isConnected, launch?.graduated, launch?.pool, payToken, phase, quote, required, side])

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
            args: [venue === 'curve' ? deployment.launchpad : deployment.launchRouter, required],
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
          chainOut = side === 'buy'
            ? (await publicClient.readContract({ address: deployment.launchpad, abi: launchpadAbi, functionName: 'quoteBuy', args: [launch.token, quote.offer] }))[0]
            : (await publicClient.readContract({ address: deployment.launchpad, abi: launchpadAbi, functionName: 'quoteSell', args: [launch.token, quote.offer] }))[0]
        } else {
          chainOut = side === 'buy'
            ? (await publicClient.readContract({ address: deployment.launchRouter, abi: launchRouterAbi, functionName: 'quoteBuy', args: [launch.token, quote.offer] }))[0]
            : (await publicClient.readContract({ address: deployment.launchRouter, abi: launchRouterAbi, functionName: 'quoteSell', args: [launch.token, quote.offer] }))[0]
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
        // One deadline for both venues, from the sheet's settings: the curve and the launch router both revert
        // Expired once block.timestamp is past it.
        const deadline = BigInt(Math.floor(Date.now() / 1_000) + deadlineMinutes * 60)
        // The offer, not the quoted spend: on the curve's sell-out buy the spend can be one unit below the smallest
        // offer that sells out, so offering only the spend could buy a hair less and not graduate.
        hash = venue === 'curve'
          ? await writeContractAsync({
              chainId: activeChain.id,
              address: deployment.launchpad,
              abi: launchpadAbi,
              functionName: side,
              args: [launch.token, quote.offer, quote.minReceived, account, deadline],
            })
          : await writeContractAsync({
              chainId: activeChain.id,
              address: deployment.launchRouter,
              abi: launchRouterAbi,
              functionName: side,
              args: [launch.token, quote.offer, quote.minReceived, account, deadline],
            })
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
    launch,
    onClear,
    onConfirmed,
    publicClient,
    quote,
    required,
    side,
    spender,
    token,
    usdc.address,
    usdc.decimals,
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
    buttonState,
    label,
    hint,
    isLoading: buttonState === 'approving' || buttonState === 'pending',
    isDisabled:
      ['enterAmount', 'poolLoading', 'insufficientBalance', 'pending', 'impactTooHigh'].includes(buttonState)
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
