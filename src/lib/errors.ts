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
  ZeroAddress: 'That address is missing. Try again.',
  ZeroAmount: 'Amount is too small to trade.',
  Forbidden: 'You are not allowed to do that.',
  UnknownToken: 'That token is not on the launchpad.',
  CurveGraduated: 'This curve has graduated. It now trades in its launch pool; reload the page.',
  NotGraduated: 'This token has not graduated yet. It still trades on its curve.',
  SlippageExceeded: 'The price moved past your slippage limit. Try again or raise slippage in settings.',
  ExceedsSold: 'That is more than this curve has sold. Enter a smaller amount.',
  InvalidName: 'Name must be 1 to 32 bytes.',
  InvalidSymbol: 'Symbol must be 1 to 10 bytes.',
  InvalidMetadata: 'The details address must be 256 bytes or fewer.',
  LaunchFeeTooHigh: 'That launch fee is above the maximum.',
  LaunchFeeAboveMax: 'The launch fee went up after this form read it. Check the new fee, then create again.',
  CreatorFeeTooHigh: 'The creator fee can be at most 10%.',
  InvalidPlugin: 'Creator fees cannot go to the zero address or the launchpad. Choose another destination.',
  NotInitialized: 'The launchpad is not set up yet. Try again later.',
  PluginPullMismatch: 'This token’s plugin did not take its fees as it must, so they stay with the launchpad.',
  OnlyLaunchpad: 'Only the launchpad can do that.',
  OnlyLaunchpadOrRouter: 'Only the launchpad or the launch router can do that.',
  PairAlreadySet: 'The pool for this token is already set.',
  AlreadyGraduated: 'This token has already graduated.',
  PairLockedUntilGraduation: 'Transfers to the pool are locked until the curve graduates.',
  NoEligibleSupply: 'Nobody holds this token yet, so there is no one to pay.',
  // Creator-fee plugins (contracts/interfaces/plugins).
  NotConfigured: 'That plugin does not serve this token.',
  AlreadyConfigured: 'That plugin is already set up for this token.',
  Unauthorized: 'Only the launchpad or the token’s own plugin can set that up.',
  NotTokenPlugin: 'That plugin is not this token’s plugin.',
  DataNotEmpty: 'That plugin takes no settings. Choose it again from the list.',
  NonCanonicalData: 'The plugin settings were not encoded the way the plugin reads them.',
  LengthMismatch: 'The plugin settings have a different number of addresses and shares.',
  InvalidRecipient: 'One of the addresses cannot receive fees: zero, the plugin, the launchpad, USDC or the token itself.',
  PullMismatch: 'A plugin did not take exactly its share of the fees, so nothing moved.',
  AllowanceNotConsumed: 'A plugin did not take exactly its share of the fees, so nothing moved.',
  InvalidPayeeCount: 'A Split takes 1 to 20 payees.',
  ZeroShare: 'Every Split payee needs a share above zero.',
  DuplicatePayee: 'The same address is in the Split twice.',
  NothingToRelease: 'Nothing is waiting for that payee yet.',
  InvalidEntryCount: 'A Combo takes 1 to 5 destinations.',
  ZeroBps: 'Every Combo destination needs a share above zero.',
  BpsSumNot10000: 'The Combo shares must add up to exactly 100%.',
  DuplicateEntry: 'The same destination is in the Combo twice.',
  DataForNonPlugin: 'A wallet in a Combo takes no settings. That address may have a typo.',
  AlreadyRanThisBlock: 'A buyback already ran in this block. Try again in a moment.',
  NothingToBuy: 'No USDC is waiting to buy with yet.',
  RouterNotSet: 'The launch router is not set up yet.',
  PairNotSet: 'This token has no launch pool yet.',
  SpendMismatch: 'The buyback spent a different amount than it reported, so it was undone.',
  BadSpend: 'The buyback spent nothing, so it was undone.',
  NothingBought: 'The buyback bought nothing, so it was undone.',
  OnlyRouter: 'Only the launch router can trade in a launch pool.',
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
