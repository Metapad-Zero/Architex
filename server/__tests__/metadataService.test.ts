import { describe, expect, test } from 'bun:test'
import { bytesMatchCid, cidForBytes } from '../../src/lib/cid'
import { cidOfIpfsUri, parseMetadataJson } from '../../src/lib/tokenMetadata'
import { createMetadataService } from '../metadataService'
import type { FileToPin, Pinner } from '../pinner'

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))

function fakePinner(options: { lieAbout?: string } = {}) {
  const pinned = new Map<string, FileToPin>()
  const removed: string[] = []
  const pinner: Pinner = {
    async pin(file) {
      const cid = file.type === options.lieAbout ? 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku' : await cidForBytes(file.bytes)
      const id = `id-${pinned.size + 1}`
      pinned.set(id, file)
      return { id, cid }
    },
    unpin(id) {
      removed.push(id)
      pinned.delete(id)
      return Promise.resolve()
    },
  }
  return { pinner, pinned, removed }
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request('https://architex.fun/api/metadata', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://architex.fun', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const details = { name: 'Smoke', symbol: 'SMK', description: 'A test.', x: '@architex', image: base64(PNG) }

describe('saving a launch\'s details', () => {
  test('pins the image, then a file that names it, and answers with a string that fits on-chain', async () => {
    const { pinner, pinned } = fakePinner()
    const response = await createMetadataService({ pinner, gateway: undefined }).save(post(details), 'a')
    expect(response.status).toBe(200)
    const answer = (await response.json()) as { uri: string; cid: string; imageCid: string }

    expect(answer.imageCid).toBe(await cidForBytes(PNG))
    expect(cidOfIpfsUri(answer.uri)).toBe(answer.cid)
    expect(new TextEncoder().encode(answer.uri).length).toBeLessThan(257)

    const [image, file] = [...pinned.values()]
    expect(image.type).toBe('image/png')
    expect(image.labels).toEqual({ app: 'architex', kind: 'image' })
    expect(file.labels).toEqual({ app: 'architex', kind: 'metadata', image: answer.imageCid })
    expect(await bytesMatchCid(file.bytes, answer.cid)).toBe(true)
    expect(parseMetadataJson(file.bytes)).toEqual({ name: 'Smoke', symbol: 'SMK', description: 'A test.', image: `ipfs://${answer.imageCid}`, twitter: 'https://x.com/architex' })
  })

  test('stores what it checked, not what it was sent', async () => {
    const { pinner, pinned } = fakePinner()
    await createMetadataService({ pinner, gateway: undefined }).save(post({ name: 'A', symbol: 'A', description: 'Fine.', extra: '<script>alert(1)</script>', image_url: 'https://tracker.example/p.png' }), 'a')
    expect(new TextDecoder().decode([...pinned.values()][0].bytes)).toBe('{"name":"A","symbol":"A","description":"Fine."}')
  })

  test('details without an image are fine', async () => {
    const { pinner, pinned } = fakePinner()
    const response = await createMetadataService({ pinner, gateway: undefined }).save(post({ name: 'A', symbol: 'A', website: 'example.com' }), 'a')
    expect(response.status).toBe(200)
    expect(((await response.json()) as { imageCid: string | null }).imageCid).toBeNull()
    expect(pinned.size).toBe(1)
  })

  test('never reports an address the service did not confirm, and leaves nothing behind', async () => {
    const { pinner, pinned, removed } = fakePinner({ lieAbout: 'application/json' })
    const response = await createMetadataService({ pinner, gateway: undefined }).save(post(details), 'a')
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'The details could not be saved. Try again.' })
    expect(removed).toHaveLength(2) // the image that had already been pinned, and the file
    expect(pinned.size).toBe(0)
  })
})

describe('what it refuses', () => {
  const service = () => createMetadataService({ pinner: fakePinner().pinner, gateway: undefined })
  const status = async (request: Request) => (await service().save(request, 'a')).status

  test('other sites, and anything that is not JSON', async () => {
    expect(await status(post(details, { origin: 'https://evil.example' }))).toBe(403)
    expect(await status(post(details, { 'content-type': 'text/plain' }))).toBe(415)
    expect(await status(post('{not json'))).toBe(400)
    expect(await status(post('[]'))).toBe(400)
  })

  test('names and symbols the launchpad would refuse', async () => {
    expect(await status(post({ ...details, name: '' }))).toBe(400)
    expect(await status(post({ ...details, name: 'n'.repeat(33) }))).toBe(400)
    expect(await status(post({ ...details, symbol: 'S'.repeat(11) }))).toBe(400)
  })

  test('images that are not images, whatever they claim, and images over one block', async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')
    expect(await status(post({ ...details, image: base64(svg) }))).toBe(400)
    expect(await status(post({ ...details, image: 'not base64 !!' }))).toBe(400)
    const big = new Uint8Array(262_145)
    big.set(PNG)
    expect(await status(post({ ...details, image: btoa(Array.from(big, (byte) => String.fromCharCode(byte)).join('')) }))).toBe(400)
  })

  test('bad links, with the field named so the form can point at it', async () => {
    const response = await service().save(post({ name: 'A', symbol: 'A', website: 'javascript:alert(1)' }), 'a')
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Some details are not valid.', fields: { website: 'Enter an https address, like example.com.' } })
  })

  test('an empty save, and a body that is too large', async () => {
    expect(await status(post({ name: 'A', symbol: 'A' }))).toBe(400)
    expect(await status(post(details, { 'content-length': '400001' }))).toBe(413)
  })

  test('more than a few uploads from one place in ten minutes', async () => {
    let clock = 0
    const limited = createMetadataService({ pinner: fakePinner().pinner, gateway: undefined, now: () => clock })
    for (let count = 0; count < 8; count += 1) expect((await limited.save(post(details), 'same')).status).toBe(200)
    expect((await limited.save(post(details), 'same')).status).toBe(429)
    expect((await limited.save(post(details), 'someone-else')).status).toBe(200)
    clock += 10 * 60_000 + 1
    expect((await limited.save(post(details), 'same')).status).toBe(200)
  })
})

describe('before a pinning key is configured', () => {
  test('says so, and saves nothing', async () => {
    const service = createMetadataService({ pinner: undefined, gateway: undefined })
    expect(await service.status().json()).toEqual({ enabled: false, gateway: null, limits: { imageBytes: 262_144, descriptionChars: 280 } })
    expect((await service.save(post(details), 'a')).status).toBe(503)
  })

  test('once configured, it names the gateway to read from', async () => {
    const service = createMetadataService({ pinner: fakePinner().pinner, gateway: 'https://example-name-123.mypinata.cloud' })
    expect(((await service.status().json()) as { enabled: boolean; gateway: string }).gateway).toBe('https://example-name-123.mypinata.cloud')
  })
})
