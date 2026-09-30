import { encodePaymentResponseHeader } from '@x402/core/http'
import { required, verifyPayment } from './payment'
import { publicJob, quote, runJob } from './runner'
import type { JobStore } from './store'
import { LaunchError, type PromotionalTokenAdapter } from './types'

export function createLaunchService(store: JobStore, adapter: PromotionalTokenAdapter, now: () => number = Date.now) {
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url)
      if (request.method === 'GET') {
        const id = url.searchParams.get('job') ?? (url.pathname.startsWith('/equilibrium/jobs/') ? url.pathname.slice('/equilibrium/jobs/'.length) : null)
        const job = id ? store.get(id) : undefined
        if (id && !job) throw new LaunchError(404, 'not_found', 'Unknown job')
        return Response.json({ mode: adapter.mode, jobs: job ? [publicJob(job)] : store.list().map(publicJob) }, { headers: { 'cache-control': 'no-store' } })
      }
      if (request.method !== 'POST') throw new LaunchError(405, 'method_not_allowed', 'Use GET or POST.')
      const text = await request.text()
      if (new TextEncoder().encode(text).byteLength > 16_384) throw new LaunchError(413, 'body_too_large', 'Request is limited to 16 KiB.')
      let raw: unknown
      try { raw = JSON.parse(text) } catch { throw new LaunchError(400, 'invalid_json', 'Expected JSON.') }
      const job = quote(store, adapter, raw, Math.floor(now() / 1000))
      const header = request.headers.get('payment-signature')
      if (!job.payment && !header) return required(job, url.origin + url.pathname)
      const payment = job.payment ?? await verifyPayment(header!, job, Math.floor(now() / 1000))
      const result = await runJob(store, adapter, job.id, payment, now)
      const settled = result.steps[0].state === 'complete'
      // A payment-response proves settlement only. HTTP 202 and the job describe partial fulfillment.
      return Response.json(publicJob(result), { status: result.state === 'complete' ? 200 : 202,
        headers: { 'cache-control': 'no-store', ...(settled ? { 'payment-response': encodePaymentResponseHeader({ success: true, transaction: result.steps[0].result!.transaction, network: `eip155:${job.terms.chainId}`, payer: job.request.payer }) } : {}) } })
    } catch (cause) {
      if (cause instanceof LaunchError) return Response.json({ error: cause.code, message: cause.message, mode: adapter.mode }, { status: cause.status })
      // Do not claim no issuance/charge after an unknown external result. Inspect the durable job.
      return Response.json({ error: 'reconciliation_required', message: 'The durable job retains submitted steps. Read its status before retrying.', mode: adapter.mode }, { status: 503 })
    }
  }
}
