import { useCallback, useMemo, useState } from 'react'
import { parseEventLogs, type Address } from 'viem'
import { useAccount, useChainId, usePublicClient, useReadContract, useWriteContract } from 'wagmi'
import { activeChain } from '../chain'
import { erc20Abi, launchpadAbi } from '../lib/abi'
import { INITIAL_CURVE, quoteBuy } from '../lib/curve'
import { deployment, isLaunchpadDeployed } from '../lib/deployment'
import { isUserRejection, revertReason } from '../lib/errors'
import { formatAmount } from '../lib/format'
import { minReceived } from '../lib/amm'
import { pushRecent } from '../lib/recent'
import { launchFixtureApi } from '../lib/launchFixtureApi'
import type { SwapTxStatus } from './useSwap'

const fixtureOn = import.meta.env.DEV && import.meta.env.VITE_LAUNCHPAD_FIXTURE === '1'

export type CreateButtonState =
  | 'disconnected'
  | 'wrongChain'
  | 'invalid'
  | 'insufficientBalance'
  | 'needsApproval'
  | 'approving'
  | 'ready'
  | 'pending'

interface UseCreateTokenArgs {
  name: string
  symbol: string
  metadataURI: string
  valid: boolean
  initialBuyUsdc: bigint
  slippageBps: number
  usdcBalance: bigint
  usdcAllowance: bigint
  usdcDecimals: number
  onCreated: (token: Address) => void
}

export function useCreateToken({
  name,
  symbol,
  metadataURI,
  valid,
  initialBuyUsdc,
  slippageBps,
  usdcBalance,
  usdcAllowance,
  usdcDecimals,
  onCreated,
}: UseCreateTokenArgs) {
  const { address: account, isConnected } = useAccount()
  const chainId = useChainId()
  const publicClient = usePublicClient()
  const { writeContractAsync } = useWriteContract()
  const [phase, setPhase] = useState<'idle' | 'approving' | 'pending'>('idle')
  const [txStatus, setTxStatus] = useState<SwapTxStatus | undefined>()
  const [approvedThisSession, setApprovedThisSession] = useState(false)

  const feeQuery = useReadContract({
    address: deployment.launchpad,
    abi: launchpadAbi,
    functionName: 'launchFee',
    query: { enabled: !fixtureOn && isLaunchpadDeployed, staleTime: 30_000 },
  })

  const launchFee = fixtureOn ? (launchFixtureApi()?.launchFee() ?? 0n) : (feeQuery.data ?? 0n)
  const firstBuy = useMemo(() => {
    if (initialBuyUsdc <= 0n) return undefined
    try {
      return quoteBuy(INITIAL_CURVE, initialBuyUsdc)
    } catch {
      return undefined
    }
  }, [initialBuyUsdc])

  const totalUsdc = launchFee + (firstBuy?.usdcSpent ?? (initialBuyUsdc > 0n ? initialBuyUsdc : 0n))
  const minTokensOut = firstBuy ? minReceived(firstBuy.tokensOut, slippageBps) : 0n

  const buttonState = useMemo<CreateButtonState>(() => {
    if (!isConnected || !account) return 'disconnected'
    if (chainId !== activeChain.id) return 'wrongChain'
    if (phase === 'approving') return 'approving'
    if (phase === 'pending') return 'pending'
    if (!valid) return 'invalid'
    if (usdcBalance < totalUsdc) return 'insufficientBalance'
    if (usdcAllowance < totalUsdc) return 'needsApproval'
    return 'ready'
  }, [account, chainId, isConnected, phase, totalUsdc, usdcAllowance, usdcBalance, valid])

  const label = useMemo(() => {
    switch (buttonState) {
      case 'disconnected':
        return 'Connect wallet'
      case 'wrongChain':
        return activeChain.isTestnet ? 'Switch to Arc Testnet' : 'Switch to Arc'
      case 'invalid':
        return 'Create token'
      case 'insufficientBalance':
        return 'Not enough USDC'
      case 'needsApproval':
        return 'Approve USDC'
      case 'approving':
        return 'Approving USDC…'
      case 'pending':
        return 'Creating…'
      case 'ready':
        return 'Create token'
    }
  }, [buttonState])

  /** `savedDetails` is the `ipfs://` string of details saved just before this call; it replaces `metadataURI`, which a state update could not deliver in time. */
  const execute = useCallback(async (savedDetails?: string) => {
    if (!account) return
    const uri = savedDetails ?? metadataURI
    setTxStatus(undefined)
    try {
      if (buttonState === 'needsApproval') {
        setPhase('approving')
        if (fixtureOn) {
          launchFixtureApi()?.approve(account, activeChain.usdc, totalUsdc)
        } else {
          if (!publicClient) return
          const hash = await writeContractAsync({
            address: activeChain.usdc,
            abi: erc20Abi,
            functionName: 'approve',
            args: [deployment.launchpad, totalUsdc],
          })
          await publicClient.waitForTransactionReceipt({ hash })
        }
        setPhase('idle')
        setApprovedThisSession(true)
        return
      }
      if (buttonState !== 'ready') return
      setPhase('pending')
      setTxStatus({ kind: 'pending' })
      let token: Address
      let hash: Address
      if (fixtureOn) {
        const api = launchFixtureApi()
        if (!api) return
        const result = api.create(account, name, symbol, uri, initialBuyUsdc)
        token = result.token
        hash = result.hash
      } else {
        if (!publicClient) return
        hash = await writeContractAsync({
          address: deployment.launchpad,
          abi: launchpadAbi,
          functionName: 'createToken',
          args: [name, symbol, uri, initialBuyUsdc, minTokensOut],
        })
        setTxStatus({ kind: 'pending', hash })
        const receipt = await publicClient.waitForTransactionReceipt({ hash })
        if (receipt.status !== 'success') throw new Error('Transaction reverted')
        const created = parseEventLogs({ abi: launchpadAbi, logs: receipt.logs, eventName: 'TokenCreated' })
        const found = created[0]?.args.token
        if (!found) throw new Error('TokenCreated event missing')
        token = found
      }
      const summary = `Created ${symbol}`
      setTxStatus({ kind: 'confirmed', hash, summary })
      pushRecent(activeChain.id, { hash, kind: 'launch', summary })
      setPhase('idle')
      onCreated(token)
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
    initialBuyUsdc,
    metadataURI,
    minTokensOut,
    name,
    onCreated,
    publicClient,
    symbol,
    totalUsdc,
    writeContractAsync,
  ])

  const hint = useMemo(() => {
    if (buttonState === 'needsApproval') return 'Step 1 of 2 — approve USDC once, then create.'
    if (buttonState === 'approving') return 'Step 1 of 2 — waiting for the USDC approval to confirm.'
    if (buttonState === 'ready' && approvedThisSession) return 'Step 2 of 2 — approved. Create when you are ready.'
    return undefined
  }, [approvedThisSession, buttonState])

  return {
    launchFee,
    firstBuy,
    totalUsdc,
    buttonState,
    label,
    hint,
    isLoading: buttonState === 'approving' || buttonState === 'pending',
    isDisabled: ['insufficientBalance', 'pending'].includes(buttonState),
    txStatus,
    execute,
    usdcDecimals,
    formatFee: formatAmount(launchFee, usdcDecimals),
  }
}
