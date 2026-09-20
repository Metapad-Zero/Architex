import { isVerifiableCid } from './cid.js'

/**
 * What a launch says about itself, beyond the name and symbol the chain already holds.
 *
 * The launchpad stores one short string per token. That string is `ipfs://<cid>` of a small JSON file;
 * the file names its image the same way. Both are one-block files (src/lib/cid.ts), so the address IS
 * the fingerprint of the content: it cannot be swapped after launch, by the creator, a gateway or us,
 * without every reader noticing. Field names follow what other readers already understand: ERC-7572
 * (`name`, `symbol`, `description`, `image`, `external_link`) plus the `twitter` and `telegram` keys
 * launchpad tooling uses.
 *
 * Everything in such a file is written by a stranger. Reading is strict: bounded size, plain strings,
 * https links to the hosts they claim, addresses we can verify. A field that fails is dropped; it never
 * takes the rest of the file down with it. The token's name and symbol are always shown from the chain,
 * never from here.
 */
export const METADATA_LIMITS = {
  jsonBytes: 4096,
  descriptionChars: 280,
  urlChars: 200,
} as const

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export type ImageType = (typeof IMAGE_TYPES)[number]

export interface TokenMetadata {
  name: string
  symbol: string
  description?: string
  /** `ipfs://<cid>` of a one-block image. */
  image?: string
  /** The project's website. */
  external_link?: string
  /** `https://x.com/<handle>` */
  twitter?: string
  /** `https://t.me/<name>` */
  telegram?: string
}

/** What a creator types. Handles may be given as `@name`, `name` or a full link. */
export interface MetadataInput {
  name: string
  symbol: string
  description?: string
  imageCid?: string
  website?: string
  x?: string
  telegram?: string
}

export type MetadataField = 'description' | 'website' | 'x' | 'telegram' | 'image'
export type MetadataErrors = Partial<Record<MetadataField, string>>

/** True for a character that has no business in a line of text: C0 controls other than tab and newline, and DEL. */
function isControl(code: number): boolean {
  return code === 127 || (code < 32 && code !== 9 && code !== 10 && code !== 13)
}

function hasControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) if (isControl(value.charCodeAt(index))) return true
  return false
}

export function ipfsUri(cid: string): string {
  return `ipfs://${cid}`
}

/** The CID in `ipfs://<cid>`, only when it is one we can verify. No paths, no gateways, no other schemes. */
export function cidOfIpfsUri(uri: string): string | undefined {
  if (!uri.startsWith('ipfs://')) return undefined
  const cid = uri.slice('ipfs://'.length)
  return isVerifiableCid(cid) ? cid : undefined
}

/** A plain https link to a real host: no credentials, no odd ports, no control characters. */
export function cleanWebsite(value: string): string | undefined {
  const text = value.trim()
  if (!text || text.length > METADATA_LIMITS.urlChars || hasControl(text) || /\s/.test(text)) return undefined
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined
  if (!url.hostname.includes('.') || url.hostname.endsWith('.')) return undefined
  return url.toString()
}

function cleanHandle(value: string, hosts: readonly string[], pattern: RegExp, base: string): string | undefined {
  let text = value.trim()
  if (!text || text.length > METADATA_LIMITS.urlChars) return undefined
  if (/^https?:\/\//i.test(text)) {
    let url: URL
    try {
      url = new URL(text)
    } catch {
      return undefined
    }
    if (url.protocol !== 'https:' || !hosts.includes(url.hostname.toLowerCase())) return undefined
    text = url.pathname.replace(/^\/+|\/+$/g, '')
  }
  text = text.replace(/^@/, '')
  return pattern.test(text) ? `${base}${text}` : undefined
}

