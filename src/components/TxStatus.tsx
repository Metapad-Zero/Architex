import { activeChain, txExplorerUrl } from '../chain'
import type { SwapTxStatus } from '../hooks/useSwap'
import type { LiquidityStatus } from '../hooks/useLiquidity'
import { CheckIcon, ExternalLinkIcon, XIcon } from './Icons'

interface TxStatusProps {
  status: SwapTxStatus | LiquidityStatus | undefined
}

export function TxStatus({ status }: TxStatusProps) {
  if (!status) return null
  if (status.kind === 'pending') {
    return (
      <div className="tx-line text-g700" role="status">
        <span>{'label' in status ? status.label : `Pending on ${activeChain.name}`}</span>
        {status.hash && (
          <a className="ml-auto inline-flex items-center gap-1 font-semibold underline" href={txExplorerUrl(status.hash)} target="_blank" rel="noreferrer">
            View on ArcScan <ExternalLinkIcon className="h-4 w-4" />
          </a>
        )}
      </div>
    )
  }
  if (status.kind === 'cancelled') {
    return (
      <div className="tx-line text-g700" role="status">
        <span>Transaction cancelled</span>
      </div>
    )
  }
  if (status.kind === 'confirmed') {
    return (
      <div className="tx-line text-gain" role="status">
        <CheckIcon />
        <span>{'summary' in status && status.summary ? status.summary : 'label' in status ? status.label : 'Confirmed'}{status.hash ? ' ·' : ''}</span>
        {status.hash && (
          <a className="ml-auto inline-flex items-center gap-1 font-semibold underline" href={txExplorerUrl(status.hash)} target="_blank" rel="noreferrer">
            View on ArcScan <ExternalLinkIcon className="h-4 w-4" />
          </a>
        )}
      </div>
    )
  }
  return (
    <div className="tx-line text-loss" role="alert">
      <XIcon />
      <span>Failed · {status.reason ?? 'Transaction reverted'}</span>
    </div>
  )
}
