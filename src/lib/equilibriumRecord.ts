/** The free job record as the launch service projects it. Types only; the page never writes a job. */
export type JobMode = 'local' | 'fork' | 'testnet' | 'live'
export interface PublicJob {
  id: string; mode: JobMode; state: string; error?: string
  payment: { settled: boolean; fulfillment: string }
  /** Only the service knows whether its unattended runner can revisit this job. */
  recovery?: { automatic: boolean; reason: string }
  // A record written before settlement evidence was recorded has no settlement, or omits the key.
  settlement?: { amount: string; transaction: string; nonce: string; fulfillment: string } | null
  // A record written by an older service may predate any of these, so every field is optional.
  funds?: { paid?: string; platformFee?: string; feesSpent?: string; quoteInventoryDeployed?: string; unallocatedHeld?: string; determinate?: boolean; refundable?: boolean; refundableAmount?: string; unresolvedEffects?: string[]; note?: string }
  supply: { issuance: string | null; custody: string | null; remote: string | null; pending: string | null; reconciled: boolean; evidence: string }
  steps: { id: string; kind?: string; chain: string; state: string; result?: { address?: string; transaction: string } }[]
}

export const JOB_MODES: readonly JobMode[] = ['local', 'fork', 'testnet', 'live']
export const MODE_LABELS: Record<JobMode, string> = { local: 'Local rehearsal', fork: 'Fork rehearsal', testnet: 'Public testnet', live: 'Live' }
/** Delay after a successful read while authorized work can progress or recover. */
export const REFRESH_MS = 10_000
/** Initial failure plus at most two automatic outage retries, then a manual read is required. */
export const MAX_FAILED_READS = 3
const USDC_DECIMALS = 6

/**
 * Six-decimal USDC atoms as an exact amount: `27200000` is `27.2`. Money is never rounded here, so
 * the figure a person reads is the figure that settled. Anything that is not canonical atoms is
 * returned unchanged rather than guessed at.
 */
export function usdcAmount(atoms: string): string {
  if (!/^(0|[1-9]\d*)$/.test(atoms)) return atoms
  const padded = atoms.padStart(USDC_DECIMALS + 1, '0')
  const whole = padded.slice(0, -USDC_DECIMALS).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const fraction = padded.slice(-USDC_DECIMALS).replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole
}

/** A local record's money is synthetic and says so wherever an amount appears. */
export function usdcLabel(atoms: string, mode: JobMode): string {
  return `${usdcAmount(atoms)} ${mode === 'local' ? 'synthetic USDC' : 'USDC'}`
}

/** Fail closed on older records: state alone cannot distinguish a blocked job from recoverable work. */
export function isOpen(job: PublicJob): boolean {
  return job.state !== 'complete' && job.state !== 'awaiting_payment' && job.recovery?.automatic === true
}

/** Back off during an outage; never keep retrying a known unpaid/blocked record. */
export function refreshDelay(jobs: PublicJob[], failedReads: number): number | null {
  if (failedReads >= MAX_FAILED_READS) return null
  if (jobs.some(isOpen)) return REFRESH_MS * 2 ** Math.max(0, failedReads - 1)
  // When the initial read failed, job eligibility is unknown. Allow only the same bounded retries.
  return failedReads > 0 && jobs.length === 0 ? REFRESH_MS * 2 ** (failedReads - 1) : null
}

export function shouldRefresh(jobs: PublicJob[], failedReads = 0): boolean {
  return refreshDelay(jobs, failedReads) !== null
}

export function fulfillment(job: PublicJob): 'not_started' | 'incomplete' | 'complete' {
  if (job.state === 'complete') return 'complete'
  if (job.payment.fulfillment === 'not_started' || (job.state === 'awaiting_payment' && job.steps.every((step) => step.state === 'planned'))) return 'not_started'
  return 'incomplete'
}

/** Older services could expose stale numbers for a prepared supply step. Hide those too. */
export function supplyWithheld(job: PublicJob): boolean {
  return job.supply.evidence === 'withheld' || job.steps.some((step) =>
    step.state === 'prepared' && ['canonical', 'debit', 'credit'].includes(step.kind ?? step.id.split(':')[0]))
}

export function supplyNote(job: PublicJob): string {
  if (supplyWithheld(job)) return 'Supply amounts withheld until finalized receipts are recorded.'
  if (job.supply.evidence === 'not_started' || fulfillment(job) === 'not_started') return 'Issuance has not started. No supply-changing operation is recorded.'
  return job.supply.reconciled ? 'Recorded supply steps reconcile.' : 'Supply reflects recorded receipts; other operations remain unresolved.'
}

export function recoveryNote(job: PublicJob): string {
  if (isOpen(job)) return 'The service can progress or recover this authorized job.'
  if (job.state === 'complete') return 'Fulfillment is complete. Automatic checks stopped.'
  if (job.state === 'awaiting_payment') return 'No authorization is held. Automatic checks stopped.'
  return job.recovery ? 'Automatic recovery is blocked. Review the last attempt before resuming.' : 'This older record does not report recovery eligibility. Check again manually.'
}

/** The collapsed line: settlement and fulfillment named apart, so a settled charge never reads as a finished launch. */
export function jobSummary(job: PublicJob): string {
  const settled = job.settlement ? 'Settled' : job.payment.settled ? 'Payment settled, no settlement record' : 'Not settled'
  const status = fulfillment(job)
  const label = status === 'complete' ? 'fulfilled' : status === 'not_started' ? 'not started' : 'fulfillment incomplete'
  return `${MODE_LABELS[job.mode]} · ${job.state} · ${settled} · ${label} · ${job.id.slice(0, 12)}`
}
