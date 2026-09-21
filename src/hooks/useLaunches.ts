import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { useReadContract, useReadContracts } from 'wagmi'
import { launchPairAbi, launchpadAbi, lensAbi } from '../lib/abi'
import { deployment, isDeployed, isLaunchpadDeployed } from '../lib/deployment'
import { asLaunchCurve, PAGE_SIZE, type LaunchRecord } from '../lib/launch'
import { launchWindows } from '../lib/launchPages'
import { launchFixtureApi } from '../lib/launchFixtureApi'
import { rememberToken, type TokenMetaResult } from '../lib/tokens'

const fixtureOn = import.meta.env.DEV && import.meta.env.VITE_LAUNCHPAD_FIXTURE === '1'

function noopSubscribe(): () => void {
  return () => undefined
}
function zero(): number {
  return 0
}

export function useLaunches() {
  const api = launchFixtureApi()
  const fixtureVersion = useSyncExternalStore(api ? api.subscribe : noopSubscribe, api ? api.version : zero, zero)
  const [pages, setPages] = useState(1)

  const lengthQuery = useReadContract({
    address: deployment.launchpad,
    abi: launchpadAbi,
    functionName: 'tokensLength',
    query: {
      enabled: !fixtureOn && isLaunchpadDeployed,
      refetchInterval: 4_000,
    },
  })

  const length = lengthQuery.data ?? 0n
  const windows = useMemo(() => launchWindows(length, pages), [length, pages])

  const pageQuery = useReadContracts({
    allowFailure: false,
    contracts: windows.map((window) => ({
      address: deployment.launchpad,
      abi: launchpadAbi,
      functionName: 'curvesPage' as const,
      args: [window.start, window.count] as const,
    })),
    query: {
      enabled: !fixtureOn && isLaunchpadDeployed && windows.length > 0,
      refetchInterval: 4_000,
      placeholderData: (previous) => previous,
    },
  })

  const page = useMemo(
    () => (windows.length === 0 ? [] : (pageQuery.data ?? []).flatMap((rows) => [...rows].reverse().map(asLaunchCurve))),
    [pageQuery.data, windows.length],
  )

  const addresses = useMemo(() => page.map((row) => row.token), [page])

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

  // A graduated token is priced by its launch pool, not its finished curve.
  const graduated = useMemo(() => page.filter((row) => row.graduated), [page])
  const reservesQuery = useReadContracts({
    allowFailure: true,
    contracts: graduated.map((row) => ({ address: row.pair, abi: launchPairAbi, functionName: 'getReserves' as const })),
    query: {
      enabled: !fixtureOn && graduated.length > 0,
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
    return page.map((row) => {
      const item = byAddress.get(row.token.toLowerCase())
      const record: LaunchRecord = {
        ...row,
        name: item?.name || 'Launch token',
        symbol: item?.symbol || 'TOKEN',
        pool: reserves.get(row.token.toLowerCase()),
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
  }, [api, fixtureVersion, graduated, metaQuery.data, page, reservesQuery.data])

  const refetch = async () => {
    if (fixtureOn) return
    await Promise.all([lengthQuery.refetch(), pageQuery.refetch(), metaQuery.refetch(), reservesQuery.refetch()])
  }

  const hasMore = !fixtureOn && BigInt(pages) * PAGE_SIZE < length
  const isLoadingMore = pageQuery.isFetching && (pageQuery.data?.length ?? 0) < windows.length
  const loadMore = useCallback(() => setPages((current) => current + 1), [])

  return {
    launches,
    total: fixtureOn ? launches.length : Number(length),
    hasMore,
    isLoadingMore,
    loadMore,
    isLoading: !fixtureOn && isLaunchpadDeployed && (lengthQuery.isLoading || pageQuery.isLoading),
    error: fixtureOn ? null : lengthQuery.error ?? pageQuery.error,
    refetch,
  }
}
