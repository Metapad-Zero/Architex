import { useMemo } from 'react'
import { useReadContract } from 'wagmi'
import { lensAbi } from '../lib/abi'
import { buildTokenRegistry, type TokenMetaResult } from '../lib/tokens'
import { deployment, isDeployed } from '../lib/deployment'
import type { AmmPair } from '../lib/amm'

export function useTokens(pairs: readonly AmmPair[]) {
  const provisional = useMemo(() => buildTokenRegistry(pairs), [pairs])
  const addresses = useMemo(() => provisional.map((token) => token.address), [provisional])
  const query = useReadContract({
    address: deployment.lens,
    abi: lensAbi,
    functionName: 'tokenMeta',
    args: [addresses],
    query: {
      enabled: isDeployed && addresses.length > 0,
      staleTime: Number.POSITIVE_INFINITY,
    },
  })

  const metadata = useMemo(() => (query.data ?? []) as readonly TokenMetaResult[], [query.data])
  const tokens = useMemo(() => buildTokenRegistry(pairs, metadata), [pairs, metadata])

  return { tokens, isLoading: query.isLoading, error: query.error }
}
