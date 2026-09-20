import { createMetadataService } from '../server/metadataService.js'
import { pinata } from '../server/pinata.js'

/**
 * GET  /api/metadata  whether details can be saved, and which gateway to read from first
 * POST /api/metadata  saves a launch's details and answers with the `ipfs://` string to put on-chain
 *
 * Imports here and in everything this file reaches carry a `.js` extension: Vercel runs functions as native
 * Node modules, which resolve nothing without one. TypeScript, Vite and Bun all map `.js` back to the `.ts` file.
 *
 * Environment (set in Vercel, never in the repository):
 *   PINATA_JWT    a Pinata API key limited to org:files:write and org:files:read
 *   IPFS_GATEWAY  optional; the account's gateway host, e.g. example-name-123.mypinata.cloud
 */
function gateway(): string | undefined {
  const host = process.env.IPFS_GATEWAY?.trim().replace(/^https:\/\//, '').replace(/\/+$/, '')
  return host && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) ? `https://${host}` : undefined
}

const jwt = process.env.PINATA_JWT?.trim()
const service = createMetadataService({ pinner: jwt ? pinata(jwt) : undefined, gateway: gateway() })

export function GET(): Response {
  return service.status()
}

export function POST(request: Request): Promise<Response> {
  const client = request.headers.get('x-real-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
  return service.save(request, client)
}
