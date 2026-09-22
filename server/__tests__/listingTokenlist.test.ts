import { describe, expect, test } from 'bun:test'
import { cidForBytes } from '../../src/lib/cid'
import { HIDDEN_DETAILS } from '../../src/lib/hiddenDetails'
import { buildMetadataJson } from '../../src/lib/tokenMetadata'
import { buildTokenList, createImageLookup, listableName, listableSymbol, tokenListProblems } from '../listing/tokenlist'
import { CURVED, POOLED, makeSnapshot } from './listingFixtures'

const ORIGIN = 'https://architex.fun'
const IMAGE_CID = 'bafkreihj4zhktsccwtmue4vyjqf7cjpkj5lgb7udthp6nf7azi6epkjdd4'

describe('what the schema lets into a list', () => {
  test('names and symbols by the strictest published patterns', () => {
    expect(listableName('Pooled Token')).toBe(true)
    expect(listableName("Mom's [Coin] (v2)")).toBe(true)
    expect(listableName('Café')).toBe(true)
    expect(listableName('🚀 Moon')).toBe(false)
    expect(listableName(' padded')).toBe(false)
    expect(listableName('x'.repeat(41))).toBe(false)
    expect(listableSymbol('ATXTST')).toBe(true)
    expect(listableSymbol('$DOG.v2')).toBe(true)
    expect(listableSymbol('TWO WORDS')).toBe(false)
    expect(listableSymbol('')).toBe(false)
  })
})

describe('the token list', () => {
  const images = (known: Record<string, string>) => (uri: string) => Promise.resolve(known[uri])

  test('the deployment tokens, then launches oldest first, tagged by where they trade', async () => {
    const snapshot = makeSnapshot()
    snapshot.launches[0].metadataURI = 'ipfs://pooled'
    const { list, complete } = await buildTokenList(snapshot, ORIGIN, images({ 'ipfs://pooled': IMAGE_CID }))
    expect(complete).toBe(true)
    expect(list.tokens.map((token) => token.symbol)).toEqual(['USDC', 'EURC', 'POOL', 'CRV'])
    const [, , pooled, curved] = list.tokens
    expect(pooled.logoURI).toBe(`${ORIGIN}/api/ipfs/${IMAGE_CID}`)
    expect(pooled.tags).toEqual(['launch', 'graduated'])
    expect(curved.tags).toEqual(['launch', 'curve'])
    expect('logoURI' in curved).toBe(false)
    expect(pooled.extensions?.pool).toBe(snapshot.launches[0].pair)
    expect(list.version).toEqual({ major: 1, minor: 2, patch: 1 })
    expect(tokenListProblems(list)).toEqual([])
  })

  test('a launch that impersonates a listed token, or breaks the schema, is left out', async () => {
    const snapshot = makeSnapshot()
    snapshot.tokens.set(POOLED.address.toLowerCase(), { ...POOLED, symbol: 'usdc' })
    snapshot.tokens.set(CURVED.address.toLowerCase(), { ...CURVED, name: '🚀 to the moon' })
    const { list } = await buildTokenList(snapshot, ORIGIN, images({}))
    expect(list.tokens.map((token) => token.symbol)).toEqual(['USDC', 'EURC'])
    expect(tokenListProblems(list)).toEqual([])
  })

  test('a failed image lookup keeps the token, without a logo, and says the list is incomplete', async () => {
    const { list, complete } = await buildTokenList(makeSnapshot(), ORIGIN, () => Promise.reject(new Error('down')))
    expect(complete).toBe(false)
    expect(list.tokens).toHaveLength(4)
  })

  test('the checker catches what a consumer would reject', () => {
    const bad = {
      name: 'Bad list!',
      timestamp: 'yesterday',
      version: { major: 1, minor: -1, patch: 0 },
      keywords: ['ok'],
      tags: {},
      logoURI: 'not a uri',
      tokens: [{ chainId: 5042, address: '0xabc', name: '', symbol: 'A B', decimals: 256, tags: ['nope'] }],
    }
    const problems = tokenListProblems(bad)
    for (const expected of ['name', 'timestamp', 'version', 'logoURI', 'token 0xabc address', 'token 0xabc decimals', 'token 0xabc name', 'token 0xabc symbol', 'token 0xabc tags']) {
      expect(problems).toContain(expected)
    }
  })
})

describe('finding a launch logo the way the site does', () => {
  const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

  function served(files: Record<string, Uint8Array>) {
    const asked: string[] = []
    const fetcher = ((input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input)
      asked.push(url)
      const bytes = files[url]
      return Promise.resolve(bytes ? new Response(bytes as BodyInit, { status: 200 }) : new Response('Not found.', { status: 404 }))
    }) as typeof fetch
    return { lookup: createImageLookup({ origin: ORIGIN, fetcher }), asked }
  }

  test('the details file is read from our own /api/ipfs, checked against its address, and its image kept', async () => {
    const imageCid = await cidForBytes(PNG)
    const file = new TextEncoder().encode(buildMetadataJson({ name: 'A', symbol: 'A', imageCid }))
    const cid = await cidForBytes(file)
    const { lookup, asked } = served({ [`${ORIGIN}/api/ipfs/${cid}`]: file })
    expect(await lookup(`ipfs://${cid}`)).toBe(imageCid)
    // Kept for good: an address always names the same bytes.
    expect(await lookup(`ipfs://${cid}`)).toBe(imageCid)
    expect(asked).toHaveLength(1)
  })

  test('bytes that do not match the address are refused', async () => {
    const imageCid = await cidForBytes(PNG)
    const file = new TextEncoder().encode(buildMetadataJson({ name: 'A', symbol: 'A', imageCid }))
    const cid = await cidForBytes(file)
    const { lookup } = served({ [`${ORIGIN}/api/ipfs/${cid}`]: new TextEncoder().encode('{"name":"B"}') })
    await expect(lookup(`ipfs://${cid}`)).rejects.toThrow('do not match')
  })

  test('no logo for a file we do not serve, one without an image, a hidden one, or an address we cannot verify', async () => {
    const plainFile = new TextEncoder().encode(buildMetadataJson({ name: 'A', symbol: 'A', description: 'No image.' }))
    const plainCid = await cidForBytes(plainFile)
    const { lookup, asked } = served({ [`${ORIGIN}/api/ipfs/${plainCid}`]: plainFile })
    expect(await lookup(`ipfs://${plainCid}`)).toBe(undefined)
    expect(await lookup(`ipfs://${await cidForBytes(PNG)}`)).toBe(undefined)
    const before = asked.length
    expect(await lookup(`ipfs://${[...HIDDEN_DETAILS][0]}`)).toBe(undefined)
    expect(await lookup('ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG')).toBe(undefined)
    expect(await lookup('https://example.com/logo.png')).toBe(undefined)
    expect(asked.length).toBe(before)
  })
})
