import { MAX_BLOCK_BYTES, bytesMatchCid } from './cid'
import { sniffImageType } from './tokenMetadata'

/**
 * Reading one-block files from IPFS through ordinary https gateways, without trusting them.
 *
 * A gateway is only a courier: whatever it returns is hashed and compared with the address before it
 * is used, so a gateway that is wrong, compromised or configured to swap content is simply skipped.
 * The first gateway is the pinning account's own (fast, and it has the file the moment it is pinned);
 * the public ones are the fallback. A creator never chooses where a visitor's browser connects.
 */
const PUBLIC_GATEWAYS = ['https://ipfs.io', 'https://dweb.link']
const TIMEOUT_MS = 8_000

export interface MetadataStatus {
  /** Whether details can be saved right now (a pinning key is configured on the server). */
  enabled: boolean
  gateway?: string
}

let status: Promise<MetadataStatus> | undefined

/** Asked once per visit. Any failure reads as "not enabled", and reading falls back to the public gateways. */
export function metadataStatus(): Promise<MetadataStatus> {
  status ??= fetch('/api/metadata')
    .then(async (response): Promise<MetadataStatus> => {
      if (!response.ok) return { enabled: false }
      const body = (await response.json()) as { enabled?: unknown; gateway?: unknown }
      const gateway = typeof body.gateway === 'string' && /^https?:\/\/[a-z0-9.:-]+$/i.test(body.gateway) ? body.gateway : undefined
      return { enabled: body.enabled === true, gateway }
    })
    .catch((): MetadataStatus => ({ enabled: false }))
  return status
}

/** Reads at most `max` bytes; a longer body is abandoned rather than downloaded. */
async function readCapped(response: Response, max: number): Promise<Uint8Array | undefined> {
  if (Number(response.headers.get('content-length') ?? 0) > max) return undefined
  const reader = response.body?.getReader()
  if (!reader) return undefined
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > max) {
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

const verified = new Map<string, Promise<Uint8Array>>()

async function fetchFrom(gateway: string, cid: string, signal: AbortSignal | undefined): Promise<Uint8Array | undefined> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  try {
    // `AbortSignal.any` is newer than the rest of this file needs; without it the timeout alone still bounds the request.
    const combined = signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : timeout
    const response = await fetch(`${gateway}/ipfs/${cid}`, { signal: combined, referrerPolicy: 'no-referrer', credentials: 'omit' })
    if (!response.ok) return undefined
    const bytes = await readCapped(response, MAX_BLOCK_BYTES)
    return bytes && (await bytesMatchCid(bytes, cid)) ? bytes : undefined
  } catch {
    return undefined
  }
}

/** The exact content `cid` names, or a rejection when no gateway could supply it. Kept for the visit. */
export function fetchVerified(cid: string, signal?: AbortSignal): Promise<Uint8Array> {
  const known = verified.get(cid)
  if (known) return known
  const attempt = (async () => {
    const { gateway } = await metadataStatus()
    for (const source of [...(gateway ? [gateway] : []), ...PUBLIC_GATEWAYS]) {
      const bytes = await fetchFrom(source, cid, signal)
      if (bytes) return bytes
      if (signal?.aborted) break
    }
    throw new Error('No gateway returned that file.')
  })()
  verified.set(cid, attempt)
  attempt.catch(() => verified.delete(cid))
  return attempt
}

/** Lets a creator's own upload show at once, before any gateway has been asked. The bytes are still checked. */
export async function rememberVerified(cid: string, bytes: Uint8Array): Promise<void> {
  if (await bytesMatchCid(bytes, cid)) verified.set(cid, Promise.resolve(bytes))
}

const imageUrls = new Map<string, string>()

/** A `blob:` URL for a verified image. Its type comes from the bytes, never from the gateway or the file's name. */
export async function verifiedImageUrl(cid: string, signal?: AbortSignal): Promise<string | undefined> {
  const known = imageUrls.get(cid)
  if (known) return known
  const bytes = await fetchVerified(cid, signal)
  const type = sniffImageType(bytes)
  if (!type) return undefined
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }))
  imageUrls.set(cid, url)
  return url
}
