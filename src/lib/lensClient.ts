import { createPublicClient, http } from 'viem'
import { activeChain, activeViemChain } from '../chain'

/**
 * For paged lens reads. The wagmi client batches every call issued in the same tick into one multicall, which
 * would merge all pages back into a single eth_call and blow the RPC's gas cap (~30M on Arc) once the factory
 * holds ~1,700 pairs. Without batching, each group of pages is its own request.
 */
export const lensClient = createPublicClient({ chain: activeViemChain, transport: http(activeChain.rpc) })
