import { formatUnits } from 'viem'
import { formatAmount } from '../lib/format'
import type { Token } from '../lib/tokens'
import { TokenSelect } from './TokenSelect'
import { TokenMark } from './TokenMark'

interface AmountFieldProps {
  id: string
  label: string
  amount: string
  onAmount: (value: string) => void
  token: Token | undefined
  tokens: readonly Token[]
  onToken: (token: Token) => void
  balances: ReadonlyMap<string, bigint>
  usdValue?: string
  readOnly?: boolean
  disabled?: boolean
  disableTokenSelect?: boolean
  /** False for amounts the user receives: no over-balance check and no Max shortcut. */
  checkBalance?: boolean
  /** Enter inside the field fires the sheet's primary action. */
  onSubmit?: () => void
  /** Marks the token trigger for the ⌘K shortcut. */
  hotkey?: string
}

function sanitizeAmount(value: string, decimals: number): string | undefined {
  const normalized = value.replace(/,/g, '').trim()
  if (normalized === '') return ''
  if (!/^\d*(?:\.\d*)?$/.test(normalized)) return undefined
  const [whole, fraction = ''] = normalized.split('.')
  if (fraction.length > decimals) return undefined
  if (normalized.startsWith('.')) return `0${normalized}`
  if ((whole?.length ?? 0) > 1 && whole?.startsWith('0') && !normalized.startsWith('0.')) {
    return normalized.replace(/^0+/, '') || '0'
  }
  return normalized
}

function editableBalance(value: bigint, decimals: number): string {
  const formatted = formatUnits(value, decimals)
  return formatted.includes('.') ? formatted.replace(/0+$/, '').replace(/\.$/, '') : formatted
}

export function AmountField({
  id,
  label,
  amount,
  onAmount,
  token,
  tokens,
  onToken,
  balances,
  usdValue,
  readOnly = false,
  disabled = false,
  disableTokenSelect = false,
  checkBalance = true,
  onSubmit,
  hotkey,
}: AmountFieldProps) {
  const balance = token ? balances.get(token.address.toLowerCase()) ?? 0n : 0n
  let overBalance = false
  if (checkBalance && token && amount) {
    try {
      const sanitized = sanitizeAmount(amount, token.decimals)
      if (sanitized) {
        const [whole = '0', fraction = ''] = sanitized.split('.')
        const raw = BigInt(whole || '0') * 10n ** BigInt(token.decimals) + BigInt((fraction + '0'.repeat(token.decimals)).slice(0, token.decimals) || '0')
        overBalance = raw > balance
      }
    } catch {
      overBalance = false
    }
  }

  return (
    <section className="amount-field" data-over-balance={overBalance}>
      <label htmlFor={id} className="amount-label">{label}</label>
      <div className="mt-2 flex items-center gap-3">
        <input
          id={id}
          className="amount-input min-w-0 flex-1"
          inputMode="decimal"
          pattern="[0-9]*[.]?[0-9]*"
          placeholder="0"
          value={amount}
          readOnly={readOnly}
          disabled={disabled}
          onChange={(event) => {
            const next = sanitizeAmount(event.target.value, token?.decimals ?? 18)
            if (next !== undefined) onAmount(next)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && onSubmit) {
              event.preventDefault()
              onSubmit()
            }
          }}
        />
        {disableTokenSelect && token ? (
          <span className="token-static">
            <TokenMark token={token} />
            <span>{token.symbol}</span>
          </span>
        ) : (
          <TokenSelect token={token} tokens={tokens} balances={balances} onSelect={onToken} disabled={disabled} label={`${label} token`} hotkey={hotkey} />
        )}
      </div>
      <div className="mt-2 flex min-h-6 items-center justify-between gap-3 text-sm">
        <span className="text-g500">{usdValue ?? ''}</span>
        {token && (
          <span className={overBalance ? 'text-loss' : 'text-g500'}>
            {overBalance ? `Not enough ${token.symbol}` : `Balance ${formatAmount(balance, token.decimals)}`}
            {checkBalance && !readOnly && balance > 0n && (
              <button type="button" className="ml-2 font-semibold text-ink underline" onClick={() => onAmount(editableBalance(balance, token.decimals))}>Max</button>
            )}
          </span>
        )}
      </div>
    </section>
  )
}
