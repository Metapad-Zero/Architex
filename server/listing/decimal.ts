/**
 * Numbers as the listing endpoints print them: decimal strings, never exponent notation.
 * Token amounts are summed as raw integers and printed exactly (viem's formatUnits); prices and depth are
 * floating point, printed to 12 significant digits, well inside what a double carries.
 */
export { formatUnits } from 'viem'

export const SIGNIFICANT_DIGITS = 12

/** 0.0000078125, 1.151777, 123456789012000: at most `significant` significant digits, trailing zeros dropped. */
export function plain(value: number, significant = SIGNIFICANT_DIGITS): string {
  if (!Number.isFinite(value) || value === 0) return '0'
  const negative = value < 0
  const [mantissa, exponentText] = Math.abs(value).toExponential(significant - 1).split('e')
  const exponent = Number(exponentText)
  const digits = mantissa.replace('.', '')
  let out: string
  if (exponent >= 0) {
    const whole = exponent + 1
    out = digits.length > whole ? `${digits.slice(0, whole)}.${digits.slice(whole)}` : digits.padEnd(whole, '0')
  } else {
    out = `0.${'0'.repeat(-exponent - 1)}${digits}`
  }
  if (out.includes('.')) out = out.replace(/0+$/, '').replace(/\.$/, '')
  return negative ? `-${out}` : out
}

/** US dollars to the cent, trailing zeros dropped: 563.27, 100, 0.5. */
export function usd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  const fixed = value.toFixed(2)
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed
}

/** A raw integer amount in whole tokens, as a double (for prices and USD values, not for printing amounts). */
export function whole(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals
}
