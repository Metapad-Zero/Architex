import { useCallback, useEffect, useMemo, useState } from 'react'
import { parseEventLogs, type Address, type Hex } from 'viem'
import { useAccount, usePublicClient, useReadContract, useWriteContract } from 'wagmi'
import { activeChain } from '../chain'
import { erc20Abi, launchpadAbi, launchpadWithPluginErrorsAbi } from '../lib/abi'
import { allowanceLagging, createButtonState, type CreateButtonState } from '../lib/createButton'
import { INITIAL_CURVE, quoteBuy } from '../lib/curve'
import { deployment, isLaunchpadDeployed, launchSuite } from '../lib/deployment'
import { isUserRejection, revertReason } from '../lib/errors'
import { formatAmount } from '../lib/format'
import { minReceived } from '../lib/amm'
import { pushRecent } from '../lib/recent'
import { launchFixtureApi } from '../lib/launchFixtureApi'
import { spendableBalance } from '../lib/gasReserve'
import type { PluginPlan } from '../lib/plugins/plan'
import type { SwapTxStatus } from './useSwap'

const fixtureOn = import.meta.env.DEV && import.meta.env.VITE_LAUNCHPAD_FIXTURE === '1'
// Stops the button waiting forever if the allowance read never shows the approval.
const ALLOWANCE_CATCH_UP_MS = 30_000

interface UseCreateTokenArgs {
  name: string
  symbol: string
  metadataURI: string
  /** Creator fee in bps, 0–1000; the creator's own first buy pays it too [D3]. */
  creatorFeeBps: number
  /** Where the fees go and the plugin's onLaunch data (lib/plugins/plan.ts), or undefined while the choice has problems. */
  pluginPlan: PluginPlan | undefined
  valid: boolean
  initialBuyUsdc: bigint
  slippageBps: number
  usdcBalance: bigint
  usdcAllowance: bigint
  usdcDecimals: number
  onApproved: () => void | Promise<void>
  onCreated: (token: Address) => void
}

