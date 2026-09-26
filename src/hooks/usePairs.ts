import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { usePublicClient, useReadContracts } from 'wagmi'
import { activeChain } from '../chain'
import { launchpadAbi, launchpadV14Abi, lensAbi } from '../lib/abi'
import { deployment, isDeployed, isLaunchpadDeployed, isLaunchpadV14Deployed, launchSuiteV14 } from '../lib/deployment'
import { pairKey, type AmmPair } from '../lib/amm'
import { lensClient } from '../lib/lensClient'
import { combineLaunchLookups, LENS_PAGE, readAllPages, withoutLaunchPools, type LaunchLookup } from '../lib/pairList'
import { isCanonicalToken } from '../lib/tokens'

export interface PairInfo extends AmmPair {
  blockTimestampLast: number
}

const pairsPage = (start: bigint) =>
  ({ address: deployment.lens, abi: lensAbi, functionName: 'pairs', args: [start, LENS_PAGE] }) as const

export function usePairs() {
  const publicClient = usePublicClient()
  const query = useQuery({
    queryKey: ['pairs', activeChain.id, deployment.lens],
    enabled: isDeployed && Boolean(publicClient),
    refetchInterval: 4_000,
    queryFn: () => {
      if (!publicClient) throw new Error('No RPC client for Arc')
      return readAllPages(
        () => Promise.all([
          publicClient.readContract({ address: deployment.lens, abi: lensAbi, functionName: 'pairsLength' }),
          publicClient.readContract(pairsPage(0n)),
        ]),
        (starts) => lensClient.multicall({ contracts: starts.map(pairsPage), allowFailure: false }),
      )
    },
  })

  const all = useMemo<PairInfo[]>(
    () =>
      (query.data ?? []).map((pair) => ({
        pair: pair.pair,
        token0: pair.token0,
        token1: pair.token1,
        reserve0: pair.reserve0,
        reserve1: pair.reserve1,
        blockTimestampLast: pair.blockTimestampLast,
        totalSupply: pair.totalSupply,
      })),
    [query.data],
  )

  // Launch tokens trade in their own pools, never through a core pool (see withoutLaunchPools): v1.3's launch
  // pools, v1.4's Uniswap pools. Only tokens that are not in the deployment list are asked about, of every launchpad
  // here, once each; the answer never changes, so it is not polled once every token has one.
  const candidates = useMemo(
    () =>
      isLaunchpadDeployed || isLaunchpadV14Deployed
        ? [...new Set(all.flatMap((pair) => [pair.token0, pair.token1]).filter((token) => !isCanonicalToken(token)).map((token) => token.toLowerCase()))]
        : [],
    [all],
  )
  const lookups = useReadContracts({
    contracts: candidates.map((token) => ({
      address: deployment.launchpad,
      abi: launchpadAbi,
      functionName: 'pluginOf' as const,
      args: [token as `0x${string}`] as const,
    })),
    query: {
      enabled: isLaunchpadDeployed && candidates.length > 0,
      staleTime: Number.POSITIVE_INFINITY,
      refetchInterval: (current) => (!current.state.data || current.state.data.some((lookup) => lookup.status !== 'success') ? 4_000 : false),
    },
  })
  const lookupsV14 = useReadContracts({
    contracts: candidates.map((token) => ({
      address: launchSuiteV14.launchpad,
      abi: launchpadV14Abi,
      functionName: 'pluginOf' as const,
      args: [token as `0x${string}`] as const,
    })),
    query: {
      enabled: isLaunchpadV14Deployed && candidates.length > 0,
      staleTime: Number.POSITIVE_INFINITY,
      refetchInterval: (current) => (!current.state.data || current.state.data.some((lookup) => lookup.status !== 'success') ? 4_000 : false),
    },
  })

  const pairs = useMemo(() => {
    const answers = [
      ...(isLaunchpadDeployed ? [lookups.data as readonly LaunchLookup[] | undefined] : []),
      ...(isLaunchpadV14Deployed ? [lookupsV14.data as readonly LaunchLookup[] | undefined] : []),
    ]
    return withoutLaunchPools(all, candidates, answers.length === 1 ? answers[0] : combineLaunchLookups(answers, candidates.length))
  }, [all, candidates, lookups.data, lookupsV14.data])

  const pairMap = useMemo(
    () => new Map(pairs.map((pair) => [pairKey(pair.token0, pair.token1), pair])),
    [pairs],
  )

  return {
    pairs,
    pairMap,
    isLoading: isDeployed && query.isLoading,
    error: query.error,
    refetch: query.refetch,
  }
}
