import { useMemo, useSyncExternalStore } from 'react'
import { useReadContract } from 'wagmi'
import { lensAbi, launchpadAbi } from '../lib/abi'
import { deployment, isDeployed, isLaunchpadDeployed } from '../lib/deployment'
import { asLaunchCurve, PAGE_SIZE, type LaunchRecord } from '../lib/launch'
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
  const start = length > PAGE_SIZE ? length - PAGE_SIZE : 0n
  const count = length > PAGE_SIZE ? PAGE_SIZE : length

  const pageQuery = useReadContract({
    address: deployment.launchpad,
    abi: launchpadAbi,
    functionName: 'curvesPage',
    args: [start, count],
    query: {
      enabled: !fixtureOn && isLaunchpadDeployed && lengthQuery.data !== undefined,
      refetchInterval: 4_000,
    },
  })

  const page = useMemo(() => {
    const rows = [...(pageQuery.data ?? [])].map(asLaunchCurve)
    rows.reverse()
    return rows
  }, [pageQuery.data])

  const addresses = useMemo(() => page.map((row) => row.token), [page])

  const metaQuery = useReadContract({
    address: deployment.lens,
    abi: lensAbi,
    functionName: 'tokenMeta',
    args: [addresses],
    query: {
      enabled: !fixtureOn && isDeployed && addresses.length > 0,
      staleTime: Number.POSITIVE_INFINITY,
    },
  })

  const launches = useMemo<LaunchRecord[]>(() => {
    if (fixtureOn) {
      void fixtureVersion
      return api?.list() ?? []
    }
    const meta = (metaQuery.data ?? []) as readonly TokenMetaResult[]
    const byAddress = new Map(meta.map((item) => [item.token.toLowerCase(), item]))
    return page.map((row) => {
      const item = byAddress.get(row.token.toLowerCase())
      const record: LaunchRecord = {
        ...row,
        name: item?.name || 'Launch token',
        symbol: item?.symbol || 'TOKEN',
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
  }, [api, fixtureVersion, metaQuery.data, page])

  const refetch = async () => {
    if (fixtureOn) return
    await Promise.all([lengthQuery.refetch(), pageQuery.refetch(), metaQuery.refetch()])
  }

  return {
    launches,
    isLoading: !fixtureOn && isLaunchpadDeployed && (lengthQuery.isLoading || pageQuery.isLoading),
    error: fixtureOn ? null : lengthQuery.error ?? pageQuery.error,
    refetch,
  }
}
