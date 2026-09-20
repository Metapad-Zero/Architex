import { describe, expect, test } from 'bun:test'
import { cidForBytes, isVerifiableCid } from '../../src/lib/cid'
import { HIDDEN_DETAILS } from '../../src/lib/hiddenDetails'
import { buildMetadataJson } from '../../src/lib/tokenMetadata'
import { createIpfsProxy } from '../ipfsProxy'

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const text = (value: string) => new TextEncoder().encode(value)

/** A gateway that serves the given files by address and counts what it was asked for. */
function gateway(files: Record<string, Uint8Array>) {
  const asked: string[] = []
  const fetcher = ((input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input)
    asked.push(url)
    const bytes = files[url]
    return Promise.resolve(bytes ? new Response(bytes as BodyInit, { status: 200 }) : new Response('nope', { status: 404 }))
  }) as typeof fetch
  return { fetcher, asked }
}

const yes = () => Promise.resolve(true)

describe('serving a launch\'s files from our own domain', () => {
  test('an image: its type comes from the bytes, it is immutable, and it cannot run as a page', async () => {
    const cid = await cidForBytes(PNG)
    const { fetcher } = gateway({ [`https://a.example/ipfs/${cid}`]: PNG })
    const response = await createIpfsProxy({ isOurs: yes, sources: ['https://a.example'], fetcher })(cid)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG)
  })

  test('a details file', async () => {
    const file = text(buildMetadataJson({ name: 'A', symbol: 'A', description: 'Fine.' }))
    const cid = await cidForBytes(file)
    const { fetcher } = gateway({ [`https://a.example/ipfs/${cid}`]: file })
    const response = await createIpfsProxy({ isOurs: yes, sources: ['https://a.example'], fetcher })(cid)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
  })

  test('a source that returns the wrong bytes is skipped for the next one', async () => {
    const cid = await cidForBytes(PNG)
    const swapped = Uint8Array.from([...PNG, 9])
    const { fetcher, asked } = gateway({ [`https://bad.example/ipfs/${cid}`]: swapped, [`https://good.example/ipfs/${cid}`]: PNG })
    const response = await createIpfsProxy({ isOurs: yes, sources: ['https://bad.example', 'https://good.example'], fetcher })(cid)
    expect(response.status).toBe(200)
    expect(asked).toHaveLength(2)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG)
  })
})

describe('what it will not serve', () => {
  test('the hide list holds only addresses the app could otherwise show', () => {
    for (const cid of HIDDEN_DETAILS) expect(isVerifiableCid(cid)).toBe(true)
  })

  test('an address it cannot verify, without asking anyone', async () => {
    const { fetcher, asked } = gateway({})
    const serve = createIpfsProxy({ isOurs: yes, sources: ['https://a.example'], fetcher })
    expect((await serve('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG')).status).toBe(400)
    expect((await serve('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi')).status).toBe(400)
    expect((await serve('../../etc/passwd')).status).toBe(400)
    expect(asked).toHaveLength(0)
  })

  test('a file that was not pinned through our uploader, without fetching it', async () => {
    const cid = await cidForBytes(PNG)
    const { fetcher, asked } = gateway({ [`https://a.example/ipfs/${cid}`]: PNG })
    const response = await createIpfsProxy({ isOurs: () => Promise.resolve(false), sources: ['https://a.example'], fetcher })(cid)
    expect(response.status).toBe(404)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(asked).toHaveLength(0)
  })

  test('anything at all when it cannot find out whether the file is ours', async () => {
    const cid = await cidForBytes(PNG)
    const { fetcher, asked } = gateway({ [`https://a.example/ipfs/${cid}`]: PNG })
    const response = await createIpfsProxy({ isOurs: () => Promise.reject(new Error('lookup down')), sources: ['https://a.example'], fetcher })(cid)
    expect(response.status).toBe(404)
    expect(asked).toHaveLength(0)
  })

  test('a file on the hide list, even though it is ours and a source has it', async () => {
    const hidden = [...HIDDEN_DETAILS][0]
    const { fetcher, asked } = gateway({ [`https://a.example/ipfs/${hidden}`]: PNG })
    const response = await createIpfsProxy({ isOurs: yes, sources: ['https://a.example'], fetcher })(hidden)
    expect(response.status).toBe(404)
    expect(asked).toHaveLength(0)
  })

  test('a verified file that is neither a details file nor an image', async () => {
    const html = text('<!doctype html><script>alert(1)</script>')
    const cid = await cidForBytes(html)
    const { fetcher } = gateway({ [`https://a.example/ipfs/${cid}`]: html })
    expect((await createIpfsProxy({ isOurs: yes, sources: ['https://a.example'], fetcher })(cid)).status).toBe(415)
  })

  test('says so when no source has the file, and does not let that answer be cached', async () => {
    const cid = await cidForBytes(PNG)
    const { fetcher } = gateway({})
    const response = await createIpfsProxy({ isOurs: yes, sources: ['https://a.example'], fetcher })(cid)
    expect(response.status).toBe(502)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })
})
