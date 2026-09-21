import { getAddress } from 'viem'

function powerOfTen(exponent: number): bigint {
  return 10n ** BigInt(Math.max(0, exponent))
}

export function parseAmount(input: string, decimals: number): bigint {
  const normalized = input.trim().replace(/,/g, '')
  if (!normalized || !/^\d*(?:\.\d*)?$/.test(normalized) || normalized === '.') {
    throw new Error('Invalid amount')
  }
  const [whole = '0', fraction = ''] = normalized.split('.')
  if (fraction.length > decimals) throw new Error(`Amount has more than ${decimals} decimal places`)
  return BigInt(whole || '0') * powerOfTen(decimals) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0')
}

function addSeparators(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function precisionPlan(value: bigint, decimals: number): { fractionDigits: number; quantum: bigint } {
  const base = powerOfTen(decimals)
  const whole = value / base
  if (whole > 0n) {
    const wholeDigits = whole.toString().length
    const fractionDigits = Math.min(decimals, Math.max(0, 6 - wholeDigits))
    const integerRoundingDigits = Math.max(0, wholeDigits - 6)
    return { fractionDigits, quantum: powerOfTen(decimals - fractionDigits + integerRoundingDigits) }
  }
  const fraction = (value % base).toString().padStart(decimals, '0')
  const first = fraction.search(/[1-9]/)
  const fractionDigits = first === -1 ? 0 : Math.min(decimals, first + 6)
  return { fractionDigits, quantum: powerOfTen(decimals - fractionDigits) }
}

export function formatAmount(value: bigint, decimals: number): string {
  if (value === 0n) return '0'
  const negative = value < 0n
  let absolute = negative ? -value : value
  if (decimals > 6 && absolute < powerOfTen(decimals - 6)) return negative ? '-<0.000001' : '<0.000001'

  let { fractionDigits: visibleFractionDigits, quantum } = precisionPlan(absolute, decimals)
  absolute = ((absolute + quantum / 2n) / quantum) * quantum
  ;({ fractionDigits: visibleFractionDigits, quantum } = precisionPlan(absolute, decimals))
  absolute = ((absolute + quantum / 2n) / quantum) * quantum

  const raw = absolute.toString().padStart(decimals + 1, '0')
  const whole = decimals === 0 ? raw : raw.slice(0, -decimals)
  const fractionStart = raw.length - decimals
  const fraction = decimals === 0 ? '' : raw.slice(fractionStart, fractionStart + visibleFractionDigits).replace(/0+$/, '')
  return `${negative ? '-' : ''}${addSeparators(whole)}${fraction ? `.${fraction}` : ''}`
}

/** LP tokens have 18 decimals, but a pool of two 6-decimal tokens mints ~1e9 wei for a real deposit — below formatAmount's 0.000001 floor. */
export function formatLp(value: bigint): string {
  if (value <= 0n || value >= powerOfTen(12)) return formatAmount(value, 18)
  const fraction = value.toString().padStart(18, '0')
  const first = fraction.search(/[1-9]/)
  return `0.${fraction.slice(0, first + 6).replace(/0+$/, '')}`
}

export function formatUsd(value: bigint, decimals = 6): string {
  const amount = formatAmount(value, decimals)
  return amount.startsWith('<') ? `$${amount}` : `$${amount}`
}

export function formatPct(bps: bigint | number): string {
  const value = BigInt(bps)
  if (value > 0n && value < 1n) return '<0.01%'
  const whole = value / 100n
  const fraction = (value % 100n).toString().padStart(2, '0')
  return `${whole}.${fraction}%`
}

export function shortAddress(value: string): string {
  try {
    const address = getAddress(value)
    return `${address.slice(0, 6)}…${address.slice(-4)}`
  } catch {
    return value
  }
}
