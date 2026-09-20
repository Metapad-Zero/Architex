import { useQuery } from '@tanstack/react-query'
import { fetchVerified, verifiedImageUrl } from '../lib/ipfs'
import { cidOfIpfsUri, parseMetadataJson, type TokenMetadata } from '../lib/tokenMetadata'

export interface TokenDetails {
  metadata: TokenMetadata
  /** A `blob:` URL of the verified image, when the file names one and it could be read. */
  imageUrl?: string
}

/**
 * A launch's details, from the `ipfs://` string the launchpad stores for it. Null when the string is
 * anything else, or the file cannot be read or does not check out: the token then shows its stamp, name
 * and symbol, which come from the chain. The content behind an address never changes, so it is read once.
 */
export function useTokenMetadata(uri: string | undefined, enabled = true) {
  const cid = uri ? cidOfIpfsUri(uri) : undefined
  return useQuery<TokenDetails | null>({
    queryKey: ['tokenMetadata', cid],
    enabled: enabled && Boolean(cid),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 1,
    queryFn: async ({ signal }) => {
      if (!cid) return null
      const metadata = parseMetadataJson(await fetchVerified(cid, signal))
      if (!metadata) return null
      const imageCid = metadata.image ? cidOfIpfsUri(metadata.image) : undefined
      const imageUrl = imageCid ? await verifiedImageUrl(imageCid, signal).catch(() => undefined) : undefined
      return { metadata, imageUrl }
    },
  })
}
