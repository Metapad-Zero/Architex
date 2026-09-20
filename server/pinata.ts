import type { FileToPin, PinnedFile, Pinner } from './pinner.js'

/**
 * Pinata, through its v3 REST API. The key needs the scopes `org:files:write` (upload, delete) and
 * `org:files:read` (list, for the cleanup report). Files go to the public network with the default
 * CIDv1 profile: raw leaves and 256 KiB chunks, so every file we accept is a single raw block whose
 * address is a plain SHA-256 (see src/lib/cid.ts).
 */
const UPLOAD_URL = 'https://uploads.pinata.cloud/v3/files'
const API_URL = 'https://api.pinata.cloud/v3'

export interface PinataListedFile {
  id: string
  cid: string
  name: string | null
  size: number
  created_at: string
  keyvalues: Record<string, string> | null
}

async function failure(response: Response, what: string): Promise<Error> {
  // The body can name the account; keep it out of anything a visitor might see.
  await response.body?.cancel()
  return new Error(`${what} failed with status ${response.status}`)
}

export function pinata(jwt: string): Pinner & { list(labels: Record<string, string>, limit: number): Promise<PinataListedFile[]> } {
  const auth = { Authorization: `Bearer ${jwt}` }
  return {
    async pin(file: FileToPin): Promise<PinnedFile> {
      const form = new FormData()
      form.set('network', 'public')
      form.set('cid_version', 'v1')
      form.set('name', file.name)
      form.set('keyvalues', JSON.stringify(file.labels))
      form.set('file', new Blob([file.bytes as BlobPart], { type: file.type }), file.name)
      const response = await fetch(UPLOAD_URL, { method: 'POST', headers: auth, body: form })
      if (!response.ok) throw await failure(response, 'Pinning')
      const body = (await response.json()) as { data?: { id?: unknown; cid?: unknown } }
      if (typeof body.data?.id !== 'string' || typeof body.data.cid !== 'string') throw new Error('Pinning returned no address')
      return { id: body.data.id, cid: body.data.cid }
    },

    async unpin(id: string): Promise<void> {
      const response = await fetch(`${API_URL}/files/public/${encodeURIComponent(id)}`, { method: 'DELETE', headers: auth })
      if (!response.ok && response.status !== 404) throw await failure(response, 'Unpinning')
    },

    async list(labels: Record<string, string>, limit: number): Promise<PinataListedFile[]> {
      const files: PinataListedFile[] = []
      let pageToken: string | undefined
      while (files.length < limit) {
        const params = new URLSearchParams({ limit: String(Math.min(250, limit - files.length)), order: 'ASC' })
        for (const [key, value] of Object.entries(labels)) params.set(`metadata[${key}]`, value)
        if (pageToken) params.set('pageToken', pageToken)
        const response = await fetch(`${API_URL}/files/public?${params.toString()}`, { headers: auth })
        if (!response.ok) throw await failure(response, 'Listing')
        const body = (await response.json()) as { data?: { files?: PinataListedFile[]; next_page_token?: string | null } }
        files.push(...(body.data?.files ?? []))
        pageToken = body.data?.next_page_token ?? undefined
        if (!pageToken) break
      }
      return files
    },
  }
}
