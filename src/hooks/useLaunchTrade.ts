import { useCallback, useMemo, useState } from 'react'
import type { Address } from 'viem'
import { useAccount, useChainId, usePublicClient, useWriteContract } from 'wagmi'
import { activeChain } from '../chain'
import { erc20Abi, launchpadAbi } from '../lib/abi'
import { quoteBuy, quoteSell } from '../lib/curve'
import { deployment } from '../lib/deployment'
import { isUserRejection, revertReason } from '../lib/errors'
import { formatAmount } from '../lib/format'
import { curvePriceImpactBps, curveStateOf, type LaunchRecord } from '../lib/launch'
import { minReceived } from '../lib/amm'
import { pushRecent } from '../lib/recent'
import type { Token } from '../lib/tokens'
import { launchFixtureApi } from '../lib/launchFixtureApi'
import type { SwapTxStatus } from './useSwap'

const fixtureOn = import.meta.env.DEV && import.meta.env.VITE_LAUNCHPAD_FIXTURE === '1'

export type LaunchSide = 'buy' | 'sell'

export type LaunchButtonState =
  | 'disconnected'
  | 'wrongChain'
  | 'enterAmount'
  | 'graduated'
  | 'insufficientBalance'
  | 'needsApproval'
  | 'approving'
  | 'ready'
  | 'quoteMoved'
  | 'pending'

export interface LaunchQuote {
  amountIn: bigint
  amountOut: bigint
  fee: bigint
  usdcSpent: bigint
  minReceived: bigint
  priceImpactBps: bigint
  graduates: boolean
}

interface UseLaunchTradeArgs {
  launch: LaunchRecord | undefined
  token: Token | undefined
  usdc: Token
  side: LaunchSide
  parsedIn: bigint
  slippageBps: number
  tokenBalance: bigint
  usdcBalance: bigint
  usdcAllowance: bigint
  onConfirmed: () => void | Promise<void>
  onClear: () => void
}

