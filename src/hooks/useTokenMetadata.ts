import { useQuery } from '@tanstack/react-query'
import { fetchVerified, verifiedImageUrl } from '../lib/ipfs'
import { cidOfIpfsUri, parseMetadataJson, type TokenMetadata } from '../lib/tokenMetadata'

export interface TokenDetails {
  /** The launch's details file, once read and checked. Undefined while loading, or when there is none to show. */
  metadata?: TokenMetadata
  /** A `blob:` URL of the verified image, when the file names one and it could be read. */
  imageUrl?: string
}

/**
 * A launch's details, from the `ipfs://` string the launchpad stores for it. Empty when the string is
 * anything else, or the file cannot be read or does not check out: the token then shows its stamp, name
 * and symbol, which come from the chain. The content behind an address never changes, so it is read once.
 *
 * The text and the image are two reads. The words appear as soon as they are verified; they do not wait
 * for the picture, which on a first-ever view can take seconds to arrive.
 */
export function useTokenMetadata(uri: string | undefined, enabled = true): TokenDetails {
  const cid = uri ? cidOfIpfsUri(uri) : undefined
  const file = useQuery<TokenMetadata | null>({
    queryKey: ['tokenMetadata', cid],
    enabled: enabled && Boolean(cid),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 1,
    queryFn: async ({ signal }) => (cid ? (parseMetadataJson(await fetchVerified(cid, signal)) ?? null) : null),
  })

  const imageCid = file.data?.image ? cidOfIpfsUri(file.data.image) : undefined
  const image = useQuery<string | null>({
    queryKey: ['tokenImage', imageCid],
    enabled: enabled && Boolean(imageCid),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 1,
    queryFn: async ({ signal }) => (imageCid ? ((await verifiedImageUrl(imageCid, signal)) ?? null) : null),
  })

  return { metadata: file.data ?? undefined, imageUrl: image.data ?? undefined }
}
