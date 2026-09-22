/**
 * Runs the listing API (server/listing) against the real chain, read-only, and prints what each endpoint answers.
 *
 *   ARC_NETWORK=mainnet bun run scripts/listing-check.ts            # mainnet, as production serves it
 *   ARC_NETWORK=testnet bun run scripts/listing-check.ts
 *   ARC_NETWORK=mainnet bun run scripts/listing-check.ts --full     # whole bodies instead of the first rows
 *
 * Requests are built for https://architex.fun, so launch logos are looked up through the live site's /api/ipfs.
 * Nothing is sent to the chain but reads; no key is used.
 */
import { listingServiceFromEnv } from '../server/listing/service'

const ORIGIN = process.env.LISTING_ORIGIN ?? 'https://architex.fun'
const full = process.argv.includes('--full')
const service = listingServiceFromEnv()

function trimmed(body: unknown): unknown {
  if (full) return body
  const shorten = (list: unknown[], keep: number): unknown[] => (list.length > keep ? [...list.slice(0, keep), `… ${list.length - keep} more`] : list)
  if (Array.isArray(body)) return shorten(body as unknown[], 3)
  if (body && typeof body === 'object') {
    return Object.fromEntries(Object.entries(body as Record<string, unknown>).map(([key, value]) => [key, Array.isArray(value) ? shorten(value as unknown[], 4) : value]))
  }
  return body
}

async function call(path: string): Promise<unknown> {
  const started = performance.now()
  const response = await service.handle(new Request(`${ORIGIN}${path}`))
  const ms = Math.round(performance.now() - started)
  const body: unknown = await response.json()
  const headers = ['cache-control', 'x-architex-network', 'x-architex-block', 'x-architex-partial', 'x-architex-window']
    .map((name) => [name, response.headers.get(name)] as const)
    .filter(([, value]) => value !== null)
    .map(([name, value]) => `${name}: ${value}`)
  console.log(`\nGET ${path}  ${response.status}  ${ms} ms\n  ${headers.join('\n  ')}`)
  console.log(JSON.stringify(trimmed(body), null, 2))
  return body
}

const pairs = (await call('/api/v1/pairs')) as { ticker_id: string }[]
await call('/api/v1/tickers')
const ticker = pairs[0]?.ticker_id
if (ticker) {
  await call(`/api/v1/orderbook?ticker_id=${ticker}&depth=10`)
  await call(`/api/v1/historical_trades?ticker_id=${ticker}&limit=5`)
}
for (const row of pairs.slice(1)) await call(`/api/v1/historical_trades?ticker_id=${row.ticker_id}&limit=5`)
await call('/tokenlist.json')
await call('/api/v1/tickers')
