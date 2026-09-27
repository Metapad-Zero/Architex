import { useMemo } from 'react'
import type { Address } from 'viem'
import { useReadContract } from 'wagmi'
import { lensAbi } from '../lib/abi'
import { deployment, isDeployed } from '../lib/deployment'
import type { Token } from '../lib/tokens'

export function useBalances(owner: Address | undefined, tokens: readonly Token[]) {
  const addresses = useMemo(() => tokens.map((token) => token.address), [tokens])
  const query = useReadContract({
    address: deployment.lens,
    abi: lensAbi,
    functionName: 'balances',
    args: [owner!, addresses],
    query: {
      enabled: isDeployed && Boolean(owner) && addresses.length > 0,
      refetchInterval: 4_000,
    },
  })
  const balances = useMemo(
    // An absent entry means unread; only a successful wallet read can establish a zero.
    () => new Map<string, bigint>(owner && query.isSuccess
      ? addresses.flatMap((address, index) => {
          const balance = query.data?.[index]
          return balance === undefined ? [] : [[address.toLowerCase(), balance] as const]
        })
      : []),
    [addresses, owner, query.data, query.isSuccess],
  )
  return { balances, isLoading: query.isLoading, error: query.error, refetch: query.refetch }
}
