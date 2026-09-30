import type { TransactionReceipt } from 'viem'

/**
 * Match the launch adapter's l1FeeOf/weiOf rules without importing its frozen approval surface.
 * viem's default receipt formatter leaves OP Stack l1Fee as a raw hex or decimal string.
 */
export function l1FeeOf(receipt: TransactionReceipt): bigint {
  const value = (receipt as TransactionReceipt & { l1Fee?: unknown }).l1Fee
  if (value === undefined || value === null) return 0n
  if (typeof value === 'bigint' && value >= 0n) return value
  if ((typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
    || (typeof value === 'string' && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(value))) return BigInt(value)
  const detail = typeof value === 'bigint' ? value.toString() : JSON.stringify(value)
  throw new Error(`Unreadable l1Fee ${detail} on ${receipt.transactionHash}`)
}

export const weiOf = (receipt: TransactionReceipt): bigint => receipt.gasUsed * receipt.effectiveGasPrice + l1FeeOf(receipt)
