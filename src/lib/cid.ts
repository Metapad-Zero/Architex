/**
 * IPFS content addresses for one-block files, computed and checked with nothing but SHA-256.
 *
 * `ipfs add --cid-version=1` (and every pinning service in its default CIDv1 mode) stores a file of
 * up to 256 KiB as a single raw block, and the address of a raw block is just a framed SHA-256 of
 * its bytes: CIDv1 (0x01), raw codec (0x55), sha2-256 (0x12), 32 bytes (0x20), then the digest,
 * written in lower-case base32 with a `b` in front (`bafkrei…`). So anything we cap at 256 KiB has an
 * address we can work out before uploading it and re-check after downloading it, from any gateway,
 * without trusting that gateway. Larger files are chunked into a tree and cannot be checked this way,
 * which is why they are refused rather than displayed unverified.
 */
export const MAX_BLOCK_BYTES = 262_144

const HEADER = [0x01, 0x55, 0x12, 0x20]
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'
const CID_LENGTH = 59 // 'b' + 58 base32 characters for 36 bytes

function base32Encode(bytes: Uint8Array): string {
  let out = ''
  let buffer = 0
  let bits = 0
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += ALPHABET[(buffer >>> bits) & 31]
    }
    buffer &= (1 << bits) - 1
  }
  if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 31]
  return out
}

/** Undefined for anything that is not canonical lower-case base32: a stray character, or spare bits that are not zero. */
function base32Decode(text: string): Uint8Array | undefined {
  const out: number[] = []
  let buffer = 0
  let bits = 0
  for (const char of text) {
    const value = ALPHABET.indexOf(char)
    if (value < 0) return undefined
    buffer = (buffer << 5) | value
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out.push((buffer >>> bits) & 0xff)
      buffer &= (1 << bits) - 1
    }
  }
  if (buffer !== 0) return undefined
  return Uint8Array.from(out)
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
}

/** The address of `bytes` as a single raw block. Throws when the bytes would not fit in one block. */
export async function cidForBytes(bytes: Uint8Array): Promise<string> {
  if (bytes.length > MAX_BLOCK_BYTES) throw new Error(`A one-block file is at most ${MAX_BLOCK_BYTES} bytes.`)
  const digest = await sha256(bytes)
  const framed = new Uint8Array(HEADER.length + digest.length)
  framed.set(HEADER)
  framed.set(digest, HEADER.length)
  return `b${base32Encode(framed)}`
}

/** The SHA-256 inside a raw-block CIDv1, or undefined when `cid` is any other kind of address. */
export function digestOfCid(cid: string): Uint8Array | undefined {
  if (cid.length !== CID_LENGTH || cid[0] !== 'b') return undefined
  const framed = base32Decode(cid.slice(1))
  if (!framed || framed.length !== HEADER.length + 32) return undefined
  if (!HEADER.every((byte, index) => framed[index] === byte)) return undefined
  return framed.slice(HEADER.length)
}

export function isVerifiableCid(cid: string): boolean {
  return digestOfCid(cid) !== undefined
}

/** True only when `bytes` are exactly the content `cid` names. */
export async function bytesMatchCid(bytes: Uint8Array, cid: string): Promise<boolean> {
  const expected = digestOfCid(cid)
  if (!expected || bytes.length > MAX_BLOCK_BYTES) return false
  const actual = await sha256(bytes)
  let difference = 0
  for (let index = 0; index < expected.length; index += 1) difference |= expected[index] ^ actual[index]
  return difference === 0
}
