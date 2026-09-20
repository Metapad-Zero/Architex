import type { Connect, Plugin } from 'vite'
import { bytesMatchCid, cidForBytes } from '../src/lib/cid.js'
import { createMetadataService } from './metadataService.js'
import type { FileToPin, PinnedFile, Pinner } from './pinner.js'

/**
 * Local stand-in for the pinning service and its gateway, for `vite dev` only.
 *
 * `/api/metadata` behaves exactly as it does in production (the same service code, the same checks),
 * but files are kept in memory, and `/ipfs/<cid>` serves them back, so the whole path from the form to
 * a verified image on the token page can be exercised without a key or a network. Nothing here is
 * bundled into the app or deployed.
 */
function memoryPinner(files: Map<string, { bytes: Uint8Array; type: string }>): Pinner {
  return {
    async pin(file: FileToPin): Promise<PinnedFile> {
      const cid = await cidForBytes(file.bytes)
      files.set(cid, { bytes: file.bytes, type: file.type })
      return { id: cid, cid }
    },
    unpin(id: string): Promise<void> {
      files.delete(id)
      return Promise.resolve()
    },
  }
}

async function readBody(req: Connect.IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return new Uint8Array(Buffer.concat(chunks))
}

export function devMetadata(): Plugin {
  const files = new Map<string, { bytes: Uint8Array; type: string }>()
  return {
    name: 'architex-dev-metadata',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        void (async () => {
          const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

          if (url.pathname === '/api/metadata') {
            const service = createMetadataService({ pinner: memoryPinner(files), gateway: url.origin })
            const headers = new Headers()
            for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(key, value)
            const response =
              req.method === 'POST'
                ? await service.save(new Request(url, { method: 'POST', headers, body: (await readBody(req)) as BodyInit }), req.socket.remoteAddress ?? 'local')
                : service.status()
            res.statusCode = response.status
            response.headers.forEach((value, key) => res.setHeader(key, value))
            res.end(Buffer.from(await response.arrayBuffer()))
            return
          }

          const match = /^\/ipfs\/([a-z2-7]{59})$/.exec(url.pathname)
          if (match) {
            const file = files.get(match[1])
            if (!file || !(await bytesMatchCid(file.bytes, match[1]))) {
              res.statusCode = 404
              res.end('not pinned here')
              return
            }
            res.statusCode = 200
            res.setHeader('content-type', file.type)
            res.setHeader('cache-control', 'public, max-age=31536000, immutable')
            res.setHeader('x-content-type-options', 'nosniff')
            res.end(Buffer.from(file.bytes))
            return
          }
          next()
        })().catch(next)
      })
    },
  }
}
