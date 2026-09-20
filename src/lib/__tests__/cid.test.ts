import { describe, expect, test } from 'bun:test'
import { MAX_BLOCK_BYTES, bytesMatchCid, cidForBytes, digestOfCid, isVerifiableCid } from '../cid'

const text = (value: string) => new TextEncoder().encode(value)

describe('one-block CIDs', () => {
  test('matches the address IPFS gives "hello world"', async () => {
    // The well-known raw-leaf CIDv1 of these eleven bytes, as `ipfs add --cid-version=1` prints it.
    expect(await cidForBytes(text('hello world'))).toBe('bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e')
  })

  test('the empty file has the well-known empty raw CID', async () => {
    expect(await cidForBytes(new Uint8Array())).toBe('bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku')
  })

  test('round-trips: the digest inside the CID is the SHA-256 of the bytes', async () => {
    const cid = await cidForBytes(text('architex'))
    const digest = digestOfCid(cid)
    expect(digest).toBeDefined()
    expect(digest!.length).toBe(32)
    expect(await bytesMatchCid(text('architex'), cid)).toBe(true)
  })

  test('one changed byte no longer matches', async () => {
    const cid = await cidForBytes(text('architex'))
    expect(await bytesMatchCid(text('Architex'), cid)).toBe(false)
    expect(await bytesMatchCid(text('architex '), cid)).toBe(false)
  })

  test('refuses every other kind of address', () => {
    expect(isVerifiableCid('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG')).toBe(false) // CIDv0
    expect(isVerifiableCid('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi')).toBe(false) // dag-pb: a chunked file
    expect(isVerifiableCid('BAFKREIFZJUT3TE2NHYEKKLSS27NH3K72YSCO7Y32KOAO5EEI66WOF36N5E')).toBe(false) // upper case
    expect(isVerifiableCid('bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5')).toBe(false) // short
    expect(isVerifiableCid('bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5f')).toBe(false) // spare bits set
    expect(isVerifiableCid('bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5!')).toBe(false)
    expect(isVerifiableCid('')).toBe(false)
  })

  test('will not address, or accept, more than one block', async () => {
    const tooBig = new Uint8Array(MAX_BLOCK_BYTES + 1)
    await expect(cidForBytes(tooBig)).rejects.toThrow('at most 262144 bytes')
    expect(await bytesMatchCid(tooBig, 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e')).toBe(false)
    expect((await cidForBytes(new Uint8Array(MAX_BLOCK_BYTES))).startsWith('bafkrei')).toBe(true)
  })
})
