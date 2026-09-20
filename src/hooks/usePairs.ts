import { useMemo } from 'react'
import { zeroAddress } from 'viem'
import { useReadContract, useReadContracts } from 'wagmi'
import { activeChain } from '../chain'
import { launchpadAbi, lensAbi } from '../lib/abi'
import { deployment, isDeployed, isLaunchpadDeployed } from '../lib/deployment'
import { pairKey, type AmmPair } from '../lib/amm'

export interface PairInfo extends AmmPair {
  blockTimestampLast: number
}

const isUsdc = (address: string) => address.toLowerCase() === activeChain.usdc.toLowerCase()

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
    query: { enabled: unfunded.length > 0, staleTime: 30_000 },
  })

  const pairs = useMemo<PairInfo[]>(() => {
    if (unfunded.length === 0) return all
    const hidden = new Set<string>()
    unfunded.forEach((pair, index) => {
      const result = curves.data?.[index]
      // Until the launchpad has answered, an unfunded USDC pool is held back rather than flashed and removed.
      if (!result) hidden.add(pair.pair.toLowerCase())
      else if (result.status === 'success' && result.result.token !== zeroAddress && !result.result.graduated) hidden.add(pair.pair.toLowerCase())
    })
    return all.filter((pair) => !hidden.has(pair.pair.toLowerCase()))
  }, [all, curves.data, unfunded])

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
