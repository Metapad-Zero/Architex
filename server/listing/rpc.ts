/**
 * A small JSON-RPC client for Arc's public endpoints, built for their limits.
 *
 * Measured on mainnet (2026-09-22): rpc.mainnet.arc.io answers eth_getLogs over at most 10,000 blocks ("requested
 * range too large" above that) and allows about three eth_getLogs a second before it answers "rate limit exceeded"
 * (JSON-RPC error -32005, HTTP 200). Other calls are far less limited. So a request that is refused for load is
 * retried with a growing, jittered delay, on the next endpoint in the list; a request that is refused for what it
 * asks (a revert, a bad parameter, a range that is too wide) fails at once, for the caller to change.
 */
export interface RpcOptions {
  /** Endpoints, most preferred first. A retry moves to the next one; a success is remembered. */
  urls: readonly string[]
  fetcher?: typeof fetch
  /** Per request. */
  timeoutMs?: number
  /** Tries per call, across endpoints. */
  attempts?: number
  /** First retry delay; doubles each time. */
  baseDelayMs?: number
  sleep?: (ms: number) => Promise<void>
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number | undefined,
    /** True when asking again (later, or elsewhere) may succeed. */
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'RpcError'
  }
}

export interface Rpc {
  request<T>(method: string, params: readonly unknown[]): Promise<T>
}

const RATE_LIMITED = -32005

/** Whether an error means "ask for fewer blocks or fewer results", which retrying unchanged cannot fix. */
export function isTooMuchData(error: unknown): boolean {
  if (!(error instanceof RpcError) || error.retryable) return false
  return error.code === -32012 || /range|too many|more than|too large|limit|exceed/i.test(error.message)
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}

export function createRpc(options: RpcOptions): Rpc {
  if (options.urls.length === 0) throw new Error('No RPC endpoint configured.')
  const fetcher = options.fetcher ?? fetch
  const timeoutMs = options.timeoutMs ?? 10_000
  const attempts = options.attempts ?? 6
  const baseDelayMs = options.baseDelayMs ?? 250
  const sleep = options.sleep ?? defaultSleep
  let preferred = 0
  let id = 0

  async function once<T>(url: string, method: string, params: readonly unknown[]): Promise<T> {
    let response: Response
    try {
      response = await fetcher(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: (id += 1), method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw new RpcError(`${method}: ${describe(error)}`, undefined, true)
    }
    if (response.status === 429 || response.status >= 500) throw new RpcError(`${method}: HTTP ${response.status}`, undefined, true)
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new RpcError(`${method}: the endpoint did not answer with JSON (HTTP ${response.status})`, undefined, true)
    }
    if (typeof body !== 'object' || body === null) throw new RpcError(`${method}: malformed answer`, undefined, true)
    const { result, error } = body as { result?: unknown; error?: { code?: unknown; message?: unknown } }
    if (error) {
      const code = typeof error.code === 'number' ? error.code : undefined
      const message = typeof error.message === 'string' ? error.message : 'unknown error'
      // Load, and an endpoint that has not caught up with a block another endpoint already served, pass with time.
      const retryable =
        code === RATE_LIMITED || /rate limit|too many requests|timeout|timed out|temporarily|unavailable|header not found|unknown block|beyond (the )?current head|not (yet )?available/i.test(message)
      throw new RpcError(`${method}: ${message}`, code, retryable)
    }
    if (!('result' in body)) throw new RpcError(`${method}: the answer has no result`, undefined, true)
    return result as T
  }

  return {
    async request<T>(method: string, params: readonly unknown[]): Promise<T> {
      let last: unknown
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const index = (preferred + attempt) % options.urls.length
        try {
          const result = await once<T>(options.urls[index], method, params)
          preferred = index
          return result
        } catch (error) {
          if (error instanceof RpcError && !error.retryable) throw error
          last = error
          if (attempt < attempts - 1) await sleep(baseDelayMs * 2 ** attempt * (0.75 + Math.random() / 2))
        }
      }
      throw last instanceof Error ? last : new RpcError(`${method}: failed`, undefined, true)
    },
  }
}

/** Runs `task` over `items` with at most `limit` in flight, in order of start. */
export async function eachLimited<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const item = items[next]
      next += 1
      await task(item)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
}
