import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { usePublicClient, useReadContracts } from 'wagmi'
import { activeChain } from '../chain'
import { launchpadAbi, lensAbi } from '../lib/abi'
import { deployment, isDeployed, isLaunchpadDeployed } from '../lib/deployment'
import { pairKey, type AmmPair } from '../lib/amm'
import { LENS_PAGE, poolHold, readAllPages, type PoolHold } from '../lib/pairList'

export interface PairInfo extends AmmPair {
  blockTimestampLast: number
}

const isUsdc = (address: string) => address.toLowerCase() === activeChain.usdc.toLowerCase()

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
      // Every launch adds a factory pair, so the list outgrows one page.
      return readAllPages(
        () => Promise.all([
          publicClient.readContract({ address: deployment.lens, abi: lensAbi, functionName: 'pairsLength' }),
          publicClient.readContract(pairsPage(0n)),
        ]),
        (starts) => publicClient.multicall({ contracts: starts.map(pairsPage), allowFailure: false }),
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

  // Every launch reserves its USDC pool when the token is created, and that pool stays locked until the
  // curve sells out: nobody can add liquidity to it or trade through it. Such a pool is not a pool yet,
  // so it is kept out of the list and its token out of the pickers. Only never-funded USDC pools are asked about.
  const unfunded = useMemo(
    () => (isLaunchpadDeployed ? all.filter((pair) => pair.totalSupply === 0n && (isUsdc(pair.token0) || isUsdc(pair.token1))) : []),
    [all],
  )
  const curves = useReadContracts({
    contracts: unfunded.map((pair) => ({
      address: deployment.launchpad,
      abi: launchpadAbi,
      functionName: 'curves' as const,
      args: [isUsdc(pair.token0) ? pair.token1 : pair.token0] as const,
    })),
    query: {
      enabled: unfunded.length > 0,
      staleTime: 30_000,
      refetchInterval: (current) => (!current.state.data || current.state.data.some((lookup) => poolHold(lookup) === 'unknown') ? 4_000 : false),
    },
  })

  const { pairs, heldBack } = useMemo(() => {
    const held = new Map<string, PoolHold>()
    if (unfunded.length === 0) return { pairs: all, heldBack: held }
    const hidden = new Set<string>()
    unfunded.forEach((pair, index) => {
      const hold = poolHold(curves.data?.[index])
      if (!hold) return
      hidden.add(pair.pair.toLowerCase())
      held.set((isUsdc(pair.token0) ? pair.token1 : pair.token0).toLowerCase(), hold)
    })
    return { pairs: all.filter((pair) => !hidden.has(pair.pair.toLowerCase())), heldBack: held }
  }, [all, curves.data, unfunded])

  const pairMap = useMemo(
    () => new Map(pairs.map((pair) => [pairKey(pair.token0, pair.token1), pair])),
    [pairs],
  )

  return {
    pairs,
    pairMap,
    heldBack,
    isLoading: isDeployed && query.isLoading,
    error: query.error,
    refetch: query.refetch,
  }
}
