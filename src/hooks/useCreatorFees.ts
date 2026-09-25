import { useQuery } from '@tanstack/react-query'
import { useCallback, useState, useSyncExternalStore } from 'react'
import type { Address, Hash, PublicClient } from 'viem'
import { useAccount, usePublicClient, useWriteContract } from 'wagmi'
import { activeChain } from '../chain'
import { listedPluginAt, pluginAddress, listedPlugin } from '../content/plugins/registry'
import { buybackPluginAbi, comboPluginAbi, deepenPluginAbi, launchpadAbi, launchpadWithPluginErrorsAbi, splitPluginAbi } from '../lib/abi'
import { deployment, isLaunchpadDeployed } from '../lib/deployment'
import { isUserRejection, revertReason } from '../lib/errors'
import { formatAmount, shortAddress } from '../lib/format'
import type { LaunchRecord } from '../lib/launch'
import { launchFixtureApi } from '../lib/launchFixtureApi'
import { claimCall, dividendReads, hasDividends, holderReads, type HolderDividends } from '../lib/plugins/holders'
import type { BuybackState, ComboEntryState, CreatorFeeState, DeepenState, SplitState } from '../lib/plugins/state'
import { pushRecent } from '../lib/recent'
import type { SwapTxStatus } from './useSwap'

const fixtureOn = import.meta.env.DEV && import.meta.env.VITE_LAUNCHPAD_FIXTURE === '1'

