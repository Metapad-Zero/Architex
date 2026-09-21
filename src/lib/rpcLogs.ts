/**
 * Reading event history straight from the RPC, for when the explorer cannot be reached.
 *
 * Arc's public RPC refuses `eth_getLogs` over more than about 2,000 blocks, and a block takes about
 * half a second, so one window is roughly 16 minutes. A few windows are read newest first; the
 * result says whether that reached the start of the history or only its recent end.
 */
const WINDOW = 1_900n

export interface WindowedLogs<T> {
  logs: T[]
  /** True when the windows reached block 0 or the point `reachedStart` recognises. */
  complete: boolean
}

export async function readLogWindows<T>(options: {
  head: bigint
  windows: number
  read: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>
  /** Whether history cannot extend below this block, for example because the contract is younger. */
  reachedStart?: (fromBlock: bigint) => Promise<boolean>
}): Promise<WindowedLogs<T>> {
  const logs: T[] = []
  let toBlock = options.head
  for (let index = 0; index < options.windows; index += 1) {
    const fromBlock = toBlock > WINDOW ? toBlock - WINDOW : 0n
    logs.push(...(await options.read(fromBlock, toBlock)))
    if (fromBlock === 0n) return { logs, complete: true }
    if (options.reachedStart && (await options.reachedStart(fromBlock))) return { logs, complete: true }
    toBlock = fromBlock - 1n
  }
  return { logs, complete: false }
}

/** Unix-second timestamps for the newest `max` distinct blocks; older blocks are left out of the map. */
export async function blockTimes(
  client: { getBlock(args: { blockNumber: bigint }): Promise<{ timestamp: bigint }> },
  blockNumbers: (bigint | null)[],
  max = 40,
): Promise<Map<bigint, number>> {
  const wanted = [...new Set(blockNumbers.filter((block): block is bigint => block !== null))]
    .sort((a, b) => (a === b ? 0 : a > b ? -1 : 1))
    .slice(0, max)
  const times = new Map<bigint, number>()
  await Promise.all(
    wanted.map(async (blockNumber) => {
      const block = await client.getBlock({ blockNumber })
      times.set(blockNumber, Number(block.timestamp))
    }),
  )
  return times
}
