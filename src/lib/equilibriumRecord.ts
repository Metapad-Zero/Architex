/** The free job record as the launch service projects it. Types only; the page never writes a job. */
export type JobMode = 'local' | 'fork' | 'testnet' | 'live'
export interface PublicJob {
  id: string; mode: JobMode; state: string; error?: string
  payment: { settled: boolean; fulfillment: string }
  // A record written before settlement evidence was recorded has no settlement, or omits the key.
  settlement?: { amount: string; transaction: string; nonce: string; fulfillment: string } | null
  // A record written by an older service may predate any of these, so every field is optional.
  funds?: { paid?: string; platformFee?: string; feesSpent?: string; quoteInventoryDeployed?: string; unallocatedHeld?: string; determinate?: boolean; refundable?: boolean; refundableAmount?: string; unresolvedEffects?: string[]; note?: string }
  supply: { issuance: string; custody: string; remote: string; pending: string; reconciled: boolean; evidence: string }
  steps: { id: string; chain: string; state: string; result?: { address?: string; transaction: string } }[]
}

export const JOB_MODES: readonly JobMode[] = ['local', 'fork', 'testnet', 'live']
export const MODE_LABELS: Record<JobMode, string> = { local: 'Local rehearsal', fork: 'Fork rehearsal', testnet: 'Public testnet', live: 'Live' }
/** How often an open record is read again while a launch is still resolving or the service was unreachable. */
export const REFRESH_MS = 10_000
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

/** A job whose record can still change without anyone asking: anything short of complete. */
export function isOpen(job: PublicJob): boolean {
  return job.state !== 'complete'
}

/** Keep reading while a launch is still resolving, or while the last read failed and the service may come back. */
export function shouldRefresh(jobs: PublicJob[], lastReadFailed: boolean): boolean {
  return lastReadFailed || jobs.some(isOpen)
}

/** The collapsed line: settlement and fulfillment named apart, so a settled charge never reads as a finished launch. */
export function jobSummary(job: PublicJob): string {
  const settled = job.settlement ? 'Settled' : job.payment.settled ? 'Payment settled, no settlement record' : 'Not settled'
  const fulfillment = job.state === 'complete' ? 'fulfilled' : job.state === 'awaiting_payment' ? 'not started' : 'fulfillment incomplete'
  return `${MODE_LABELS[job.mode]} · ${job.state} · ${settled} · ${fulfillment} · ${job.id.slice(0, 12)}`
}
