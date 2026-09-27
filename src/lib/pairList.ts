import { zeroAddress, type Address } from 'viem'

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

/** The launchpad's `pluginOf(token)` answer: a launch token has a plugin, any other token the zero address. */
export type LaunchLookup = { status: 'success'; result: Address } | { status: 'failure'; error: unknown }

/**
 * Core pools that hold a launch token are kept out of Swap and Pools. Since v1.3 a launch token's own pool lives in
 * the launch-pair factory, and it trades against USDC only, through the launch router, which charges its creator
 * fee [D12]. Anyone can still pair it in a core pool (V13-SPEC §9: trades there skip the creator fee, and that
 * pool's dividends can be taken from it), but the site does not route through one. `pluginOf` never reverts, so a
 * token is shown only once the launchpad has answered that it is not a launch; a failed read holds it back.
 *
 * `candidates` are the lowercased tokens that were asked about (every non-deployment token), in lookup order.
 */
export function withoutLaunchPools<P extends { token0: Address; token1: Address }>(
  pairs: readonly P[],
  candidates: readonly string[],
  lookups: readonly (LaunchLookup | undefined)[] | undefined,
): P[] {
  if (candidates.length === 0) return [...pairs]
  const shown = new Set<string>()
  candidates.forEach((token, index) => {
    const lookup = lookups?.[index]
    if (lookup?.status === 'success' && lookup.result === zeroAddress) shown.add(token)
  })
  const asked = new Set(candidates)
  const allowed = (token: Address) => !asked.has(token.toLowerCase()) || shown.has(token.toLowerCase())
  return pairs.filter((pair) => allowed(pair.token0) && allowed(pair.token1))
}

/**
 * One answer per candidate from several launchpads' `pluginOf` lookups (each list in the candidates' order): a token
 * any launchpad launched is a launch token; a token is cleared only once every launchpad has said it is not; anything
 * else (a launchpad not answered yet, or a failed read) holds it back, as withoutLaunchPools holds back a failure.
 */
export function combineLaunchLookups(
  perLaunchpad: readonly (readonly (LaunchLookup | undefined)[] | undefined)[],
  count: number,
): (LaunchLookup | undefined)[] {
  return Array.from({ length: count }, (_, index) => {
    const answers = perLaunchpad.map((lookups) => lookups?.[index])
    const launched = answers.find((answer) => answer?.status === 'success' && answer.result !== zeroAddress)
    if (launched) return launched
    if (answers.length > 0 && answers.every((answer) => answer?.status === 'success')) return answers[0]
    return answers.find((answer) => answer?.status === 'failure')
  })
}
