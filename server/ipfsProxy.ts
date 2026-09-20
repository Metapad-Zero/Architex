import { MAX_BLOCK_BYTES, bytesMatchCid, isVerifiableCid } from '../src/lib/cid.js'
import { parseMetadataJson, sniffImageType } from '../src/lib/tokenMetadata.js'

/**
 * Serves a launch's details file or image from our own domain: `GET /api/ipfs/<cid>`.
 *
 * Public IPFS gateways are rate limited to the point of being unusable from a browser, and the pinning
 * service's own public gateway takes seconds. So the file is fetched from the pinning service once,
 * checked against its address, and answered as immutable; the CDN serves every later request. Visitors
 * then contact nobody but us. The app still re-checks the bytes itself, so this server is not trusted.
 *
 * It is not a general IPFS proxy, which would let anyone serve anything from our domain:
 *   - only one-block addresses, which can be verified;
 *   - only files pinned through our own uploader (`isOurs`), so unpinning a file takes it down here too;
 *   - only what the app displays: a details file that parses, or a PNG, JPEG, WebP or GIF by its bytes.
 * Everything is sent `nosniff` under a sandboxing policy, so nothing served here can run as a page.
 */
export interface IpfsProxyOptions {
  /** Whether this address was pinned by our uploader. Any failure to find out must answer false. */
  isOurs: (cid: string) => Promise<boolean>
  /** Gateway origins to fetch from, in order, e.g. the account's own gateway first. */
  sources: readonly string[]
  fetcher?: typeof fetch
}

const IMMUTABLE = 'public, max-age=31536000, immutable'

function refuse(status: number, message: string): Response {
  return new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
}

async function readCapped(response: Response): Promise<Uint8Array | undefined> {
  if (Number(response.headers.get('content-length') ?? 0) > MAX_BLOCK_BYTES) return undefined
  const reader = response.body?.getReader()
  if (!reader) return undefined
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > MAX_BLOCK_BYTES) {
      await reader.cancel()
      return undefined
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
}

export function createIpfsProxy(options: IpfsProxyOptions) {
  const fetcher = options.fetcher ?? fetch
  return async function serve(cid: string): Promise<Response> {
    if (!isVerifiableCid(cid)) return refuse(400, 'Not an address this server can verify.')
    if (!(await options.isOurs(cid).catch(() => false))) return refuse(404, 'Not found.')

    for (const source of options.sources) {
      let bytes: Uint8Array | undefined
      try {
        const response = await fetcher(`${source}/ipfs/${cid}`, { signal: AbortSignal.timeout(12_000), redirect: 'follow' })
        bytes = response.ok ? await readCapped(response) : undefined
      } catch {
        bytes = undefined
      }
      if (!bytes || !(await bytesMatchCid(bytes, cid))) continue

      const imageType = sniffImageType(bytes)
      const type = imageType ?? (parseMetadataJson(bytes) ? 'application/json; charset=utf-8' : undefined)
      if (!type) return refuse(415, 'Not a details file or an image.')
      return new Response(bytes as BodyInit, {
        status: 200,
        headers: {
          'content-type': type,
          'cache-control': IMMUTABLE,
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; sandbox",
          'content-disposition': 'inline',
        },
      })
    }
    return refuse(502, 'The file could not be fetched. Try again.')
  }
}
