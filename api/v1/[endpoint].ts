import { listingServiceFromEnv } from '../../server/listing/service.js'

/**
 * The public listing API, for DEX listers, aggregators, data sites and wallets (server/listing/service.ts):
 *
 *   GET /api/v1/pairs               every market: ticker_id, base, target, pool_id
 *   GET /api/v1/tickers             24-hour price, volume and liquidity per market (CoinGecko's DEX standard)
 *   GET /api/v1/orderbook           depth derived from a market's reserves and fees
 *   GET /api/v1/historical_trades   trades from the chain's logs
 *   GET /tokenlist.json             the Uniswap Token Lists file (vercel.json rewrites it to /api/v1/tokenlist)
 *
 * One function serves them all, so they share one read of the chain inside a running instance. Read-only: it holds
 * no key and signs nothing. Environment: VITE_ARC_NETWORK (mainnet in production) or ARC_NETWORK to override it,
 * and optionally ARC_RPC_URL, a server-only RPC endpoint (or several, comma separated) instead of the public ones.
 */
const service = listingServiceFromEnv()

export function GET(request: Request): Promise<Response> {
  return service.handle(request)
}

export function OPTIONS(): Response {
  return new Response(null, {
    status: 204,
    headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-max-age': '86400' },
  })
}
