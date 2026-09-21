import { useCallback, useMemo, useState } from 'react'
import type { Hash } from 'viem'
import { useAccount, usePublicClient, useWriteContract } from 'wagmi'
import { activeChain } from '../chain'
import { isUserRejection, revertReason } from '../lib/errors'
import { spendableBalance } from '../lib/gasReserve'
import { pushRecent } from '../lib/recent'
import { erc20Abi, routerAbi } from '../lib/abi'
import { deployment } from '../lib/deployment'
import { formatAmount } from '../lib/format'
import type { QuoteMode } from '../lib/amm'
import type { LocalQuote, NoQuoteReason } from './useQuote'
import type { Token } from '../lib/tokens'

export type SwapButtonState =
  | 'disconnected'
  | 'wrongChain'
  | 'enterAmount'
  | 'noRoute'
  | 'insufficientLiquidity'
  | 'insufficientBalance'
  | 'needsApproval'
  | 'approving'
  | 'ready'
  | 'quoteMoved'
  | 'pending'

export interface SwapTxStatus {
  kind: 'pending' | 'confirmed' | 'failed' | 'cancelled'
  hash?: Hash
  reason?: string
  /** Confirmed swaps carry the human summary that used to be a toast, e.g. "Swapped 0.5 WETH for 1,251.20 USDC". */
  summary?: string
}

interface UseSwapArgs {
  tokenIn: Token | undefined
  tokenOut: Token | undefined
  quote: LocalQuote | undefined
  reason: NoQuoteReason | undefined
  mode: QuoteMode
  allowance: bigint
  balance: bigint
  deadlineMinutes: number
  onConfirmed: () => void | Promise<void>
  onClear: () => void
}


