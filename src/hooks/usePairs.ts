import { useMemo } from 'react'
import { useReadContract } from 'wagmi'
import { lensAbi } from '../lib/abi'
import { deployment, isDeployed } from '../lib/deployment'
import { pairKey, type AmmPair } from '../lib/amm'

export interface PairInfo extends AmmPair {
  blockTimestampLast: number
}

export function usePairs() {
  const query = useReadContract({
    address: deployment.lens,
    abi: lensAbi,
    functionName: 'pairs',
    args: [0n, 200n],
    query: {
      enabled: isDeployed,
      refetchInterval: 4_000,
    },
  })

  const pairs = useMemo<PairInfo[]>(
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
