import { BaseError, ContractFunctionRevertedError } from 'viem'

/**
 * Turns a decoded custom-error name (or a raw wallet/RPC message) into a sentence that names the
 * problem and the way out. Anything unknown falls back to the neutral "Transaction reverted".
 */
const REVERTS: Record<string, string> = {
  Expired: 'Took too long — the deadline passed before it confirmed. Try again.',
  InsufficientOutputAmount: 'The price moved past your slippage limit. Try again or raise slippage in settings.',
  ExcessiveInputAmount: 'The price moved past your slippage limit. Try again or raise slippage in settings.',
  InsufficientAAmount: 'The pool ratio moved past your slippage limit. Try again or raise slippage in settings.',
  InsufficientBAmount: 'The pool ratio moved past your slippage limit. Try again or raise slippage in settings.',
  InsufficientLiquidity: 'Not enough liquidity in the pool for that amount.',
  InsufficientLiquidityMinted: 'Amounts too small to mint liquidity. Add a little more of each token.',
  InsufficientLiquidityBurned: 'Amount too small to remove. Choose a larger share.',
  PairDoesNotExist: 'No pool for this pair yet. Create it from the Pools view.',
  InvalidPath: 'That route is not valid. Pick the tokens again.',
  K: 'The pool rejected the trade. Try again in a moment.',
  Locked: 'The pool is busy with another transaction. Try again in a moment.',
  ERC20InsufficientBalance: 'Not enough balance for that amount.',
  ERC20InsufficientAllowance: 'Approval is too small for that amount. Approve again.',
  OwnableUnauthorizedAccount: 'Only the owner can do that.',
}

export function explainRevert(errorName: string | undefined): string {
  if (!errorName) return 'Transaction reverted'
  return REVERTS[errorName] ?? `Transaction reverted (${errorName})`
}

/** Decodes a viem error chain down to the custom error name and explains it. */
export function revertReason(error: unknown): string {
  if (error instanceof BaseError) {
    const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError)
    if (reverted instanceof ContractFunctionRevertedError) return explainRevert(reverted.data?.errorName)
  }
  return 'Transaction reverted'
}

export function isUserRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  return message.includes('user rejected') || message.includes('user denied') || message.includes('request rejected')
}
