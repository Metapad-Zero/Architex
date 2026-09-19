import { useMemo } from 'react'
import type { Address } from 'viem'
import { useReadContract } from 'wagmi'
import { lensAbi } from '../lib/abi'
import { deployment, isDeployed } from '../lib/deployment'

export interface PositionInfo {
  pair: Address
  token0: Address
  token1: Address
  lpBalance: bigint
  lpTotalSupply: bigint
  reserve0: bigint
  reserve1: bigint
  routerAllowance: bigint
}

export function usePositions(owner: Address | undefined) {
  const query = useReadContract({
    address: deployment.lens,
    abi: lensAbi,
    functionName: 'positions',
    args: [owner!, 0n, 200n],
    query: {
      enabled: isDeployed && Boolean(owner),
      refetchInterval: 4_000,
    },
  })
  const positions = useMemo<PositionInfo[]>(
    () =>
      (query.data ?? []).map((position) => ({
        pair: position.pair,
        token0: position.token0,
        token1: position.token1,
        lpBalance: position.lpBalance,
        lpTotalSupply: position.lpTotalSupply,
        reserve0: position.reserve0,
        reserve1: position.reserve1,
        routerAllowance: position.routerAllowance,
      })),
    [query.data],
  )
  return { positions, isLoading: query.isLoading, error: query.error, refetch: query.refetch }
}
