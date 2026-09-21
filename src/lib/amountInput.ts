import { parseAmount } from './format'

/** The text an amount field should hold after an edit, or undefined to reject the edit. */
export function sanitizeAmount(value: string, decimals: number): string | undefined {
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

/** An empty field is no amount; any other text that does not parse is an error, never a silent 0. */
export function parseOptionalAmount(
  text: string,
  decimals: number,
): { amount: bigint; error?: undefined } | { amount?: undefined; error: string } {
  if (text.trim() === '') return { amount: 0n }
  try {
    return { amount: parseAmount(text, decimals) }
  } catch {
    return { error: `Enter an amount with up to ${decimals} decimal places, or leave it empty.` }
  }
}
