import { describe, expect, test } from 'bun:test'
import { cidForBytes } from '../cid'
import {
  METADATA_LIMITS,
  buildMetadataJson,
  cidOfIpfsUri,
  cleanDescription,
  cleanTelegram,
  cleanWebsite,
  cleanX,
  hasMetadata,
  ipfsUri,
  linkLabel,
  metadataErrors,
  parseMetadataJson,
  sniffImageType,
} from '../tokenMetadata'

const bytes = (value: string) => new TextEncoder().encode(value)
const IMAGE_CID = 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e'

describe('links a creator types', () => {
  test('a website becomes a plain https link', () => {
    expect(cleanWebsite('example.com')).toBe('https://example.com/')
    expect(cleanWebsite(' https://example.com/about?x=1 ')).toBe('https://example.com/about?x=1')
  })

  test('anything that is not a plain https link to a real host is refused', () => {
    for (const bad of [
      'http://example.com',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'ipfs://bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e',
      'https://user:pass@example.com',
      'https://example.com:8443',
      'https://localhost',
      'https://example.com/ with space',
      'https://example.com/' + 'a'.repeat(METADATA_LIMITS.urlChars),
      '',
    ]) {
      expect(cleanWebsite(bad)).toBe(undefined)
    }
  })

  test('an internationalised host is kept in its punycode form, so look-alikes show as what they are', () => {
    expect(cleanWebsite('https://аррӏе.com')).toBe('https://xn--80ak6aa92e.com/')
    expect(linkLabel('https://xn--80ak6aa92e.com/')).toBe('xn--80ak6aa92e.com')
  })

  test('X handles: a name, an @name or a link, always stored as x.com', () => {
    expect(cleanX('@architexdex')).toBe('https://x.com/architexdex')
    expect(cleanX('architexdex')).toBe('https://x.com/architexdex')
    expect(cleanX('https://twitter.com/architexdex/')).toBe('https://x.com/architexdex')
    expect(cleanX('https://x.com/architexdex')).toBe('https://x.com/architexdex')
    expect(cleanX('https://evil.example/architexdex')).toBe(undefined)
    expect(cleanX('https://x.com/architexdex/status/1')).toBe(undefined)
    expect(cleanX('a'.repeat(16))).toBe(undefined)
    expect(cleanX('bad handle')).toBe(undefined)
  })

  test('Telegram names', () => {
    expect(cleanTelegram('@examplegroup')).toBe('https://t.me/examplegroup')
    expect(cleanTelegram('https://t.me/examplegroup_chat')).toBe('https://t.me/examplegroup_chat')
    expect(cleanTelegram('abc')).toBe(undefined) // too short for Telegram
    expect(cleanTelegram('https://t.me/+invitecode')).toBe(undefined)
    expect(cleanTelegram('https://telegram.example/examplegroup')).toBe(undefined)
  })

  test('a link is labelled by where it really goes', () => {
    expect(linkLabel('https://www.example.com/about')).toBe('example.com')
    expect(linkLabel('https://x.com/architexdex')).toBe('@architexdex')
    expect(linkLabel('https://t.me/examplegroup')).toBe('@examplegroup')
  })
})

describe('descriptions', () => {
  test('are trimmed, keep their line breaks, and are counted in characters, not bytes', () => {
    expect(cleanDescription('  two\r\nlines  ')).toBe('two\nlines')
    expect(cleanDescription('é'.repeat(METADATA_LIMITS.descriptionChars))).toBe('é'.repeat(METADATA_LIMITS.descriptionChars))
    expect(cleanDescription('é'.repeat(METADATA_LIMITS.descriptionChars + 1))).toBe(undefined)
  })

  test('control characters are refused', () => {
    expect(cleanDescription(`bell${String.fromCharCode(7)}`)).toBe(undefined)
    expect(cleanDescription(`escape${String.fromCharCode(27)}[31m`)).toBe(undefined)
  })
})

