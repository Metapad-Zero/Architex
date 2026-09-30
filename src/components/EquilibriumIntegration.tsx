import { useEffect, useState } from 'react'
import { GHOST } from '../lib/format'
import { readiness } from '../lib/equilibriumNetwork'
import infrastructure from '../lib/equilibriumInfrastructure.json'

interface PublicJob {
  id: string; mode: 'local' | 'fork' | 'testnet' | 'live'; state: string
  payment: { settled: boolean; fulfillment: string }
  settlement: { amount: string; transaction: string; nonce: string; fulfillment: string } | null
  // A record written by an older service may predate any of these, so every field is optional.
  funds?: { paid?: string; platformFee?: string; feesSpent?: string; quoteInventoryDeployed?: string; unallocatedHeld?: string; determinate?: boolean; refundable?: boolean; refundableAmount?: string; unresolvedEffects?: string[]; note?: string }
  supply: { issuance: string; custody: string; remote: string; pending: string; reconciled: boolean; evidence: string }
  steps: { id: string; chain: string; state: string; result?: { address?: string; transaction: string } }[]
}
const labels = { local: 'Local rehearsal', fork: 'Fork rehearsal', testnet: 'Public testnet', live: 'Live' }
/** Public evidence stays separate from browser-controlled simulation balances and keeper profit. */
export function EquilibriumIntegration({ offline = false }: { offline?: boolean }) {
  const [jobs, setJobs] = useState<PublicJob[]>([])
  const [readStatus, setReadStatus] = useState('Reading the public job record…')
  useEffect(() => {
    if (offline) return
    const controller = new AbortController()
    const timeout = setTimeout(() => { controller.abort(); setReadStatus('Job service unavailable. Dated infrastructure observations remain available.') }, 5000)
    void fetch('/api/equilibrium', { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error('Unavailable')
      const body = await response.json() as { jobs?: PublicJob[] }
      const records = (body.jobs ?? []).filter((job) => ['local', 'fork', 'testnet', 'live'].includes(job.mode))
      setJobs(records); setReadStatus(records.length ? 'Job records are free to read.' : 'No EQUILIBRIUM issuance or market fulfillment is recorded here.')
    }).catch(() => { if (!controller.signal.aborted) setReadStatus('Job service unavailable. The dated infrastructure observations below remain available.') })
      .finally(() => clearTimeout(timeout))
    return () => { clearTimeout(timeout); controller.abort() }
  }, [offline])
  return <section className="eq-record eq-integration" aria-labelledby="eq-integration-title">
    <div className="eq-section-head"><h2 id="eq-integration-title">The integration record</h2><span className="eq-mode">Paid launch closed</span></div>
    <p className="eq-muted">Chain infrastructure has been read publicly. Token routes still need public round trips and funded pools. Local and fork rehearsals are labeled separately.</p>
    <div className="eq-route-grid">{readiness().routes.map((route) => <div key={route.chain} className="eq-route">
      <h3>{route.name}</h3><p>{route.venue}</p><span className="eq-health" data-health="offline">Route closed · public transfer untested</span>
      <p className="eq-muted">{route.prerequisite}</p>
      <dl>{infrastructure.observations.filter((o) => o.chain === route.chain).map((observation) => <div key={observation.network}><dt>{observation.mode === 'live' ? 'Mainnet read' : 'Testnet read'}</dt><dd>{'actualId' in observation ? observation.actualId : 'cluster' in observation ? observation.cluster : 'Unverified'}</dd></div>)}</dl>
    </div>)}</div>
    <p className="eq-muted">Infrastructure observed {infrastructure.observedAt}. Bytecode presence does not establish a working token route.</p>
    <p role="status">{offline ? 'Offline demonstration. Durable job records require the local service; dated infrastructure observations are included.' : readStatus}</p>
    {jobs.map((job) => <details key={job.id} className="eq-tools"><summary>{labels[job.mode]} · {job.state} · {job.id.slice(0, 12)}</summary>
      <div className="eq-tools-content"><section><h3>Supply from recorded steps</h3><dl className="eq-ledger">
        <div><dt>Issued atoms</dt><dd>{job.supply.issuance}</dd></div><div><dt>Canonical custody</dt><dd>{job.supply.custody}</dd></div><div><dt>Remote atoms</dt><dd>{job.supply.remote}</dd></div><div><dt>Pending claim</dt><dd>{job.supply.pending}</dd></div>
      </dl><p>{job.supply.reconciled ? 'Recorded steps reconcile.' : 'Unresolved operations: reconcile external evidence before reporting supply.'}</p>
      <p>Payment {job.payment.settled ? 'settled' : 'unsettled'} · fulfillment {job.payment.fulfillment}. {job.mode === 'local' ? 'All payments and addresses in this record are synthetic.' : ''}</p></section>
      {/* The charge is shown on its own: settling it never means the launch was fulfilled. */}
      <section><h3>Settlement and funds</h3>
        {job.settlement
          ? <><dl className="eq-ledger"><div><dt>Settled amount</dt><dd>{job.settlement.amount}</dd></div><div><dt>Authorization nonce</dt><dd>{job.settlement.nonce.slice(0, 12)}…</dd></div><div><dt>Launch fulfillment</dt><dd>{job.settlement.fulfillment}</dd></div></dl>
            <p className="eq-muted eq-settlement-tx">Settlement transaction {job.settlement.transaction}</p></>
          : <p>No settlement is recorded for this job.</p>}
        {job.funds ? <>
          <dl className="eq-ledger">
            <div><dt>Platform fee</dt><dd>{job.funds.platformFee ?? GHOST}</dd></div><div><dt>Execution fees spent</dt><dd>{job.funds.feesSpent ?? GHOST}</dd></div>
            <div><dt>Quote inventory deployed</dt><dd>{job.funds.quoteInventoryDeployed ?? GHOST}</dd></div><div><dt>Unallocated held</dt><dd>{job.funds.unallocatedHeld ?? GHOST}</dd></div>
          </dl>
          {job.funds.note && <p>{job.funds.note}</p>}
          {(job.funds.unresolvedEffects?.length ?? 0) > 0 && <p className="eq-muted">Outstanding operations: {job.funds.unresolvedEffects!.join(', ')}. No refund can be decided until these resolve.</p>}
          {job.funds.refundable && <p className="eq-muted">Determinate unspent remainder: {job.funds.refundableAmount}. This states what is unspent; no refund path is open.</p>}
        </> : <p className="eq-muted">This record predates the fund accounting.</p>}
      </section>
      <section><h3>Fulfillment steps</h3><ol className="eq-job-steps">{job.steps.map((step) => <li key={step.id}><p>{step.id} · {step.state}</p>{step.result && <p className="eq-muted">{step.result.address ?? step.result.transaction}</p>}</li>)}</ol></section></div>
    </details>)}
    <p><a href="/equilibrium-infrastructure.json" download>Download dated chain observations</a> · <a href="/equilibrium-release-preview.md" download>Download the release preview</a></p>
  </section>
}
