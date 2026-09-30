import { useCallback, useEffect, useRef, useState } from 'react'
import { GHOST } from '../lib/format'
import { readiness } from '../lib/equilibriumNetwork'
import { JOB_MODES, MAX_FAILED_READS, fulfillment, jobSummary, recoveryNote, refreshDelay, supplyNote, supplyWithheld, usdcAmount, usdcLabel, type JobMode, type PublicJob } from '../lib/equilibriumRecord'
import infrastructure from '../lib/equilibriumInfrastructure.json'

/** A USDC figure a person can read, with the exact atoms kept underneath as the record of truth. */
function Money({ atoms, mode }: { atoms?: string; mode: JobMode }) {
  if (atoms === undefined) return <>{GHOST}</>
  return <>{usdcLabel(atoms, mode)}{usdcAmount(atoms) !== atoms && <span className="eq-atoms">{atoms} atoms</span>}</>
}

/** Public evidence stays separate from browser-controlled simulation balances and keeper profit. */
export function EquilibriumIntegration({ offline = false }: { offline?: boolean }) {
  const [jobs, setJobs] = useState<PublicJob[]>([])
  const [checkedAt, setCheckedAt] = useState<Date | null>(null)
  const [failedReads, setFailedReads] = useState(0)
  const [reading, setReading] = useState(false)
  const inFlight = useRef<AbortController | null>(null)
  // One read at a time. A new read (a click, or the timer) waits for the one already out.
  const read = useCallback((manual = false) => {
    if (offline || inFlight.current) return
    if (manual) setFailedReads(0)
    const controller = new AbortController()
    inFlight.current = controller; setReading(true)
    let timedOut = false
    const timeout = setTimeout(() => { timedOut = true; controller.abort() }, 5000)
    void fetch('/api/equilibrium', { signal: controller.signal, cache: 'no-store' }).then(async (response) => {
      if (!response.ok) throw new Error('Unavailable')
      const body = await response.json() as { jobs?: PublicJob[] }
      const records = (body.jobs ?? []).filter((job) => JOB_MODES.includes(job.mode))
      if (controller.signal.aborted) return
      setJobs(records); setFailedReads(0)
    }).catch(() => {
      // An abort that is not the timeout means the section unmounted: nothing to report.
      if (controller.signal.aborted && !timedOut) return
      // Keep the last good records on screen; the status says plainly that they may be out of date.
      setFailedReads((count) => count + 1)
    }).finally(() => {
      clearTimeout(timeout)
      if (inFlight.current !== controller) return
      inFlight.current = null; setReading(false); setCheckedAt(new Date())
    })
  }, [offline])
  useEffect(() => {
    const initialRead = setTimeout(() => read(), 0)
    return () => { clearTimeout(initialRead); const current = inFlight.current; inFlight.current = null; current?.abort() }
  }, [read])
  const delay = refreshDelay(jobs, failedReads)
  const polling = !offline && checkedAt !== null && delay !== null
  const readStatus = failedReads > 0
    ? jobs.length ? 'Job service unavailable. Records below are from the last successful read; dated infrastructure observations remain available.' : 'Job service unavailable. Dated infrastructure observations remain available.'
    : checkedAt === null ? 'Reading the public job record…' : jobs.length ? 'Job records are free to read.' : 'No EQUILIBRIUM issuance or market fulfillment is recorded here.'
  useEffect(() => {
    if (!polling || reading || delay === null) return
    // Schedule after each completed read. Single-flight and a timeout prevent overlapping calls.
    const timer = setTimeout(() => read(), delay)
    return () => clearTimeout(timer)
  }, [polling, reading, delay, checkedAt, read])
  return <section className="eq-record eq-integration" aria-labelledby="eq-integration-title">
    <div className="eq-section-head"><h2 id="eq-integration-title">The integration record</h2><span className="eq-mode">Paid launch closed</span></div>
    <p className="eq-muted">Chain infrastructure has been read publicly. Token routes still need public round trips and funded pools. Local and fork rehearsals are labeled separately.</p>
    <div className="eq-route-grid">{readiness().routes.map((route) => <div key={route.chain} className="eq-route">
      <h3>{route.name}</h3><p>{route.venue}</p><span className="eq-health" data-health="offline">Route closed · public transfer untested</span>
      <p className="eq-muted">{route.prerequisite}</p>
      <dl>{infrastructure.observations.filter((o) => o.chain === route.chain).map((observation) => <div key={observation.network}><dt>{observation.mode === 'live' ? 'Mainnet read' : 'Testnet read'}</dt><dd>{'actualId' in observation ? observation.actualId : 'cluster' in observation ? observation.cluster : 'Unverified'}</dd></div>)}</dl>
    </div>)}</div>
    <p className="eq-muted">Infrastructure observed {infrastructure.observedAt}. Bytecode presence does not establish a working token route.</p>
    <div className="eq-read-row">
      <p role="status">{offline ? 'Offline demonstration. Durable job records require the local service; dated infrastructure observations are included.' : readStatus}</p>
      {!offline && <div className="eq-read-controls">
        {checkedAt && <span className="eq-muted">Last checked <time dateTime={checkedAt.toISOString()}>{checkedAt.toLocaleTimeString()}</time>{polling ? failedReads > 0 ? ` · retrying in ${delay / 1000} s` : ' · checking every 10 s while authorized work can recover' : ' · automatic checks stopped'}</span>}
        <button type="button" className="eq-secondary" onClick={() => read(true)} disabled={reading}>{reading ? 'Checking…' : 'Check again'}</button>
      </div>}
    </div>
    {!offline && failedReads >= MAX_FAILED_READS && <p className="eq-muted">Automatic checks stopped after {MAX_FAILED_READS} failed reads. Use Check again to retry.</p>}
    {jobs.map((job) => <details key={job.id} className="eq-tools"><summary>{jobSummary(job)}</summary>
      <div className="eq-tools-content"><section><h3>Supply from recorded steps</h3><dl className="eq-ledger">
        <div><dt>Issued atoms</dt><dd>{supplyWithheld(job) ? 'Withheld' : job.supply.issuance ?? 'Withheld'}</dd></div><div><dt>Canonical custody</dt><dd>{supplyWithheld(job) ? 'Withheld' : job.supply.custody ?? 'Withheld'}</dd></div><div><dt>Remote atoms</dt><dd>{supplyWithheld(job) ? 'Withheld' : job.supply.remote ?? 'Withheld'}</dd></div><div><dt>Pending claim</dt><dd>{supplyWithheld(job) ? 'Withheld' : job.supply.pending ?? 'Withheld'}</dd></div>
      </dl><p>{supplyNote(job)}</p>
      <p>Payment {job.payment.settled ? 'settled' : 'unsettled'} · fulfillment {fulfillment(job) === 'not_started' ? 'not started' : fulfillment(job)}. {job.mode === 'local' ? 'All payments and addresses in this record are synthetic.' : ''}</p>
      <p className="eq-muted">{recoveryNote(job)}</p>
      {job.error && job.state !== 'complete' && <p className="eq-muted">Last attempt: {job.error}</p>}</section>
      {/* The charge is shown on its own: settling it never means the launch was fulfilled. */}
      <section><h3>Settlement and funds</h3>
        {job.settlement
          ? <><dl className="eq-ledger"><div><dt>Settled amount</dt><dd><Money atoms={job.settlement.amount} mode={job.mode} /></dd></div><div><dt>Authorization nonce</dt><dd>{job.settlement.nonce.slice(0, 12)}…</dd></div><div><dt>Launch fulfillment</dt><dd>{job.settlement.fulfillment}</dd></div></dl>
            <p className="eq-muted eq-settlement-tx">Settlement transaction {job.settlement.transaction}</p></>
          : <p>{job.payment.settled ? 'Payment settled before settlement evidence was recorded. This older record has no separate settlement entry.' : 'No settlement is recorded for this job.'}</p>}
        {job.funds ? <>
          <dl className="eq-ledger">
            <div><dt>Paid</dt><dd><Money atoms={job.funds.paid} mode={job.mode} /></dd></div>
            <div><dt>Platform fee</dt><dd><Money atoms={job.funds.platformFee} mode={job.mode} /></dd></div><div><dt>Execution fees spent</dt><dd><Money atoms={job.funds.feesSpent} mode={job.mode} /></dd></div>
            <div><dt>Quote inventory deployed</dt><dd><Money atoms={job.funds.quoteInventoryDeployed} mode={job.mode} /></dd></div><div><dt>Unallocated held</dt><dd><Money atoms={job.funds.unallocatedHeld} mode={job.mode} /></dd></div>
          </dl>
          {job.funds.note && <p>{job.funds.note}</p>}
          {(job.funds.unresolvedEffects?.length ?? 0) > 0 && <p className="eq-muted">Outstanding operations: {job.funds.unresolvedEffects!.join(', ')}. No refund can be decided until these resolve.</p>}
          {job.funds.refundable && job.funds.refundableAmount !== undefined && <p className="eq-muted">Determinate unspent remainder: {usdcLabel(job.funds.refundableAmount, job.mode)} ({job.funds.refundableAmount} atoms). This states what is unspent; no refund path is open.</p>}
        </> : <p className="eq-muted">This record predates the fund accounting.</p>}
      </section>
      <section><h3>Fulfillment steps</h3><ol className="eq-job-steps">{job.steps.map((step) => <li key={step.id}><p>{step.id} · {step.state}</p>{step.result && <p className="eq-muted">{step.result.address ?? step.result.transaction}</p>}</li>)}</ol></section></div>
    </details>)}
    <p><a href="/equilibrium-infrastructure.json" download>Download dated chain observations</a> · <a href="/equilibrium-release-preview.md" download>Download the release preview</a></p>
  </section>
}