export function cleanX(value: string): string | undefined {
  return cleanHandle(value, ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'], /^[A-Za-z0-9_]{1,15}$/, 'https://x.com/')
}

export function cleanTelegram(value: string): string | undefined {
  return cleanHandle(value, ['t.me', 'telegram.me'], /^[A-Za-z][A-Za-z0-9_]{4,31}$/, 'https://t.me/')
}

export function cleanDescription(value: string): string | undefined {
  const text = value.replace(/\r\n?/g, '\n').trim()
  if (!text || hasControl(text) || [...text].length > METADATA_LIMITS.descriptionChars) return undefined
  return text
}

/** Problems with what a creator typed, worded for the form. Empty fields are fine: everything here is optional. */
export function metadataErrors(input: MetadataInput): MetadataErrors {
  const errors: MetadataErrors = {}
  if (input.description?.trim() && !cleanDescription(input.description)) errors.description = `Keep the description to ${METADATA_LIMITS.descriptionChars} characters.`
  if (input.website?.trim() && !cleanWebsite(input.website)) errors.website = 'Enter an https address, like example.com.'
  if (input.x?.trim() && !cleanX(input.x)) errors.x = 'Enter an X handle, like @architex.'
  if (input.telegram?.trim() && !cleanTelegram(input.telegram)) errors.telegram = 'Enter a Telegram name, like @architex.'
  if (input.imageCid && !isVerifiableCid(input.imageCid)) errors.image = 'That image could not be prepared. Try another file.'
  return errors
}

export function hasMetadata(input: MetadataInput): boolean {
  return Boolean(input.description?.trim() || input.imageCid || input.website?.trim() || input.x?.trim() || input.telegram?.trim())
}

/**
 * The file's exact bytes. Keys are written in one fixed order with no spare whitespace, so the same
 * details always give the same bytes, and therefore the same address, in the browser and on the server.
 */
export function buildMetadataJson(input: MetadataInput): string {
  if (Object.keys(metadataErrors(input)).length > 0) throw new Error('Token details are not valid.')
  const file: TokenMetadata = { name: input.name.trim(), symbol: input.symbol.trim() }
  const description = input.description ? cleanDescription(input.description) : undefined
  const website = input.website ? cleanWebsite(input.website) : undefined
  const x = input.x ? cleanX(input.x) : undefined
  const telegram = input.telegram ? cleanTelegram(input.telegram) : undefined
  if (description) file.description = description
  if (input.imageCid) file.image = ipfsUri(input.imageCid)
  if (website) file.external_link = website
  if (x) file.twitter = x
  if (telegram) file.telegram = telegram
  const json = JSON.stringify(file)
  if (new TextEncoder().encode(json).length > METADATA_LIMITS.jsonBytes) throw new Error('Token details are too long.')
  return json
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length <= max && !hasControl(value) ? value : undefined
}

/** Reads a metadata file written by anyone. Undefined when it is not a usable file at all. */
export function parseMetadataJson(bytes: Uint8Array): TokenMetadata | undefined {
  if (bytes.length === 0 || bytes.length > METADATA_LIMITS.jsonBytes) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const fields = raw as Record<string, unknown>
  const file: TokenMetadata = { name: text(fields.name, 64) ?? '', symbol: text(fields.symbol, 32) ?? '' }

  const description = typeof fields.description === 'string' ? cleanDescription(fields.description) : undefined
  const image = typeof fields.image === 'string' ? cidOfIpfsUri(fields.image) : undefined
  const website = text(fields.external_link, METADATA_LIMITS.urlChars) ?? text(fields.website, METADATA_LIMITS.urlChars)
  const twitter = text(fields.twitter, METADATA_LIMITS.urlChars)
  const telegram = text(fields.telegram, METADATA_LIMITS.urlChars)
  if (description) file.description = description
  if (image) file.image = ipfsUri(image)
  // Links are re-derived, not copied: what is shown is always the cleaned form.
  const cleanedWebsite = website ? cleanWebsite(website) : undefined
  const cleanedX = twitter ? cleanX(twitter) : undefined
  const cleanedTelegram = telegram ? cleanTelegram(telegram) : undefined
  if (cleanedWebsite) file.external_link = cleanedWebsite
  if (cleanedX) file.twitter = cleanedX
  if (cleanedTelegram) file.telegram = cleanedTelegram
  return file
}

/** How a link is labelled on the page: the host or handle it really goes to, never text the creator chose. */
export function linkLabel(url: string): string {
  const parsed = new URL(url)
  const host = parsed.hostname.replace(/^www\./, '')
  if (host === 'x.com' || host === 't.me') return `@${parsed.pathname.replace(/^\/+|\/+$/g, '')}`
  return host
}

const SIGNATURES: readonly { type: ImageType; test: (b: Uint8Array) => boolean }[] = [
  { type: 'image/png', test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a },
  { type: 'image/jpeg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/gif', test: (b) => b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61 },
  { type: 'image/webp', test: (b) => b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 },
]

/** What the bytes are, by their signature. A declared type is never believed; SVG and everything else is refused. */
export function sniffImageType(bytes: Uint8Array): ImageType | undefined {
  return SIGNATURES.find((signature) => signature.test(bytes))?.type
}
