import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { useReadContract, useReadContracts } from 'wagmi'
import { activeChain } from '../chain'
import { launchPairAbi, launchpadAbi, launchpadV14Abi, lensAbi, stateViewAbi } from '../lib/abi'
import { deployment, isDeployed, isLaunchpadDeployed, isLaunchpadV14Deployed, launchSuiteV14 } from '../lib/deployment'
import { asLaunchCurve, asLaunchCurveV14, launchVersion, PAGE_SIZE, type LaunchRecord } from '../lib/launch'
import { launchWindows, mergeNewestFirst } from '../lib/launchPages'
import { launchFixtureApi } from '../lib/launchFixtureApi'
import { launchPoolKey, poolIdOf, usdcIsCurrency0 } from '../lib/launchV14'
import { rememberToken, type TokenMetaResult } from '../lib/tokens'

const fixtureOn = import.meta.env.DEV && import.meta.env.VITE_LAUNCHPAD_FIXTURE === '1'

function noopSubscribe(): () => void {
  return () => undefined
}
function zero(): number {
  return 0
}

/**
 * Every launch, newest first, from both launchpads while v1.4 runs beside v1.3: each is read a page at a time, newest
 * first, and the two are merged so that no launch shows ahead of a newer one still unread (lib/launchPages.ts).
 */
