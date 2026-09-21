import { BaseError, ContractFunctionRevertedError, zeroAddress, type Address } from 'viem'

/** Rows per lens.pairs / lens.positions call. */
export const LENS_PAGE = 200n
// A 200-row page costs ~3.9M gas, so 4 pages (~16M) keep each request well under Arc's ~30M eth_call cap. The
// grouping only holds when the pages go out on a non-batching client (see lensClient.ts).
const PAGES_PER_REQUEST = 4

/** The start of every page after the first that `total` rows need, grouped one request's worth at a time. */
export function laterPageGroups(total: bigint, size = LENS_PAGE, perRequest = PAGES_PER_REQUEST): bigint[][] {
  const groups: bigint[][] = []
  for (let start = size; start < total; start += size) {
    const group = groups[groups.length - 1]
    if (group && group.length < perRequest) group.push(start)
    else groups.push([start])
  }
  return groups
}

/**
 * Reads a whole paged lens list. The first page comes with the total, so a list that fits one page costs a
 * single request; the rest are read in parallel, a few pages per request.
 */
export async function readAllPages<T>(
  readFirst: () => Promise<readonly [bigint, readonly T[]]>,
  readGroup: (starts: readonly bigint[]) => Promise<readonly (readonly T[])[]>,
): Promise<T[]> {
  const [total, first] = await readFirst()
  const rest = await Promise.all(laterPageGroups(total).map(readGroup))
  return [...first, ...rest.flat().flat()]
}

/** Why an unfunded USDC pool is kept out of the app: its launch curve is live, or the launchpad has not answered. */
export type PoolHold = 'launch' | 'unknown'

type CurveLookup =
  | { status: 'success'; result: { token: Address; graduated: boolean } }
  | { status: 'failure'; error: unknown }

export function revertErrorName(error: unknown): string | undefined {
  if (!(error instanceof BaseError)) return undefined
  const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError)
  return reverted instanceof ContractFunctionRevertedError ? reverted.data?.errorName : undefined
}

/**
 * Reads the launchpad's `curves(token)` answer for the other side of an unfunded USDC pool. Only an UnknownToken
 * revert (not a launch) or a graduated curve lets the pool show; any other failure is an RPC problem, not an answer.
 */
export function poolHold(lookup: CurveLookup | undefined): PoolHold | undefined {
  if (!lookup) return 'unknown'
  if (lookup.status === 'success') return lookup.result.token === zeroAddress || lookup.result.graduated ? undefined : 'launch'
  return revertErrorName(lookup.error) === 'UnknownToken' ? undefined : 'unknown'
}