export function useCreateToken({
  name,
  symbol,
  metadataURI,
  creatorFeeBps,
  pluginPlan,
  valid,
  initialBuyUsdc,
  slippageBps,
  usdcBalance,
  usdcAllowance,
  usdcDecimals,
  onApproved,
  onCreated,
}: UseCreateTokenArgs) {
  const { address: account, isConnected, chainId } = useAccount()
  const publicClient = usePublicClient()
  const { writeContractAsync } = useWriteContract()
  const [phase, setPhase] = useState<'idle' | 'approving' | 'pending'>('idle')
  const [txStatus, setTxStatus] = useState<SwapTxStatus | undefined>()
  const [approvedThisSession, setApprovedThisSession] = useState(false)
  const [approval, setApproval] = useState<{ owner: Address; amount: bigint }>()
  const approvedAmount = approval?.owner === account ? approval?.amount : undefined

  const feeQuery = useReadContract({
    address: deployment.launchpad,
    abi: launchpadAbi,
    functionName: 'launchFee',
    query: {
      enabled: !fixtureOn && isLaunchpadDeployed,
      staleTime: 30_000,
      refetchInterval: (query) => (query.state.data === undefined ? 4_000 : 30_000),
    },
  })

  const feeKnown = fixtureOn || feeQuery.data !== undefined
  const launchFee = fixtureOn ? (launchFixtureApi()?.launchFee() ?? 0n) : (feeQuery.data ?? 0n)
  const firstBuy = useMemo(() => {
    if (initialBuyUsdc <= 0n) return undefined
    try {
      return quoteBuy(INITIAL_CURVE, initialBuyUsdc, creatorFeeBps)
    } catch {
      return undefined
    }
  }, [creatorFeeBps, initialBuyUsdc])
  // A first buy too small to buy anything (the fees eat it) would revert the whole launch.
  const firstBuyInvalid = initialBuyUsdc > 0n && !firstBuy

  // The launchpad pulls the launch fee, then exactly the first buy's usdcSpent: approve the sum, nothing more.
  const totalUsdc = launchFee + (firstBuy?.usdcSpent ?? 0n)
  const minTokensOut = firstBuy ? minReceived(firstBuy.tokensOut, slippageBps) : 0n

  const lagging = allowanceLagging(usdcAllowance, approvedAmount)
  useEffect(() => {
    if (!lagging) return
    const timer = setTimeout(() => setApproval(undefined), ALLOWANCE_CATCH_UP_MS)
    return () => clearTimeout(timer)
  }, [lagging])

  const buttonState = useMemo<CreateButtonState>(
    () =>
      createButtonState({
        connected: isConnected && Boolean(account),
        onActiveChain: chainId === activeChain.id,
        phase,
        valid: valid && Boolean(pluginPlan) && !firstBuyInvalid,
        feeKnown,
        spendable: spendableBalance(activeChain.usdc, usdcBalance),
        totalUsdc,
        allowance: usdcAllowance,
        approvedAmount,
      }),
    [account, approvedAmount, chainId, feeKnown, firstBuyInvalid, isConnected, phase, pluginPlan, totalUsdc, usdcAllowance, usdcBalance, valid],
  )

  const label = useMemo(() => {
    switch (buttonState) {
      case 'disconnected':
        return 'Connect wallet'
      case 'wrongChain':
        return activeChain.isTestnet ? 'Switch to Arc Testnet' : 'Switch to Arc'
      case 'invalid':
        return 'Create token'
      case 'loadingFee':
        return 'Loading launch fee…'
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
    if (!account || !pluginPlan) return
    const uri = savedDetails ?? metadataURI
    setTxStatus(undefined)
    try {
      if (buttonState === 'needsApproval') {
        setPhase('approving')
        if (fixtureOn) {
          launchFixtureApi()?.approve(account, activeChain.usdc, launchSuite.launchpad, totalUsdc)
        } else {
          if (!publicClient) return
          const hash = await writeContractAsync({
            chainId: activeChain.id,
            address: activeChain.usdc,
            abi: erc20Abi,
            functionName: 'approve',
            args: [deployment.launchpad, totalUsdc],
          })
          const receipt = await publicClient.waitForTransactionReceipt({ hash })
          if (receipt.status !== 'success') throw new Error('Transaction reverted')
        }
        setApproval({ owner: account, amount: totalUsdc })
        setPhase('idle')
        setApprovedThisSession(true)
        await onApproved()
        return
      }
      if (buttonState !== 'ready') return
      setApproval(undefined)
      setPhase('pending')
      setTxStatus({ kind: 'pending' })
      let token: Address
      let hash: Hex
      if (fixtureOn) {
        const api = launchFixtureApi()
        if (!api) return
        const result = api.create(account, {
          name,
          symbol,
          metadataURI: uri,
          creatorFeeBps,
          plugin: pluginPlan.plugin,
          pluginData: pluginPlan.pluginData,
          initialBuyUsdc,
          maxLaunchFee: launchFee,
        })
        token = result.token
        hash = result.hash
      } else {
        if (!publicClient) return
        hash = await writeContractAsync({
          chainId: activeChain.id,
          address: deployment.launchpad,
          // The plugin's onLaunch runs inside createToken: its errors are in this ABI so a refusal decodes.
          abi: launchpadWithPluginErrorsAbi,
          functionName: 'createToken',
          // maxLaunchFee is the fee this form showed [D22]: if it was raised since, the launch reverts, never overpays.
          args: [name, symbol, uri, creatorFeeBps, pluginPlan.plugin, pluginPlan.pluginData, initialBuyUsdc, minTokensOut, launchFee],
        })
        setTxStatus({ kind: 'pending', hash })
        const receipt = await publicClient.waitForTransactionReceipt({ hash })
        if (receipt.status !== 'success') throw new Error('Transaction reverted')
        const created = parseEventLogs({ abi: launchpadAbi, logs: receipt.logs, eventName: 'TokenCreated' })
        const found = created.find((log) => log.address.toLowerCase() === deployment.launchpad.toLowerCase())?.args.token
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
    creatorFeeBps,
    initialBuyUsdc,
    launchFee,
    metadataURI,
    minTokensOut,
    name,
    onApproved,
    onCreated,
    pluginPlan,
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
    feeKnown,
    firstBuy,
    firstBuyInvalid,
    totalUsdc,
    buttonState,
    label,
    hint,
    isLoading: buttonState === 'approving' || buttonState === 'pending',
    isDisabled: ['loadingFee', 'insufficientBalance', 'pending'].includes(buttonState),
    txStatus,
    execute,
    usdcDecimals,
    formatFee: formatAmount(launchFee, usdcDecimals),
  }
}