export function useLaunchTrade({
  launch,
  token,
  usdc,
  side,
  parsedIn,
  slippageBps,
  tokenBalance,
  usdcBalance,
  usdcAllowance,
  onConfirmed,
  onClear,
}: UseLaunchTradeArgs) {
  const { address: account, isConnected } = useAccount()
  const chainId = useChainId()
  const publicClient = usePublicClient()
  const { writeContractAsync } = useWriteContract()
  const [phase, setPhase] = useState<'idle' | 'approving' | 'quoteMoved' | 'pending'>('idle')
  const [txStatus, setTxStatus] = useState<SwapTxStatus | undefined>()
  const [approvedThisSession, setApprovedThisSession] = useState(false)

  const quote = useMemo<LaunchQuote | undefined>(() => {
    if (!launch || launch.graduated || parsedIn <= 0n) return undefined
    const state = curveStateOf(launch)
    try {
      if (side === 'buy') {
        const result = quoteBuy(state, parsedIn)
        return {
          amountIn: result.usdcSpent,
          amountOut: result.tokensOut,
          fee: result.fee,
          usdcSpent: result.usdcSpent,
          minReceived: minReceived(result.tokensOut, slippageBps),
          priceImpactBps: curvePriceImpactBps(state, result.next),
          graduates: result.graduates,
        }
      }
      const result = quoteSell(state, parsedIn)
      return {
        amountIn: parsedIn,
        amountOut: result.usdcOut,
        fee: result.fee,
        usdcSpent: 0n,
        minReceived: minReceived(result.usdcOut, slippageBps),
        priceImpactBps: curvePriceImpactBps(state, result.next),
        graduates: false,
      }
    } catch {
      return undefined
    }
  }, [launch, parsedIn, side, slippageBps])

  const payToken = side === 'buy' ? usdc : token
  const balance = side === 'buy' ? usdcBalance : tokenBalance
  const requiredIn = quote ? quote.amountIn : parsedIn

  const buttonState = useMemo<LaunchButtonState>(() => {
    if (!isConnected || !account) return 'disconnected'
    if (chainId !== activeChain.id) return 'wrongChain'
    if (phase === 'approving') return 'approving'
    if (phase === 'quoteMoved') return 'quoteMoved'
    if (phase === 'pending') return 'pending'
    if (launch?.graduated) return 'graduated'
    if (!quote) return 'enterAmount'
    if (balance < requiredIn) return 'insufficientBalance'
    if (side === 'buy' && usdcAllowance < requiredIn) return 'needsApproval'
    return 'ready'
  }, [account, balance, chainId, isConnected, launch?.graduated, phase, quote, requiredIn, side, usdcAllowance])

  const label = useMemo(() => {
    const symbol = token?.symbol ?? 'token'
    switch (buttonState) {
      case 'disconnected':
        return 'Connect wallet'
      case 'wrongChain':
        return activeChain.isTestnet ? 'Switch to Arc Testnet' : 'Switch to Arc'
      case 'enterAmount':
        return 'Enter an amount'
      case 'graduated':
        return 'Trade on Swap'
      case 'insufficientBalance':
        return `Not enough ${payToken?.symbol ?? 'balance'}`
      case 'needsApproval':
        return 'Approve USDC'
      case 'approving':
        return 'Approving USDC…'
      case 'quoteMoved':
        return 'Quote moved — review'
      case 'pending':
        return side === 'buy' ? 'Buying…' : 'Selling…'
      case 'ready':
        return quote && quote.priceImpactBps > 500n
          ? side === 'buy' ? 'Buy anyway' : 'Sell anyway'
          : side === 'buy' ? `Buy ${symbol}` : `Sell ${symbol}`
    }
  }, [buttonState, payToken?.symbol, quote, side, token?.symbol])

  const execute = useCallback(async () => {
    if (!account || !launch || !token || !quote) return
    setTxStatus(undefined)

    if (buttonState === 'quoteMoved') {
      setPhase('idle')
      return
    }

    try {
      if (buttonState === 'needsApproval') {
        setPhase('approving')
        if (fixtureOn) {
          launchFixtureApi()?.approve(account, usdc.address, requiredIn)
        } else {
          if (!publicClient) return
          const hash = await writeContractAsync({
            address: usdc.address,
            abi: erc20Abi,
            functionName: 'approve',
            args: [deployment.launchpad, requiredIn],
          })
          await publicClient.waitForTransactionReceipt({ hash })
        }
        setPhase('idle')
        setApprovedThisSession(true)
        await onConfirmed()
        return
      }

      if (buttonState !== 'ready') return

      if (!fixtureOn && publicClient && side === 'buy') {
        const onchain = await publicClient.readContract({
          address: deployment.launchpad,
          abi: launchpadAbi,
          functionName: 'quoteBuy',
          args: [launch.token, quote.amountIn],
        })
        if ((onchain[0] ?? 0n) < quote.minReceived) {
          setPhase('quoteMoved')
          return
        }
      }
      if (!fixtureOn && publicClient && side === 'sell') {
        const onchain = await publicClient.readContract({
          address: deployment.launchpad,
          abi: launchpadAbi,
          functionName: 'quoteSell',
          args: [launch.token, quote.amountIn],
        })
        if ((onchain[0] ?? 0n) < quote.minReceived) {
          setPhase('quoteMoved')
          return
        }
      }

      setPhase('pending')
      setTxStatus({ kind: 'pending' })
      let hash: Address
      if (fixtureOn) {
        const api = launchFixtureApi()
        if (!api) return
        const result = side === 'buy'
          ? api.buy(account, launch.token, quote.amountIn)
          : api.sell(account, launch.token, quote.amountIn)
        hash = result.hash
      } else {
        if (!publicClient) return
        hash = await writeContractAsync({
          address: deployment.launchpad,
          abi: launchpadAbi,
          functionName: side === 'buy' ? 'buy' : 'sell',
          args: side === 'buy'
            ? [launch.token, quote.amountIn, quote.minReceived, account]
            : [launch.token, quote.amountIn, quote.minReceived, account],
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
    launch,
    onClear,
    onConfirmed,
    publicClient,
    quote,
    requiredIn,
    side,
    token,
    usdc.address,
    usdc.decimals,
    writeContractAsync,
  ])

  const hint = useMemo(() => {
    if (buttonState === 'needsApproval') return 'Step 1 of 2 — approve USDC once, then buy.'
    if (buttonState === 'approving') return 'Step 1 of 2 — waiting for the USDC approval to confirm.'
    if (buttonState === 'ready' && approvedThisSession && side === 'buy') return 'Step 2 of 2 — approved. Buy when you are ready.'
    if (buttonState === 'quoteMoved') return 'The curve moved while you were reading. Check the new amounts, then try again.'
    return undefined
  }, [approvedThisSession, buttonState, side])

  return {
    quote,
    buttonState,
    label,
    hint,
    isLoading: buttonState === 'approving' || buttonState === 'pending',
    isDisabled: ['enterAmount', 'insufficientBalance', 'pending', 'graduated'].includes(buttonState),
    txStatus,
    execute,
  }
}