export function useLaunches() {
  const api = launchFixtureApi()
  const fixtureVersion = useSyncExternalStore(api ? api.subscribe : noopSubscribe, api ? api.version : zero, zero)
  const [pages, setPages] = useState(1)
  const v13On = !fixtureOn && isLaunchpadDeployed
  const v14On = !fixtureOn && isLaunchpadV14Deployed

  const lengthQuery = useReadContract({
    address: deployment.launchpad,
    abi: launchpadAbi,
    functionName: 'tokensLength',
    query: {
      enabled: v13On,
      refetchInterval: 4_000,
    },
  })
  const lengthV14Query = useReadContract({
    address: launchSuiteV14.launchpad,
    abi: launchpadV14Abi,
    functionName: 'tokensLength',
    query: {
      enabled: v14On,
      refetchInterval: 4_000,
    },
  })

  const length = lengthQuery.data ?? 0n
  const lengthV14 = lengthV14Query.data ?? 0n
  const windows = useMemo(() => launchWindows(length, pages), [length, pages])
  const windowsV14 = useMemo(() => launchWindows(lengthV14, pages), [lengthV14, pages])

  const pageQuery = useReadContracts({
    allowFailure: false,
    contracts: windows.map((window) => ({
      address: deployment.launchpad,
      abi: launchpadAbi,
      functionName: 'curvesPage' as const,
      args: [window.start, window.count] as const,
    })),
    query: {
      enabled: v13On && windows.length > 0,
      refetchInterval: 4_000,
      placeholderData: (previous) => previous,
    },
  })
  const pageV14Query = useReadContracts({
    allowFailure: false,
    contracts: windowsV14.map((window) => ({
      address: launchSuiteV14.launchpad,
      abi: launchpadV14Abi,
      functionName: 'curvesPage' as const,
      args: [window.start, window.count] as const,
    })),
    query: {
      enabled: v14On && windowsV14.length > 0,
      refetchInterval: 4_000,
      placeholderData: (previous) => previous,
    },
  })

  const page = useMemo(
    () => (windows.length === 0 ? [] : (pageQuery.data ?? []).flatMap((rows) => [...rows].reverse().map(asLaunchCurve))),
    [pageQuery.data, windows.length],
  )
  const pageV14 = useMemo(
    () => (windowsV14.length === 0 ? [] : (pageV14Query.data ?? []).flatMap((rows) => [...rows].reverse().map(asLaunchCurveV14))),
    [pageV14Query.data, windowsV14.length],
  )
  const hasMoreV13 = v13On && BigInt(pages) * PAGE_SIZE < length
  const hasMoreV14 = v14On && BigInt(pages) * PAGE_SIZE < lengthV14
  const merged = useMemo(
    () => mergeNewestFirst([{ rows: pageV14, hasMore: hasMoreV14 }, { rows: page, hasMore: hasMoreV13 }]),
    [hasMoreV13, hasMoreV14, page, pageV14],
  )
  const rows = merged.rows

  const addresses = useMemo(() => rows.map((row) => row.token), [rows])

  const metaQuery = useReadContract({
    address: deployment.lens,
    abi: lensAbi,
    functionName: 'tokenMeta',
    args: [addresses],
    query: {
      enabled: !fixtureOn && isDeployed && addresses.length > 0,
      staleTime: Number.POSITIVE_INFINITY,
      placeholderData: (previous) => previous,
    },
  })

  // A graduated token is priced by its pool, not its finished curve: v1.3's launch pool reserves, or v1.4's Uniswap
  // pool price (StateView, by the pool id its key gives: the hook's own _keyFor).
  const graduated = useMemo(() => rows.filter((row) => row.graduated && launchVersion(row) === 'v13'), [rows])
  const reservesQuery = useReadContracts({
    allowFailure: true,
    contracts: graduated.map((row) => ({ address: row.pair, abi: launchPairAbi, functionName: 'getReserves' as const })),
    query: {
      enabled: !fixtureOn && graduated.length > 0,
      refetchInterval: 8_000,
      placeholderData: (previous) => previous,
    },
  })
  const graduatedV14 = useMemo(
    () =>
      rows
        .filter((row) => row.graduated && launchVersion(row) === 'v14')
        .map((row) => ({ token: row.token, poolId: poolIdOf(launchPoolKey(row.token, activeChain.usdc, launchSuiteV14.hook)) })),
    [rows],
  )
  const slot0Query = useReadContracts({
    allowFailure: true,
    contracts: graduatedV14.map((row) => ({
      address: launchSuiteV14.stateView,
      abi: stateViewAbi,
      functionName: 'getSlot0' as const,
      args: [row.poolId] as const,
    })),
    query: {
      enabled: v14On && graduatedV14.length > 0,
      refetchInterval: 8_000,
      placeholderData: (previous) => previous,
    },
  })

  const launches = useMemo<LaunchRecord[]>(() => {
    if (fixtureOn) {
      void fixtureVersion
      return api?.list() ?? []
    }
    const meta = (metaQuery.data ?? []) as readonly TokenMetaResult[]
    const byAddress = new Map(meta.map((item) => [item.token.toLowerCase(), item]))
    const reserves = new Map<string, { reserveToken: bigint; reserveUsdc: bigint }>()
    graduated.forEach((row, index) => {
      const result = reservesQuery.data?.[index]
      if (result?.status === 'success') reserves.set(row.token.toLowerCase(), { reserveToken: result.result[0], reserveUsdc: result.result[1] })
    })
    const pools = new Map<string, LaunchRecord['v4']>()
    graduatedV14.forEach((row, index) => {
      const result = slot0Query.data?.[index]
      if (result?.status !== 'success' || result.result[0] === 0n) return
      // The list prices the pool only; its opening block (for its snipe window) is read on the token's page.
      pools.set(row.token.toLowerCase(), {
        poolId: row.poolId,
        sqrtPriceX96: result.result[0],
        usdcIs0: usdcIsCurrency0(activeChain.usdc, row.token),
        openBlock: 0n,
      })
    })
    return rows.map((row) => {
      const item = byAddress.get(row.token.toLowerCase())
      const record: LaunchRecord = {
        ...row,
        name: item?.name || 'Launch token',
        symbol: item?.symbol || 'TOKEN',
        pool: reserves.get(row.token.toLowerCase()),
        v4: pools.get(row.token.toLowerCase()),
      }
      rememberToken({
        address: record.token,
        name: record.name,
        symbol: record.symbol,
        decimals: 18,
        faucet: false,
        isLaunch: true,
      })
      return record
    })
  }, [api, fixtureVersion, graduated, graduatedV14, metaQuery.data, reservesQuery.data, rows, slot0Query.data])

  // A manual refetch runs even a disabled query, so only the reads that apply here are asked for.
  const refetch = async () => {
    if (fixtureOn) return
    await Promise.all([
      v13On ? lengthQuery.refetch() : undefined,
      v13On && windows.length > 0 ? pageQuery.refetch() : undefined,
      v14On ? lengthV14Query.refetch() : undefined,
      v14On && windowsV14.length > 0 ? pageV14Query.refetch() : undefined,
      isDeployed && addresses.length > 0 ? metaQuery.refetch() : undefined,
      graduated.length > 0 ? reservesQuery.refetch() : undefined,
      v14On && graduatedV14.length > 0 ? slot0Query.refetch() : undefined,
    ])
  }

  const hasMore = !fixtureOn && (hasMoreV13 || hasMoreV14)
  const isLoadingMore =
    (pageQuery.isFetching && (pageQuery.data?.length ?? 0) < windows.length)
    || (pageV14Query.isFetching && (pageV14Query.data?.length ?? 0) < windowsV14.length)
  const loadMore = useCallback(() => setPages((current) => current + 1), [])

  return {
    launches,
    total: fixtureOn ? launches.length : Number(length + lengthV14),
    hasMore,
    isLoadingMore,
    loadMore,
    isLoading:
      (v13On && (lengthQuery.isLoading || pageQuery.isLoading)) || (v14On && (lengthV14Query.isLoading || pageV14Query.isLoading)),
    error: fixtureOn ? null : lengthQuery.error ?? pageQuery.error ?? lengthV14Query.error ?? pageV14Query.error,
    refetch,
  }
}
