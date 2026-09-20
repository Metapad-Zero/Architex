import { MAX_BLOCK_BYTES, cidForBytes } from '../src/lib/cid.js'
import { METADATA_LIMITS, buildMetadataJson, hasMetadata, ipfsUri, metadataErrors, sniffImageType, type MetadataInput } from '../src/lib/tokenMetadata.js'
import type { Pinner } from './pinner.js'

/**
 * Saves a launch's details before the launch: pins the image, then the JSON file that names it, and
 * answers with the `ipfs://` string the creator's transaction will store.
 *
 * The browser can work out both addresses by itself, and does, to check this answer. What it cannot do
 * is hold the pinning key, so this runs on the server. Anyone can call it, so it accepts little: a small
 * JSON body from our own pages, an image of a known kind that fits in one block, and text that passes
 * the same checks as the form. It rebuilds the JSON from the checked fields rather than storing what it
 * was sent, and it only reports an address it has verified against the bytes.
 */
export interface MetadataServiceOptions {
  /** Undefined while no pinning key is configured: the form hides its detail fields and uploads answer 503. */
  pinner: Pinner | undefined
  /** `https://host` of the gateway the app should read from first, if any. */
  gateway: string | undefined
  now?: () => number
}

const MAX_BODY_BYTES = 400_000 // a full 256 KiB image in base64, plus the text
const NAME_MAX_BYTES = 32
const SYMBOL_MAX_BYTES = 10
const WINDOW_MS = 10 * 60_000
const UPLOADS_PER_WINDOW = 8

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } })

const refuse = (status: number, error: string) => json({ error }, status)

const byteLength = (value: string) => new TextEncoder().encode(value).length

function decodeBase64(value: string): Uint8Array | undefined {
  if (value.length > Math.ceil(MAX_BLOCK_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return undefined
  try {
    return Uint8Array.from(atob(value), (char) => char.charCodeAt(0))
  } catch {
    return undefined
  }
}

export function createMetadataService(options: MetadataServiceOptions) {
  const now = options.now ?? Date.now
  // Best effort only: each server instance counts for itself. The real bound on abuse is that an upload
  // is worthless without a launch, and a launch costs the launch fee.
  const recent = new Map<string, number[]>()

  function allowed(client: string): boolean {
    const cutoff = now() - WINDOW_MS
    const times = (recent.get(client) ?? []).filter((time) => time > cutoff)
    if (times.length >= UPLOADS_PER_WINDOW) {
      recent.set(client, times)
      return false
    }
    times.push(now())
    recent.set(client, times)
    if (recent.size > 5_000) for (const [key, value] of recent) if (value.every((time) => time <= cutoff)) recent.delete(key)
    return true
  }

  return {
    /** What the app needs to know before it shows the form or reads a file. */
    status(): Response {
      return json(
        { enabled: Boolean(options.pinner), gateway: options.gateway ?? null, limits: { imageBytes: MAX_BLOCK_BYTES, descriptionChars: METADATA_LIMITS.descriptionChars } },
        200,
        { 'cache-control': 'public, max-age=300' },
      )
    },

    async save(request: Request, client: string): Promise<Response> {
      const pinner = options.pinner
      if (!pinner) return refuse(503, 'Token details cannot be saved yet.')

      // Only our own pages. A JSON content type makes any cross-site attempt a preflighted request, which gets no permission.
      const origin = request.headers.get('origin')
      if (origin && new URL(origin).host !== new URL(request.url).host) return refuse(403, 'Requests from other sites are not accepted.')
      if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return refuse(415, 'Send JSON.')
      if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return refuse(413, 'That is too large. Images can be up to 256 KB.')
      if (!allowed(client)) return refuse(429, 'Too many uploads. Try again in a few minutes.')

      const raw = new Uint8Array(await request.arrayBuffer())
      if (raw.length > MAX_BODY_BYTES) return refuse(413, 'That is too large. Images can be up to 256 KB.')
      let body: Record<string, unknown>
      try {
        const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
        body = parsed as Record<string, unknown>
      } catch {
        return refuse(400, 'Send a JSON object.')
      }

      const field = (key: string) => (typeof body[key] === 'string' ? body[key] : undefined)
      const name = field('name')?.trim() ?? ''
      const symbol = field('symbol')?.trim() ?? ''
      if (!name || byteLength(name) > NAME_MAX_BYTES) return refuse(400, 'Name must be 1 to 32 bytes.')
      if (!symbol || byteLength(symbol) > SYMBOL_MAX_BYTES) return refuse(400, 'Symbol must be 1 to 10 bytes.')

      let imageBytes: Uint8Array | undefined
      let imageType: string | undefined
      const image = field('image')
      if (image !== undefined) {
        imageBytes = decodeBase64(image)
        if (!imageBytes || imageBytes.length === 0 || imageBytes.length > MAX_BLOCK_BYTES) return refuse(400, 'Images can be up to 256 KB.')
        imageType = sniffImageType(imageBytes)
        if (!imageType) return refuse(400, 'Use a PNG, JPEG, WebP or GIF image.')
      }

      const input: MetadataInput = { name, symbol, description: field('description'), website: field('website'), x: field('x'), telegram: field('telegram') }
      const errors = metadataErrors(input)
      if (Object.keys(errors).length > 0) return json({ error: 'Some details are not valid.', fields: errors }, 400)
      if (!imageBytes && !hasMetadata(input)) return refuse(400, 'There are no details to save.')

      const pinned: string[] = []
      try {
        if (imageBytes && imageType) {
          input.imageCid = await cidForBytes(imageBytes)
          const result = await pinner.pin({ bytes: imageBytes, name: `${symbol}-image`, type: imageType, labels: { app: 'architex', kind: 'image' } })
          pinned.push(result.id)
          if (result.cid !== input.imageCid) throw new Error('The pinning service reported a different address for the image.')
        }
        const fileBytes = new TextEncoder().encode(buildMetadataJson(input))
        const cid = await cidForBytes(fileBytes)
        const result = await pinner.pin({ bytes: fileBytes, name: `${symbol}-metadata.json`, type: 'application/json', labels: { app: 'architex', kind: 'metadata', ...(input.imageCid ? { image: input.imageCid } : {}) } })
        pinned.push(result.id)
        if (result.cid !== cid) throw new Error('The pinning service reported a different address for the file.')
        return json({ uri: ipfsUri(cid), cid, imageCid: input.imageCid ?? null })
      } catch (error) {
        // Never leave half a launch behind, and never report an address that was not verified.
        await Promise.allSettled(pinned.map((id) => pinner.unpin(id)))
        console.error('metadata upload failed:', error instanceof Error ? error.message : 'unknown error')
        return refuse(502, 'The details could not be saved. Try again.')
      }
    },
  }
}