export function useSwap({
  tokenIn,
  tokenOut,
  quote,
  reason,
  mode,
  allowance,
  balance,
  deadlineMinutes,
  onConfirmed,
  onClear,
}: UseSwapArgs) {
  const { address: account, isConnected, chainId } = useAccount()
  const publicClient = usePublicClient()
  const { writeContractAsync } = useWriteContract()
  const [phase, setPhase] = useState<'idle' | 'approving' | 'quoteMoved' | 'pending'>('idle')
  const [txStatus, setTxStatus] = useState<SwapTxStatus | undefined>()
  const [approvedThisSession, setApprovedThisSession] = useState(false)

  const requiredApproval = quote ? (mode === 'exactIn' ? quote.amountIn : quote.maxSent) : 0n

  const buttonState = useMemo<SwapButtonState>(() => {
    if (!isConnected || !account) return 'disconnected'
    if (chainId !== activeChain.id) return 'wrongChain'
    if (phase === 'approving') return 'approving'
    if (phase === 'quoteMoved') return 'quoteMoved'
    if (phase === 'pending') return 'pending'
    if (!quote) {
      if (reason === 'NoRoute') return 'noRoute'
      if (reason === 'InsufficientLiquidity') return 'insufficientLiquidity'
      return 'enterAmount'
    }
    if (!tokenIn || spendableBalance(tokenIn.address, balance) < requiredApproval) return 'insufficientBalance'
    if (allowance < requiredApproval) return 'needsApproval'
    return 'ready'
  }, [account, allowance, balance, chainId, isConnected, phase, quote, reason, requiredApproval, tokenIn])

  const label = useMemo(() => {
    switch (buttonState) {
      case 'disconnected':
        return 'Connect wallet'
      case 'wrongChain':
        return activeChain.isTestnet ? 'Switch to Arc Testnet' : 'Switch to Arc'
      case 'enterAmount':
        return 'Enter an amount'
      case 'noRoute':
        return 'No pool for this pair'
      case 'insufficientLiquidity':
        return 'Not enough liquidity'
      case 'insufficientBalance':
        return `Not enough ${tokenIn?.symbol ?? 'balance'}`
      case 'needsApproval':
        return `Approve ${tokenIn?.symbol ?? 'token'}`
      case 'approving':
        return `Approving ${tokenIn?.symbol ?? 'token'}…`
      case 'quoteMoved':
        return 'Quote moved — review'
      case 'pending':
        return 'Swapping…'
      case 'ready':
        return quote && quote.priceImpactBps > 500n ? 'Swap anyway' : 'Swap'
    }
  }, [buttonState, quote, tokenIn])

  const execute = useCallback(async () => {
    if (!account || !tokenIn || !tokenOut || !quote || !publicClient) return
    setTxStatus(undefined)

    if (buttonState === 'quoteMoved') {
      setPhase('idle')
      return
    }

    try {
      if (buttonState === 'needsApproval') {
        setPhase('approving')
        const hash = await writeContractAsync({
          chainId: activeChain.id,
          address: tokenIn.address,
          abi: erc20Abi,
          functionName: 'approve',
          args: [deployment.router, requiredApproval],
        })
        await publicClient.waitForTransactionReceipt({ hash })
        setPhase('idle')
        setApprovedThisSession(true)
        await onConfirmed()
        return
      }

      if (buttonState !== 'ready') return
      const deadline = BigInt(Math.floor(Date.now() / 1_000) + deadlineMinutes * 60)

      if (mode === 'exactIn') {
        const chainAmounts = await publicClient.readContract({
          address: deployment.router,
          abi: routerAbi,
          functionName: 'getAmountsOut',
          args: [quote.amountIn, quote.path],
        })
        if ((chainAmounts[chainAmounts.length - 1] ?? 0n) < quote.minReceived) {
          setPhase('quoteMoved')
          return
        }
      } else {
        const chainAmounts = await publicClient.readContract({
          address: deployment.router,
          abi: routerAbi,
          functionName: 'getAmountsIn',
          args: [quote.amountOut, quote.path],
        })
        if ((chainAmounts[0] ?? quote.maxSent + 1n) > quote.maxSent) {
          setPhase('quoteMoved')
          return
        }
      }

      setPhase('pending')
      setTxStatus({ kind: 'pending' })
      const hash =
        mode === 'exactIn'
          ? await writeContractAsync({
              chainId: activeChain.id,
              address: deployment.router,
              abi: routerAbi,
              functionName: 'swapExactTokensForTokens',
              args: [quote.amountIn, quote.minReceived, quote.path, account, deadline],
            })
          : await writeContractAsync({
              chainId: activeChain.id,
              address: deployment.router,
              abi: routerAbi,
              functionName: 'swapTokensForExactTokens',
              args: [quote.amountOut, quote.maxSent, quote.path, account, deadline],
            })
      setTxStatus({ kind: 'pending', hash })
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error('Transaction reverted')
      const summary = `Swapped ${formatAmount(quote.amountIn, tokenIn.decimals)} ${tokenIn.symbol} for ${formatAmount(quote.amountOut, tokenOut.decimals)} ${tokenOut.symbol}`
      setTxStatus({ kind: 'confirmed', hash, summary })
      pushRecent(activeChain.id, { hash, kind: 'swap', summary })
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
    mode,
    onClear,
    onConfirmed,
    publicClient,
    quote,
    requiredApproval,
    tokenIn,
    tokenOut,
    writeContractAsync,
  ])

  // One quiet line under the button that says where the user is in a two-step approve→swap.
  const hint = useMemo(() => {
    const symbol = tokenIn?.symbol ?? 'token'
    if (buttonState === 'needsApproval') return `Step 1 of 2 — approve ${symbol} once, then swap.`
    if (buttonState === 'approving') return `Step 1 of 2 — waiting for the ${symbol} approval to confirm.`
    if (buttonState === 'ready' && approvedThisSession) return 'Step 2 of 2 — approved. Swap when you are ready.'
    if (buttonState === 'quoteMoved') return 'The pool moved while you were reading. Check the new amounts, then swap again.'
    return undefined
  }, [approvedThisSession, buttonState, tokenIn])

  return {
    buttonState,
    label,
    hint,
    isLoading: buttonState === 'approving' || buttonState === 'pending',
    isDisabled: ['enterAmount', 'noRoute', 'insufficientLiquidity', 'insufficientBalance', 'pending'].includes(buttonState),
    txStatus,
    execute,
  }
}
