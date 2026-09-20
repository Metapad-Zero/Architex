import { cidForBytes } from './cid'
import { rememberVerified } from './ipfs'
import type { PreparedImage } from './prepareImage'
import { buildMetadataJson, ipfsUri, type MetadataInput } from './tokenMetadata'

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(binary)
}

/**
 * Pins a launch's details and returns the `ipfs://` string for the create transaction.
 *
 * The server is not taken at its word. The browser builds the same file and works out the address it
 * must have; an answer that names any other address is refused, so what goes on-chain always points at
 * exactly what the creator typed.
 */
export async function saveTokenDetails(input: MetadataInput, image: PreparedImage | undefined): Promise<string> {
  const fileBytes = new TextEncoder().encode(buildMetadataJson({ ...input, imageCid: image?.cid }))
  const expected = await cidForBytes(fileBytes)

  let response: Response
  try {
    response = await fetch('/api/metadata', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: input.name, symbol: input.symbol, description: input.description, website: input.website, x: input.x, telegram: input.telegram, image: image ? toBase64(image.bytes) : undefined }),
    })
  } catch {
    throw new Error('The details could not be saved. Check your connection and try again.')
  }
  const answer = (await response.json().catch(() => ({}))) as { uri?: unknown; cid?: unknown; error?: unknown }
  if (!response.ok) throw new Error(typeof answer.error === 'string' ? answer.error : 'The details could not be saved. Try again.')
  if (answer.cid !== expected || answer.uri !== ipfsUri(expected)) throw new Error('The saved details did not match what you entered. Try again.')

  await rememberVerified(expected, fileBytes)
  if (image) await rememberVerified(image.cid, image.bytes)
  return ipfsUri(expected)
}
