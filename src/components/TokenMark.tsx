import { tokenMonogram, tokenStamp, type Token } from '../lib/tokens'

/** A token's two-letter mark, stamped in the spot colour that belongs to that token. */
export function TokenMark({ token, className = '' }: { token: Pick<Token, 'address' | 'symbol'>; className?: string }) {
  return (
    <span className={`token-mark stamp-${tokenStamp(token)} ${className}`.trimEnd()} aria-hidden="true">
      {tokenMonogram(token)}
    </span>
  )
}

/** The two marks of a pool, the second tucked behind the first. */
export function PairMarks({ token0, token1 }: { token0: Pick<Token, 'address' | 'symbol'>; token1: Pick<Token, 'address' | 'symbol'> }) {
  return (
    <span className="pair-marks" aria-hidden="true">
      <TokenMark token={token0} />
      <TokenMark token={token1} />
    </span>
  )
}
