import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Address } from 'viem'
import { usePublicClient } from 'wagmi'
import { activeChain } from '../chain'
import { lensAbi } from '../lib/abi'
import { deployment, isDeployed } from '../lib/deployment'
import { lensClient } from '../lib/lensClient'
import { LENS_PAGE, readAllPages } from '../lib/pairList'

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
  const publicClient = usePublicClient()
  const query = useQuery({
    queryKey: ['positions', activeChain.id, deployment.lens, owner],
    enabled: isDeployed && Boolean(owner) && Boolean(publicClient),
    refetchInterval: 4_000,
    queryFn: () => {
      if (!publicClient || !owner) throw new Error('No RPC client or owner')
      const page = (start: bigint) =>
        ({ address: deployment.lens, abi: lensAbi, functionName: 'positions', args: [owner, start, LENS_PAGE] }) as const
      return readAllPages(
        () => Promise.all([
          publicClient.readContract({ address: deployment.lens, abi: lensAbi, functionName: 'pairsLength' }),
          publicClient.readContract(page(0n)),
        ]),
        (starts) => lensClient.multicall({ contracts: starts.map(page), allowFailure: false }),
      )
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
