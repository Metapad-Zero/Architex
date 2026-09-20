import { createIpfsProxy } from '../../server/ipfsProxy.js'
import { pinata } from '../../server/pinata.js'

/**
 * GET /api/ipfs/<cid>  a launch's details file or image, verified, immutable, from our own domain.
 * See server/ipfsProxy.ts for what it will and will not serve. Environment: PINATA_JWT, IPFS_GATEWAY.
 */
function accountGateway(): string | undefined {
  const host = process.env.IPFS_GATEWAY?.trim().replace(/^https:\/\//, '').replace(/\/+$/, '')
  return host && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) ? `https://${host}` : undefined
}

const jwt = process.env.PINATA_JWT?.trim()
const pins = jwt ? pinata(jwt) : undefined
const own = accountGateway()
const serve = createIpfsProxy({
  isOurs: (cid) => (pins ? pins.has(cid, { app: 'architex' }) : Promise.resolve(false)),
  sources: [...(own ? [own] : []), 'https://gateway.pinata.cloud'],
})

export function GET(request: Request): Promise<Response> {
  const cid = new URL(request.url).pathname.split('/').filter(Boolean).pop() ?? ''
  return serve(cid)
}