describe('writing the file', () => {
  test('the same details always give the same bytes, keys in one order, empty fields left out', () => {
    const json = buildMetadataJson({ name: ' Smoke ', symbol: 'SMK', x: '@architexdex', description: 'A test.', imageCid: IMAGE_CID, website: 'example.com' })
    expect(json).toBe(
      `{"name":"Smoke","symbol":"SMK","description":"A test.","image":"ipfs://${IMAGE_CID}","external_link":"https://example.com/","twitter":"https://x.com/architexdex"}`,
    )
    expect(buildMetadataJson({ name: 'Smoke', symbol: 'SMK' })).toBe('{"name":"Smoke","symbol":"SMK"}')
  })

  test('its address can be worked out before it is uploaded', async () => {
    const cid = await cidForBytes(bytes(buildMetadataJson({ name: 'Smoke', symbol: 'SMK', description: 'A test.' })))
    expect(cid.startsWith('bafkrei')).toBe(true)
    expect(ipfsUri(cid).length).toBeLessThan(257) // the launchpad keeps at most 256 bytes
    expect(cidOfIpfsUri(ipfsUri(cid))).toBe(cid)
  })

  test('refuses details that do not pass the form checks', () => {
    expect(() => buildMetadataJson({ name: 'A', symbol: 'A', website: 'javascript:alert(1)' })).toThrow('not valid')
    expect(metadataErrors({ name: 'A', symbol: 'A', website: 'javascript:alert(1)', x: 'not a handle', telegram: 'x', imageCid: 'Qm123' })).toEqual({
      website: 'Enter an https address, like example.com.',
      x: 'Enter an X handle, like @architexdex.',
      telegram: 'Enter a Telegram name, like @yourgroup.',
      image: 'That image could not be prepared. Try another file.',
    })
  })

  test('knows when there is nothing to save', () => {
    expect(hasMetadata({ name: 'A', symbol: 'A', description: '  ' })).toBe(false)
    expect(hasMetadata({ name: 'A', symbol: 'A', telegram: '@examplegroup' })).toBe(true)
  })
})

describe('reading a file written by a stranger', () => {
  test('reads back exactly what the writer wrote', () => {
    const input = { name: 'Smoke', symbol: 'SMK', description: 'A test.', imageCid: IMAGE_CID, website: 'example.com', x: 'architexdex', telegram: 'examplegroup' }
    expect(parseMetadataJson(bytes(buildMetadataJson(input)))).toEqual({
      name: 'Smoke',
      symbol: 'SMK',
      description: 'A test.',
      image: `ipfs://${IMAGE_CID}`,
      external_link: 'https://example.com/',
      twitter: 'https://x.com/architexdex',
      telegram: 'https://t.me/examplegroup',
    })
  })

  test('understands the `website` key other launchpads write', () => {
    expect(parseMetadataJson(bytes('{"name":"A","symbol":"A","website":"https://example.com"}'))?.external_link).toBe('https://example.com/')
  })

  test('a bad field is dropped and the rest survives', () => {
    const file = parseMetadataJson(
      bytes(
        JSON.stringify({
          name: 'A',
          symbol: 'A',
          description: 'Fine.',
          image: 'https://tracker.example/pixel.png',
          external_link: 'javascript:alert(1)',
          twitter: 'https://evil.example/architexdex',
          telegram: { nested: true },
          unknown: '<script>alert(1)</script>',
        }),
      ),
    )
    expect(file).toEqual({ name: 'A', symbol: 'A', description: 'Fine.' })
  })

  test('an image is only ever an address we can verify', () => {
    expect(parseMetadataJson(bytes(`{"image":"ipfs://${IMAGE_CID}"}`))?.image).toBe(`ipfs://${IMAGE_CID}`)
    for (const image of [`ipfs://${IMAGE_CID}/logo.png`, 'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG', `https://ipfs.io/ipfs/${IMAGE_CID}`, 'data:image/png;base64,AAAA']) {
      expect(parseMetadataJson(bytes(JSON.stringify({ image })))?.image).toBe(undefined)
    }
  })

  test('refuses what is not a small JSON object', () => {
    expect(parseMetadataJson(new Uint8Array())).toBe(undefined)
    expect(parseMetadataJson(bytes('[]'))).toBe(undefined)
    expect(parseMetadataJson(bytes('"text"'))).toBe(undefined)
    expect(parseMetadataJson(bytes('{not json'))).toBe(undefined)
    expect(parseMetadataJson(Uint8Array.from([0xff, 0xfe, 0x7b, 0x7d]))).toBe(undefined) // not UTF-8
    expect(parseMetadataJson(bytes(JSON.stringify({ description: 'a'.repeat(METADATA_LIMITS.jsonBytes) })))).toBe(undefined)
  })
})

describe('what an image really is', () => {
  test('goes by the signature in the bytes', () => {
    expect(sniffImageType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toBe('image/png')
    expect(sniffImageType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0]))).toBe('image/jpeg')
    expect(sniffImageType(bytes('GIF89a........'))).toBe('image/gif')
    expect(sniffImageType(bytes('RIFF....WEBPVP8 '))).toBe('image/webp')
  })

  test('refuses SVG, HTML and anything else, whatever it claims to be', () => {
    expect(sniffImageType(bytes('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'))).toBe(undefined)
    expect(sniffImageType(bytes('<!doctype html><script>alert(1)</script>'))).toBe(undefined)
    expect(sniffImageType(bytes('RIFF....WAVEfmt '))).toBe(undefined)
    expect(sniffImageType(new Uint8Array())).toBe(undefined)
  })
})