function noopSubscribe(): () => void {
  return () => undefined
}
function zero(): number {
  return 0
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

async function readSplit(client: PublicClient, plugin: Address, token: Address): Promise<SplitState> {
  const [[payees, shares], totalShares, totalReceived] = await Promise.all([
    client.readContract({ address: plugin, abi: splitPluginAbi, functionName: 'payeesOf', args: [token] }),
    client.readContract({ address: plugin, abi: splitPluginAbi, functionName: 'totalShares', args: [token] }),
    client.readContract({ address: plugin, abi: splitPluginAbi, functionName: 'totalReceived', args: [token] }),
  ])
  const [released, releasable] = await Promise.all([
    Promise.all(payees.map((payee) => client.readContract({ address: plugin, abi: splitPluginAbi, functionName: 'released', args: [token, payee] }))),
    Promise.all(payees.map((payee) => client.readContract({ address: plugin, abi: splitPluginAbi, functionName: 'releasable', args: [token, payee] }))),
  ])
  return {
    totalShares,
    totalReceived,
    payees: payees.map((address, index) => ({
      address,
      share: shares[index] ?? 0n,
      released: released[index] ?? 0n,
      releasable: releasable[index] ?? 0n,
    })),
  }
}

async function readBuyback(client: PublicClient, plugin: Address, token: Address): Promise<BuybackState> {
  const [held, totalSpent, totalBurned, preview, lastRunAt] = await Promise.all([
    client.readContract({ address: plugin, abi: buybackPluginAbi, functionName: 'usdcHeld', args: [token] }),
    client.readContract({ address: plugin, abi: buybackPluginAbi, functionName: 'totalUsdcSpent', args: [token] }),
    client.readContract({ address: plugin, abi: buybackPluginAbi, functionName: 'totalTokensBurned', args: [token] }),
    // Exact for the block it is read in: the paced budget, the per-block limit and the minimum are the plugin's own.
    client.readContract({ address: plugin, abi: buybackPluginAbi, functionName: 'previewRun', args: [token] }),
    client.readContract({ address: plugin, abi: buybackPluginAbi, functionName: 'lastRunAt', args: [token] }),
  ])
  return { held, totalSpent, totalBurned, offer: preview[0], lastRunAt }
}

async function readDeepen(client: PublicClient, plugin: Address, token: Address): Promise<DeepenState> {
  const [burnBps, held, preview, lastRunAt, totalSpent, totalBurned, totalUsdcAdded, totalTokensAdded, totalLiquidity] = await Promise.all([
    client.readContract({ address: plugin, abi: deepenPluginAbi, functionName: 'burnBpsOf', args: [token] }),
    client.readContract({ address: plugin, abi: deepenPluginAbi, functionName: 'usdcHeld', args: [token] }),
    // Exact for the block it is read in, as Buyback & burn's is, and it says how the offer divides.
    client.readContract({ address: plugin, abi: deepenPluginAbi, functionName: 'previewRun', args: [token] }),
    client.readContract({ address: plugin, abi: deepenPluginAbi, functionName: 'lastRunAt', args: [token] }),
    client.readContract({ address: plugin, abi: deepenPluginAbi, functionName: 'totalUsdcSpent', args: [token] }),
    client.readContract({ address: plugin, abi: deepenPluginAbi, functionName: 'totalTokensBurned', args: [token] }),
    client.readContract({ address: plugin, abi: deepenPluginAbi, functionName: 'totalUsdcAdded', args: [token] }),
    client.readContract({ address: plugin, abi: deepenPluginAbi, functionName: 'totalTokensAdded', args: [token] }),
    client.readContract({ address: plugin, abi: deepenPluginAbi, functionName: 'totalLiquidityLocked', args: [token] }),
  ])
  return {
    burnBps,
    held,
    offer: preview[0],
    toBurn: preview[1],
    toDeepen: preview[2],
    lastRunAt,
    totalSpent,
    totalBurned,
    totalUsdcAdded,
    totalTokensAdded,
    totalLiquidity,
  }
}

/** The token's own dividend stream, and the connected wallet's claimable part of it (live up to the read). */
async function readHolders(client: PublicClient, token: Address, account: Address | undefined): Promise<HolderDividends> {
  const reads = dividendReads(token)
  const mine = account ? holderReads(token, account) : undefined
  const [undistributed, streamRate, streamEnd, totalDistributed, eligibleSupply, you] = await Promise.all([
    client.readContract(reads[0]),
    client.readContract(reads[1]),
    client.readContract(reads[2]),
    client.readContract(reads[3]),
    client.readContract(reads[4]),
    mine ? Promise.all([client.readContract(mine[0]), client.readContract(mine[1])]) : Promise.resolve(undefined),
  ])
  return {
    undistributed,
    streamRate,
    streamEnd,
    totalDistributed,
    eligibleSupply,
    readAt: BigInt(Math.floor(Date.now() / 1_000)),
    you: you ? { balance: you[0], claimable: you[1] } : undefined,
  }
}

/**
 * The token page's view of a token's creator fees: what waits in the launchpad, and the state of its plugin. A
 * Combo is followed one level down, to the listed plugins among its entries (each serves this token too).
 * Which plugins serve the token comes only from its registered plugin, the launchpad's stored hooks flag and the
 * Combo's allocationOf (with its stored isPlugin flags), never from isConfigured or Configured events, which a
 * token's registered plugin can set on any listed plugin without changing where the fees go (V13-SPEC §9).
 */
async function readCreatorFees(client: PublicClient, launch: LaunchRecord, account: Address | undefined): Promise<CreatorFeeState> {
  const token = launch.token
  const listed = launch.pluginHooks ? listedPluginAt(launch.plugin) : undefined
  const [pending, allocation] = await Promise.all([
    client.readContract({ address: deployment.launchpad, abi: launchpadAbi, functionName: 'pendingCreatorFees', args: [token] }),
    listed?.kind === 'combo'
      ? client.readContract({ address: launch.plugin, abi: comboPluginAbi, functionName: 'allocationOf', args: [token] })
      : Promise.resolve(undefined),
  ])
  const combo: ComboEntryState[] | undefined = allocation
    ? allocation[0].map((target, index) => ({ target, bps: Number(allocation[1][index] ?? 0), isPlugin: Boolean(allocation[2][index]) }))
    : undefined
  const serves = (kind: 'split' | 'buyback' | 'deepen' | 'holders') => {
    const address = pluginAddress(listedPlugin(kind))
    if (listed?.kind === kind) return true
    return Boolean(combo?.some((entry) => entry.isPlugin && same(entry.target, address)))
  }
  const [split, buyback, deepen, dividends] = await Promise.all([
    serves('split') ? readSplit(client, pluginAddress(listedPlugin('split')), token) : Promise.resolve(undefined),
    serves('buyback') ? readBuyback(client, pluginAddress(listedPlugin('buyback')), token) : Promise.resolve(undefined),
    serves('deepen') ? readDeepen(client, pluginAddress(listedPlugin('deepen')), token) : Promise.resolve(undefined),
    // Every launch token carries dividends, and anyone can distribute to one, so they are read for every token.
    readHolders(client, token, account),
  ])
  const fromFees = serves('holders')
  const holders = fromFees || hasDividends(dividends) ? { ...dividends, fromFees } : undefined
  return { pending, split, buyback, deepen, holders, combo }
}

export type CreatorFeeAction = 'collect' | 'run' | 'deepen' | 'claim' | `release:${string}`

/** A launch token's creator fees: the state for the token page, and the actions anyone can take on them. */
export function useCreatorFees(launch: LaunchRecord | undefined, onChanged?: () => void | Promise<void>) {
  const { address: account, isConnected, chainId } = useAccount()
  const publicClient = usePublicClient()
  const { writeContractAsync } = useWriteContract()
  const api = launchFixtureApi()
  const fixtureVersion = useSyncExternalStore(api ? api.subscribe : noopSubscribe, api ? api.version : zero, zero)
  const [busy, setBusy] = useState<CreatorFeeAction>()
  const [status, setStatus] = useState<{ action: CreatorFeeAction; tx: SwapTxStatus }>()

  const query = useQuery<CreatorFeeState, Error>({
    queryKey: ['creatorFees', activeChain.id, launch?.token, launch?.plugin, account],
    enabled: !fixtureOn && isLaunchpadDeployed && Boolean(launch) && Boolean(publicClient),
    // A holder's claimable grows every second; a poll every 10s keeps it current without animating it.
    refetchInterval: 10_000,
    placeholderData: (previous) => previous,
    queryFn: () => {
      if (!publicClient || !launch) throw new Error('No RPC client for Arc')
      return readCreatorFees(publicClient, launch, account)
    },
  })

  void fixtureVersion
  const state = fixtureOn ? (launch ? api?.creatorFees(launch.token, account) : undefined) : query.data

  const act = useCallback(
    async (action: CreatorFeeAction, summary: string, send: () => Promise<Hash>, fixture: () => Hash) => {
      if (!account || busy) return
      setBusy(action)
      setStatus({ action, tx: { kind: 'pending' } })
      try {
        let hash: Hash
        if (fixtureOn) {
          hash = fixture()
        } else {
          if (!publicClient) return
          hash = await send()
          setStatus({ action, tx: { kind: 'pending', hash } })
          const receipt = await publicClient.waitForTransactionReceipt({ hash })
          if (receipt.status !== 'success') throw new Error('Transaction reverted')
        }
        setStatus({ action, tx: { kind: 'confirmed', hash, summary } })
        pushRecent(activeChain.id, { hash, kind: 'launch', summary })
        await Promise.all([fixtureOn ? undefined : query.refetch(), onChanged?.()])
      } catch (error) {
        setStatus({ action, tx: isUserRejection(error) ? { kind: 'cancelled' } : { kind: 'failed', reason: revertReason(error) } })
      } finally {
        setBusy(undefined)
      }
    },
    [account, busy, onChanged, publicClient, query, setBusy, setStatus],
  )

  const token = launch?.token
  const symbol = launch?.symbol ?? 'token'

  const collect = useCallback(() => {
    if (!token || !launch) return Promise.resolve()
    const amount = state?.pending ?? 0n
    return act(
      'collect',
      `Collected ${formatAmount(amount, 6)} USDC of ${symbol} creator fees`,
      () =>
        writeContractAsync({
          chainId: activeChain.id,
          address: deployment.launchpad,
          // onFees runs inside the collection: plugin errors are in this ABI so a refusal decodes.
          abi: launchpadWithPluginErrorsAbi,
          functionName: 'collectCreatorFees',
          args: [token],
        }),
      () => api!.collect(token),
    )
  }, [act, api, launch, state?.pending, symbol, token, writeContractAsync])

  const release = useCallback(
    (payee: Address) => {
      if (!token) return Promise.resolve()
      const owed = state?.split?.payees.find((row) => same(row.address, payee))?.releasable ?? 0n
      return act(
        `release:${payee.toLowerCase()}`,
        `Released ${formatAmount(owed, 6)} USDC to ${shortAddress(payee)}`,
        () =>
          writeContractAsync({
            chainId: activeChain.id,
            address: pluginAddress(listedPlugin('split')),
            abi: splitPluginAbi,
            functionName: 'release',
            args: [token, payee],
          }),
        () => api!.release(token, payee),
      )
    },
    [act, api, state?.split?.payees, token, writeContractAsync],
  )

  const runBuyback = useCallback(() => {
    if (!token) return Promise.resolve()
    return act(
      'run',
      `Ran a ${symbol} buyback with ${formatAmount(state?.buyback?.offer ?? 0n, 6)} USDC`,
      () =>
        writeContractAsync({
          chainId: activeChain.id,
          address: pluginAddress(listedPlugin('buyback')),
          abi: buybackPluginAbi,
          functionName: 'run',
          args: [token],
        }),
      () => api!.runBuyback(token),
    )
  }, [act, api, state?.buyback?.offer, symbol, token, writeContractAsync])

  const runDeepen = useCallback(() => {
    if (!token) return Promise.resolve()
    return act(
      'deepen',
      `Ran Deepen pool for ${symbol} with ${formatAmount(state?.deepen?.offer ?? 0n, 6)} USDC`,
      () =>
        writeContractAsync({
          chainId: activeChain.id,
          address: pluginAddress(listedPlugin('deepen')),
          abi: deepenPluginAbi,
          functionName: 'run',
          args: [token],
        }),
      () => api!.runDeepen(token),
    )
  }, [act, api, state?.deepen?.offer, symbol, token, writeContractAsync])

  // The wallet claims its own dividends on the token. What it earns keeps growing until the claim lands, so the
  // amount shown when pressed is "about".
  const claim = useCallback(
    (amount: bigint) => {
      if (!token || !account) return Promise.resolve()
      return act(
        'claim',
        `Claimed about ${formatAmount(amount, 6)} USDC of ${symbol} dividends`,
        () => writeContractAsync({ chainId: activeChain.id, ...claimCall(token) }),
        () => api!.claim(token, account),
      )
    },
    [account, act, api, symbol, token, writeContractAsync],
  )

  return {
    state,
    isLoading: !fixtureOn && query.isPending,
    error: fixtureOn ? null : query.data ? null : query.error,
    busy,
    status,
    canAct: Boolean(isConnected && account && chainId === activeChain.id),
    collect,
    release,
    runBuyback,
    runDeepen,
    claim,
  }
}
