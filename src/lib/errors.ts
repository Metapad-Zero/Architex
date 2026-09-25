import { BaseError, ContractFunctionRevertedError, decodeErrorResult, isHex, parseAbi } from 'viem'
import { launchHookErrors } from './abi'

/**
 * Turns a decoded custom-error name (or a raw wallet/RPC message) into a sentence that names the
 * problem and the way out. Anything unknown falls back to the neutral "Transaction reverted".
 */
const REVERTS: Record<string, string> = {
  Expired: 'Took too long: the deadline passed before it confirmed. Try again.',
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
  InvalidPlugin:
    'Creator fees cannot go to that address: it could never pass them on (the zero address, the launchpad, USDC, the launch router or pair factory, the launch hook, Uniswap’s PoolManager, a launch token or a launch pool). Choose another destination.',
  DataForNonPlugin: 'That address isn’t a plugin, so it can’t take settings. Clear them or pick a listed plugin.',
  NotInitialized: 'The launchpad is not set up yet. Try again later.',
  PluginPullMismatch: 'This token’s plugin did not take its fees as it must, so they stay with the launchpad.',
  OnlyLaunchpad: 'Only the launchpad can do that.',
  OnlyLaunchpadOrRouter: 'Only the launchpad or the launch router can do that.',
  PairAlreadySet: 'The pool for this token is already set.',
  AlreadyGraduated: 'This token has already graduated.',
  PairLockedUntilGraduation: 'Transfers to the pool are locked until the curve graduates.',
  PoolLockedUntilGraduation: 'Transfers to the pool are locked until the curve graduates.',
  // Launchpad v1.4's hook, and Uniswap v4 around it.
  FeesExceedAmount: 'The fees would take the whole amount. Enter a larger amount.',
  PartialFill: 'The pool could not fill the whole trade. Try a smaller amount.',
  ClosedPool: 'This pool is closed: only its locked liquidity can be in it.',
  UnknownLaunch: 'This token’s Uniswap pool is not open yet. It still trades on its curve.',
  PoolNotInitialized: 'This token’s Uniswap pool is not open yet. It still trades on its curve.',
  AlreadyOpened: 'This token’s pool is already open.',
  PoolCreationRestricted: 'Only the launchpad can open this pool.',
  NothingToLock: 'No anti-sniping fees are waiting to be locked for this token.',
  DonationsRefused: 'These pools take no donations.',
  BidNotOneSided: 'The bid could not be placed at the price now. The fees wait; try again later.',
  WrappedError: 'The pool refused the trade. Check the amount, then try again.',
  // Creator-fee plugins (contracts/interfaces/plugins).
  NotConfigured: 'That plugin does not serve this token.',
  AlreadyConfigured: 'That plugin is already set up for this token.',
  Unauthorized: 'Only the launchpad or the token’s own plugin can set that up.',
  NotTokenPlugin: 'That plugin is not this token’s plugin.',
  DataNotEmpty: 'That plugin takes no settings. Choose it again from the list.',
  NonCanonicalData: 'The plugin settings were not encoded the way the plugin reads them.',
  LengthMismatch: 'The plugin settings have a different number of addresses and shares.',
  InvalidRecipient:
    'One of the addresses cannot receive fees: the zero address, the plugin itself, the launchpad, USDC, the launch router or pair factory, a launch token or a launch pool.',
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
  // Buyback & burn's and Deepen pool's runs share these names, so the sentences fit either.
  AlreadyRanThisBlock: 'It already ran for this token in this block. Try again in a moment.',
  NothingToBuy: 'Nothing to buy with yet: no USDC is waiting, or the budget is still building up since the last run.',
  RouterNotSet: 'The launch router is not set up yet.',
  PairNotSet: 'This token has no launch pool yet.',
  SpendMismatch: 'The run spent a different amount than it reported, so it was undone.',
  BadSpend: 'The run spent nothing, so it was undone.',
  NothingBought: 'The run bought nothing, so it was undone.',
  InvalidBurnBps: 'The burn share can be at most 100%.',
  LiquidityMismatch: 'The pool minted a different amount of liquidity than the run worked out, so it was undone.',
  OnlyRouter: 'Only the launch router can trade in a launch pool.',
}

export function explainRevert(errorName: string | undefined): string {
  if (!errorName) return 'Transaction reverted'
  return REVERTS[errorName] ?? `Transaction reverted (${errorName})`
}

/**
 * What a refusal inside a Uniswap v4 pool can be. The PoolManager wraps a hook's revert, or a token's inside a swap, in
 * WrappedError(target, selector, reason, details); `reason` is the original error.
 */
const wrappedErrorsAbi = parseAbi([
  ...launchHookErrors,
  'error OnlyLaunchpad()',
  'error Forbidden()',
  'error UnknownToken()',
  'error NotGraduated()',
  'error OnlyLaunchpadOrRouter()',
  'error InvalidPullTarget()',
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
])

/** The name of the error a WrappedError carries, when it is one the site knows. */
export function wrappedErrorName(reason: unknown): string | undefined {
  if (typeof reason !== 'string' || !isHex(reason) || reason.length < 10) return undefined
  try {
    return decodeErrorResult({ abi: wrappedErrorsAbi, data: reason }).errorName
  } catch {
    return undefined
  }
}

/** Decodes a viem error chain down to the custom error name and explains it. */
export function revertReason(error: unknown): string {
  if (error instanceof BaseError) {
    const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError)
    if (reverted instanceof ContractFunctionRevertedError) {
      const data = reverted.data
      if (data?.errorName === 'WrappedError') return explainRevert(wrappedErrorName(data.args?.[2]) ?? 'WrappedError')
      return explainRevert(data?.errorName)
    }
  }
  return 'Transaction reverted'
}

export function isUserRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  return message.includes('user rejected') || message.includes('user denied') || message.includes('request rejected')
}
