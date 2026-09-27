import { parseAbi } from 'viem'

export const factoryAbi = parseAbi([
  'event PairCreated(address indexed token0, address indexed token1, address pair, uint256 allPairsLength)',
  'event FeeToUpdated(address indexed feeTo)',
  'event FeeToSetterUpdated(address indexed feeToSetter)',
  'error IdenticalAddresses()',
  'error ZeroAddress()',
  'error PairExists()',
  'error Forbidden()',
  'function feeTo() view returns (address)',
  'function feeToSetter() view returns (address)',
  'function getPair(address tokenA, address tokenB) view returns (address pair)',
  'function allPairs(uint256 index) view returns (address pair)',
  'function allPairsLength() view returns (uint256)',
  'function createPair(address tokenA, address tokenB) returns (address pair)',
  'function setFeeTo(address feeTo)',
  'function setFeeToSetter(address feeToSetter)',
])

export const pairAbi = parseAbi([
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Mint(address indexed sender, uint256 amount0, uint256 amount1)',
  'event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to)',
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
  'event Sync(uint112 reserve0, uint112 reserve1)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function transfer(address to, uint256 value) returns (bool)',
  'function transferFrom(address from, address to, uint256 value) returns (bool)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function nonces(address owner) view returns (uint256)',
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
  'function MINIMUM_LIQUIDITY() pure returns (uint256)',
  'function factory() view returns (address)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function price0CumulativeLast() view returns (uint256)',
  'function price1CumulativeLast() view returns (uint256)',
  'function kLast() view returns (uint256)',
  'function mint(address to) returns (uint256 liquidity)',
  'function burn(address to) returns (uint256 amount0, uint256 amount1)',
  'function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes data)',
  'function skim(address to)',
  'function sync()',
  'function initialize(address token0, address token1)',
])

export const routerAbi = parseAbi([
  'error Expired()',
  'error InsufficientAAmount()',
  'error InsufficientBAmount()',
  'error InsufficientOutputAmount()',
  'error ExcessiveInputAmount()',
  'error InvalidPath()',
  'error PairDoesNotExist()',
  'function factory() view returns (address)',
  'function addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB, uint256 liquidity)',
  'function removeLiquidity(address tokenA, address tokenB, uint256 liquidity, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB)',
  'function removeLiquidityWithPermit(address tokenA, address tokenB, uint256 liquidity, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline, bool approveMax, uint8 v, bytes32 r, bytes32 s) returns (uint256 amountA, uint256 amountB)',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
  'function swapTokensForExactTokens(uint256 amountOut, uint256 amountInMax, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
  'function quote(uint256 amountA, uint256 reserveA, uint256 reserveB) pure returns (uint256 amountB)',
  'function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) pure returns (uint256 amountOut)',
  'function getAmountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut) pure returns (uint256 amountIn)',
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
  'function getAmountsIn(uint256 amountOut, address[] path) view returns (uint256[] amounts)',
])

export const lensAbi = parseAbi([
  'struct TokenMeta { address token; string symbol; string name; uint8 decimals; }',
  'struct PairInfo { address pair; address token0; address token1; uint112 reserve0; uint112 reserve1; uint32 blockTimestampLast; uint256 totalSupply; }',
  'struct Position { address pair; address token0; address token1; uint256 lpBalance; uint256 lpTotalSupply; uint112 reserve0; uint112 reserve1; uint256 routerAllowance; }',
  'function factory() view returns (address)',
  'function router() view returns (address)',
  'function pairsLength() view returns (uint256)',
  'function pairs(uint256 start, uint256 count) view returns (PairInfo[])',
  'function pairsByAddress(address[] pairAddrs) view returns (PairInfo[])',
  'function tokenMeta(address[] tokens) view returns (TokenMeta[])',
  'function balances(address owner, address[] tokens) view returns (uint256[])',
  'function allowances(address owner, address spender, address[] tokens) view returns (uint256[])',
  'function positions(address owner, uint256 start, uint256 count) view returns (Position[])',
])

const erc20AbiEntries = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function transfer(address to, uint256 value) returns (bool)',
  'function transferFrom(address from, address to, uint256 value) returns (bool)',
] as const

export const erc20Abi = parseAbi(erc20AbiEntries)

export const testTokenAbi = parseAbi([
  ...erc20AbiEntries,
  'event Faucet(address indexed to, uint256 amount)',
  'function FAUCET_UNITS() view returns (uint256)',
  'function faucet()',
  'function mint(address to, uint256 amount)',
  'function owner() view returns (address)',
])

// ─── Launchpad v1.3 (docs/launchpad/V13-SPEC.md; contracts/interfaces/*.sol are the source of truth) ─────────

/** OpenZeppelin ERC-20 errors a launch token or the pair can revert with inside a launch trade. */
const oz20Errors = [
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
] as const

/** LaunchToken v2 errors, so a revert inside a curve or pool trade decodes to a name. */
const launchTokenErrors = [
  'error OnlyLaunchpad()',
  'error OnlyLaunchpadOrRouter()',
  'error InvalidPullTarget()',
  'error PairAlreadySet()',
  'error AlreadyGraduated()',
  'error PairLockedUntilGraduation()',
] as const

/** IArchitexLaunchpad (v1.3), including IArchitexLaunchpadLite. */
export const launchpadAbi = parseAbi([
  'struct Curve { address token; address creator; address pair; uint128 virtualUsdc; uint128 virtualTokens; uint128 tokensSold; uint64 createdAt; bool graduated; uint16 creatorFeeBps; bool pluginHooks; address plugin; string metadataURI; }',
  'event Initialized(address indexed pairFactory, address indexed router)',
  'event TokenCreated(address indexed token, address indexed creator, address indexed plugin, address pair, uint16 creatorFeeBps, string name, string symbol, string metadataURI)',
  'event Trade(address indexed token, address indexed trader, bool isBuy, uint256 usdcAmount, uint256 tokenAmount, uint256 platformFee, uint256 creatorFee, uint256 virtualUsdc, uint256 virtualTokens)',
  'event Graduated(address indexed token, address indexed pair, uint256 usdcSeeded, uint256 tokensSeeded, uint256 liquidityLocked)',
  'event PoolFeesAccrued(address indexed token, uint256 platformFee, uint256 creatorFee)',
  'event CreatorFeesCollected(address indexed token, address indexed plugin, uint256 amount)',
  'event FeeToUpdated(address indexed feeTo)',
  'event FeeToSetterUpdated(address indexed feeToSetter)',
  'event LaunchFeeUpdated(uint256 launchFee)',
  'event FeesCollected(address indexed feeTo, uint256 amount)',
  'error ZeroAddress()',
  'error ZeroAmount()',
  'error Forbidden()',
  'error UnknownToken()',
  'error CurveGraduated()',
  'error NotGraduated()',
  'error SlippageExceeded()',
  'error Expired()',
  'error ExceedsSold()',
  'error InvalidName()',
  'error InvalidSymbol()',
  'error InvalidMetadata()',
  'error LaunchFeeTooHigh()',
  'error LaunchFeeAboveMax()',
  'error CreatorFeeTooHigh()',
  'error InvalidPlugin()',
  'error DataForNonPlugin()',
  'error NotInitialized()',
  'error AlreadyInitialized()',
  'error InvalidWiring()',
  'error PairAlreadySeeded()',
  'error PluginPullMismatch()',
  ...launchTokenErrors,
  ...oz20Errors,
  'function usdc() view returns (address)',
  'function router() view returns (address)',
  'function pairFactory() view returns (address)',
  'function isLaunchPair(address account) view returns (bool)',
  'function FEE_BPS() view returns (uint256)',
  'function feeTo() view returns (address)',
  'function feeToSetter() view returns (address)',
  'function launchFee() view returns (uint256)',
  'function pendingFees() view returns (uint256)',
  'function pendingCreatorFees(address token) view returns (uint256)',
  'function TOTAL_SUPPLY() view returns (uint256)',
  'function CURVE_SUPPLY() view returns (uint256)',
  'function POOL_SUPPLY() view returns (uint256)',
  'function VIRTUAL_TOKENS_0() view returns (uint256)',
  'function VIRTUAL_USDC_0() view returns (uint256)',
  'function MAX_LAUNCH_FEE() view returns (uint256)',
  'function MAX_CREATOR_FEE_BPS() view returns (uint256)',
  'function pluginOf(address token) view returns (address)',
  'function creatorOf(address token) view returns (address)',
  'function creatorFeeBpsOf(address token) view returns (uint16)',
  'function pairOf(address token) view returns (address)',
  'function isGraduated(address token) view returns (bool)',
  'function virtualUsdcOf(address token) view returns (uint256)',
  'function initialize(address pairFactory, address router)',
  'function createToken(string name, string symbol, string metadataURI, uint16 creatorFeeBps, address plugin, bytes pluginData, uint256 initialBuyUsdc, uint256 minTokensOut, uint256 maxLaunchFee) returns (address token)',
  'function buy(address token, uint256 usdcIn, uint256 minTokensOut, address to, uint256 deadline) returns (uint256 tokensOut, uint256 usdcSpent)',
  'function sell(address token, uint256 tokensIn, uint256 minUsdcOut, address to, uint256 deadline) returns (uint256 usdcOut)',
  'function quoteBuy(address token, uint256 usdcIn) view returns (uint256 tokensOut, uint256 platformFee, uint256 creatorFee, uint256 usdcSpent, bool graduates)',
  'function quoteSell(address token, uint256 tokensIn) view returns (uint256 usdcOut, uint256 platformFee, uint256 creatorFee)',
  'function curves(address token) view returns (Curve)',
  'function tokensLength() view returns (uint256)',
  'function tokenAt(uint256 index) view returns (address)',
  'function curvesPage(uint256 start, uint256 count) view returns (Curve[])',
  'function spotPrice(address token) view returns (uint256)',
  'function marketCap(address token) view returns (uint256)',
  'function progressBps(address token) view returns (uint256)',
  'function collectFees() returns (uint256 amount)',
  'function collectCreatorFees(address token) returns (uint256 amount)',
  'function accrueTradeFees(address token, uint256 platformFee, uint256 creatorFee)',
  'function setFeeTo(address feeTo)',
  'function setFeeToSetter(address feeToSetter)',
  'function setLaunchFee(uint256 launchFee)',
])

/**
 * ILaunchToken (v2): fixed supply, burn, USDC dividends streamed inside the token (distribute pays holders second
 * by second over DRIP_PERIOD; claimable grows live), and the no-approval `pull` for sells.
 */
export const launchTokenAbi = parseAbi([
  ...launchTokenErrors,
  ...oz20Errors,
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
  'event DividendsDistributed(address indexed from, uint256 amount)',
  'event DividendClaimed(address indexed holder, uint256 amount)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function transfer(address to, uint256 value) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function transferFrom(address from, address to, uint256 value) returns (bool)',
  'function launchpad() view returns (address)',
  'function router() view returns (address)',
  'function pair() view returns (address)',
  'function graduated() view returns (bool)',
  'function usdc() view returns (address)',
  'function MIN_ELIGIBLE_SUPPLY() view returns (uint256)',
  'function claimed(address holder) view returns (uint256)',
  'function initPair(address pair)',
  'function markGraduated()',
  'function pull(address from, address to, uint256 amount)',
  'function burn(uint256 amount)',
  'function distribute(uint256 amount)',
  'function DRIP_PERIOD() view returns (uint256)',
  'function eligibleSupply() view returns (uint256)',
  'function isExcluded(address account) view returns (bool)',
  'function totalDistributed() view returns (uint256)',
  'function claimable(address holder) view returns (uint256)',
  'function streamRate() view returns (uint256)',
  'function streamEnd() view returns (uint256)',
  'function lastAccrual() view returns (uint256)',
  'function undistributed() view returns (uint256)',
  'function claim() returns (uint256 amount)',
  'function claimFor(address holder) returns (uint256 amount)',
])

/** ILaunchPair errors, so a pool revert inside a router trade decodes to a name. */
const launchPairErrors = [
  'error OnlyRouter()',
  'error Locked()',
  'error InsufficientLiquidityMinted()',
  'error InsufficientLiquidityBurned()',
  'error InsufficientOutputAmount()',
  'error InsufficientInputAmount()',
  'error InsufficientLiquidity()',
  'error InvalidTo()',
  'error K()',
  'error Overflow()',
] as const

/** ILaunchPair: a graduated token's pool (token × USDC, no fee); `swap` is router-only. */
export const launchPairAbi = parseAbi([
  ...launchPairErrors,
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
  'event Mint(address indexed sender, uint256 amountToken, uint256 amountUsdc)',
  'event Burn(address indexed sender, uint256 amountToken, uint256 amountUsdc, address indexed to)',
  'event Swap(address indexed sender, uint256 tokenIn, uint256 usdcIn, uint256 tokenOut, uint256 usdcOut, address indexed to)',
  'event Sync(uint112 reserveToken, uint112 reserveUsdc)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function MINIMUM_LIQUIDITY() pure returns (uint256)',
  'function factory() view returns (address)',
  'function router() view returns (address)',
  'function token() view returns (address)',
  'function usdc() view returns (address)',
  'function getReserves() view returns (uint112 reserveToken, uint112 reserveUsdc, uint32 blockTimestampLast)',
  'function mint(address to) returns (uint256 liquidity)',
  'function burn(address to) returns (uint256 amountToken, uint256 amountUsdc)',
  'function swap(uint256 tokenOut, uint256 usdcOut, address to)',
  'function skim(address to)',
  'function sync()',
])

/** ILaunchPairFactory: launch pairs, one per launch token, created only by the launchpad. */
export const launchPairFactoryAbi = parseAbi([
  'event PairCreated(address indexed token, address pair, uint256 allPairsLength)',
  'error OnlyLaunchpad()',
  'error PairExists()',
  'error ZeroAddress()',
  'function launchpad() view returns (address)',
  'function usdc() view returns (address)',
  'function getPair(address token) view returns (address pair)',
  'function allPairs(uint256 index) view returns (address pair)',
  'function allPairsLength() view returns (uint256)',
  'function createPair(address token) returns (address pair)',
])

/** ILaunchRouter: exact-in buys and sells of graduated launch tokens against USDC, both fees from the USDC side. */
export const launchRouterAbi = parseAbi([
  'event PoolTrade(address indexed token, address indexed trader, bool isBuy, uint256 usdcAmount, uint256 tokenAmount, uint256 platformFee, uint256 creatorFee)',
  'error Expired()',
  'error UnknownToken()',
  'error NotGraduated()',
  'error SlippageExceeded()',
  'error ZeroAmount()',
  'error ZeroAddress()',
  'error InvalidWiring()',
  ...launchPairErrors,
  ...launchTokenErrors,
  ...oz20Errors,
  'function launchpad() view returns (address)',
  'function factory() view returns (address)',
  'function usdc() view returns (address)',
  'function quoteBuy(address token, uint256 usdcIn) view returns (uint256 tokensOut, uint256 platformFee, uint256 creatorFee)',
  'function quoteSell(address token, uint256 tokensIn) view returns (uint256 usdcOut, uint256 platformFee, uint256 creatorFee)',
  'function buy(address token, uint256 usdcIn, uint256 minTokensOut, address to, uint256 deadline) returns (uint256 tokensOut)',
  'function sell(address token, uint256 tokensIn, uint256 minUsdcOut, address to, uint256 deadline) returns (uint256 usdcOut)',
])

// ─── Launchpad v1.4 (docs/launchpad/V14-SPEC.md; contracts-v14/src/interfaces/*.sol are the source of truth) ───

/** LaunchTokenV14's errors: v1.3's, with the pool lock named for Uniswap's PoolManager. */
const launchTokenV14Errors = [
  'error OnlyLaunchpad()',
  'error OnlyLaunchpadOrRouter()',
  'error InvalidPullTarget()',
  'error AlreadyGraduated()',
  'error PoolLockedUntilGraduation()',
] as const

/**
 * ArchitexLaunchHook's errors (its OnlyLaunchpad is the token's, above). Uniswap's PoolManager wraps a hook's refusal
 * in WrappedError(hook, selector, reason, details); lib/errors.ts reads `reason` against these.
 */
export const launchHookErrors = [
  'error PoolCreationRestricted()',
  'error ClosedPool()',
  'error UnknownLaunch()',
  'error AlreadyOpened()',
  'error FeesExceedAmount()',
  'error PartialFill()',
  'error DonationsRefused()',
  'error BidNotOneSided()',
] as const

/** Uniswap v4's own refusals that can end a pool trade: a hook's revert, wrapped, and a pool that is not open. */
const uniswapV4Errors = [
  'error WrappedError(address target, bytes4 selector, bytes reason, bytes details)',
  'error PoolNotInitialized()',
] as const

const launchpadV14Errors = [
  'error ZeroAddress()',
  'error ZeroAmount()',
  'error Forbidden()',
  'error UnknownToken()',
  'error CurveGraduated()',
  'error NotGraduated()',
  'error SlippageExceeded()',
  'error Expired()',
  'error ExceedsSold()',
  'error InvalidName()',
  'error InvalidSymbol()',
  'error InvalidMetadata()',
  'error LaunchFeeTooHigh()',
  'error LaunchFeeAboveMax()',
  'error CreatorFeeTooHigh()',
  'error InvalidPlugin()',
  'error DataForNonPlugin()',
  'error NotInitialized()',
  'error AlreadyInitialized()',
  'error InvalidWiring()',
  'error PluginPullMismatch()',
  'error ReentrancyGuardReentrantCall()',
  'error SafeERC20FailedOperation(address token)',
] as const

const curveV14 =
  'struct Curve { address token; address creator; uint128 virtualUsdc; uint128 virtualTokens; uint128 tokensSold; uint64 createdAt; uint64 createdBlock; bool graduated; bool openPool; uint16 creatorFeeBps; bool pluginHooks; address plugin; string metadataURI; }'
const tokenCreatedV14 =
  'event TokenCreated(address indexed token, address indexed creator, address indexed plugin, bool openPool, uint16 creatorFeeBps, string name, string symbol, string metadataURI)'
const createTokenV14 =
  'function createToken(string name, string symbol, string metadataURI, uint16 creatorFeeBps, address plugin, bytes pluginData, bool openPool, uint256 initialBuyUsdc, uint256 minTokensOut, uint256 maxLaunchFee) returns (address token)'

/**
 * IArchitexLaunchpadV14, including IArchitexLaunchpadLite. v1.3's curves and fees with a third fee on a curve buy in
 * the token's first SNIPE_BLOCKS blocks (the snipe fee, held for its pool), an open or closed pool chosen at launch,
 * and graduation into a Uniswap v4 pool behind the hook instead of a launch pair.
 *
 * Pool trades' fees stay with the hook (its ERC-6909 claims in the PoolManager) until the launchpad releases and books
 * them: `syncPoolFees` (anyone), or first thing in `collectCreatorFees`. So PoolFeesAccrued marks a sync, not a trade
 * (per-trade fees are the hook's PoolTrade), and a graduated token's creator fees ready to collect are
 * `pendingCreatorFees(token)` plus the hook's `pendingCreator(token)`. `accrueTradeFees` is IArchitexLaunchpadLite's and
 * always reverts on v1.4.
 */
export const launchpadV14Abi = parseAbi([
  curveV14,
  'event Initialized(address indexed hook, address indexed router)',
  tokenCreatedV14,
  'event Trade(address indexed token, address indexed trader, bool isBuy, uint256 usdcAmount, uint256 tokenAmount, uint256 platformFee, uint256 creatorFee, uint256 snipeFee, uint256 virtualUsdc, uint256 virtualTokens)',
  'event Graduated(address indexed token, bytes32 indexed poolId, uint256 usdcSeeded, uint256 tokensSeeded, uint256 liquidityLocked, uint256 snipeLocked)',
  'event PoolFeesAccrued(address indexed token, uint256 platformFee, uint256 creatorFee)',
  'event CreatorFeesCollected(address indexed token, address indexed plugin, uint256 amount)',
  'event FeeToUpdated(address indexed feeTo)',
  'event FeeToSetterUpdated(address indexed feeToSetter)',
  'event LaunchFeeUpdated(uint256 launchFee)',
  'event FeesCollected(address indexed feeTo, uint256 amount)',
  ...launchpadV14Errors,
  ...launchTokenV14Errors,
  ...launchHookErrors,
  ...uniswapV4Errors,
  ...oz20Errors,
  'function usdc() view returns (address)',
  'function router() view returns (address)',
  'function pairFactory() view returns (address)',
  'function isLaunchPair(address account) view returns (bool)',
  'function FEE_BPS() view returns (uint256)',
  'function feeTo() view returns (address)',
  'function feeToSetter() view returns (address)',
  'function launchFee() view returns (uint256)',
  'function pendingFees() view returns (uint256)',
  'function pendingCreatorFees(address token) view returns (uint256)',
  'function pendingSnipe(address token) view returns (uint256)',
  'function snipeBpsOf(address token) view returns (uint256)',
  'function TOTAL_SUPPLY() view returns (uint256)',
  'function CURVE_SUPPLY() view returns (uint256)',
  'function POOL_SUPPLY() view returns (uint256)',
  'function VIRTUAL_TOKENS_0() view returns (uint256)',
  'function VIRTUAL_USDC_0() view returns (uint256)',
  'function MAX_LAUNCH_FEE() view returns (uint256)',
  'function MAX_CREATOR_FEE_BPS() view returns (uint256)',
  'function SNIPE_BLOCKS() view returns (uint256)',
  'function SNIPE_START_BPS() view returns (uint256)',
  'function MAX_TOTAL_FEE_BPS() view returns (uint256)',
  'function poolManager() view returns (address)',
  'function hook() view returns (address)',
  'function pluginOf(address token) view returns (address)',
  'function creatorOf(address token) view returns (address)',
  'function creatorFeeBpsOf(address token) view returns (uint16)',
  'function pairOf(address token) view returns (address)',
  'function isGraduated(address token) view returns (bool)',
  'function virtualUsdcOf(address token) view returns (uint256)',
  'function initialize(address hook, address router)',
  createTokenV14,
  'function buy(address token, uint256 usdcIn, uint256 minTokensOut, address to, uint256 deadline) returns (uint256 tokensOut, uint256 usdcSpent)',
  'function sell(address token, uint256 tokensIn, uint256 minUsdcOut, address to, uint256 deadline) returns (uint256 usdcOut)',
  'function quoteBuy(address token, uint256 usdcIn) view returns (uint256 tokensOut, uint256 platformFee, uint256 creatorFee, uint256 snipeFee, uint256 usdcSpent, bool graduates)',
  'function quoteSell(address token, uint256 tokensIn) view returns (uint256 usdcOut, uint256 platformFee, uint256 creatorFee)',
  'function curves(address token) view returns (Curve)',
  'function tokensLength() view returns (uint256)',
  'function tokenAt(uint256 index) view returns (address)',
  'function curvesPage(uint256 start, uint256 count) view returns (Curve[])',
  'function spotPrice(address token) view returns (uint256)',
  'function marketCap(address token) view returns (uint256)',
  'function progressBps(address token) view returns (uint256)',
  'function collectFees() returns (uint256 amount)',
  'function collectCreatorFees(address token) returns (uint256 amount)',
  'function syncPoolFees(address token) returns (uint256 platformFee, uint256 creatorFee)',
  'function syncPoolFeesBatch(address[] tokens)',
  'function accrueTradeFees(address token, uint256 platformFee, uint256 creatorFee) pure',
  'function setFeeTo(address feeTo)',
  'function setFeeToSetter(address feeToSetter)',
  'function setLaunchFee(uint256 launchFee)',
])

/**
 * IArchitexLaunchHook: one hook for every v1.4 pool. It opens each pool at graduation, takes the platform, creator and
 * snipe fees of every swap in USDC (PoolTrade) and keeps the platform and creator fees as its ERC-6909 claims in the
 * PoolManager until the launchpad releases them (FeesReleased). A snipe fee never waits: the buy that pays it places
 * it as a bid in the same transaction (BidLocked), a position of its own from about half the cheaper of the price just
 * before that buy and the pool's bid reference (launchOf's `bidRefTick`: the lowest price any window buy has started
 * from, the graduation price to begin with, which only moves down), down BID_SPAN_TICKS (lib/launchV14.ts
 * windowBidRange); the curve's snipe fees become the first bid at graduation, from half the graduation price.
 * `bidCount` counts the bids, and `lockHeld` is only the rounding a bid could not take (a unit or two). Nobody can
 * donate to a pool. PoolTrade's `sender` is whoever called the PoolManager (a router), not necessarily the trader.
 * `graduate` and `release` are the launchpad's alone: the site never calls them.
 */
export const launchHookAbi = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct Launch { address token; bool usdcIs0; bool open; uint16 creatorFeeBps; uint64 openBlock; int24 graduationTick; int24 bidRefTick; }',
  'event PoolOpened(address indexed token, bytes32 indexed poolId, uint160 sqrtPriceX96, uint256 tokensAdded, uint256 usdcAdded, uint128 liquidity, bool open)',
  'event PoolTrade(address indexed token, address indexed sender, bool isBuy, uint256 usdcAmount, uint256 tokenAmount, uint256 platformFee, uint256 creatorFee, uint256 snipeFee)',
  'event BidLocked(address indexed token, uint256 usdc, uint128 liquidity, int24 tickLower, int24 tickUpper)',
  'event FeesReleased(address indexed token, uint256 platformFee, uint256 creatorFee)',
  'error OnlyLaunchpad()',
  ...launchHookErrors,
  ...uniswapV4Errors,
  'function LP_FEE() view returns (uint24)',
  'function TICK_SPACING() view returns (int24)',
  'function FEE_BPS() view returns (uint256)',
  'function SNIPE_BLOCKS() view returns (uint256)',
  'function SNIPE_START_BPS() view returns (uint256)',
  'function MAX_TOTAL_FEE_BPS() view returns (uint256)',
  'function BID_DISCOUNT_TICKS() view returns (int24)',
  'function BID_SPAN_TICKS() view returns (int24)',
  'function launchpad() view returns (address)',
  'function usdc() view returns (address)',
  'function poolManager() view returns (address)',
  'function graduate(address token, uint256 tokenAmount, uint256 usdcAmount, uint256 lockAmount, bool open, uint16 creatorFeeBps) returns (bytes32 poolId, uint128 liquidity)',
  'function release(address token) returns (uint256 platformFee, uint256 creatorFee)',
  'function lockHeld(address token) view returns (uint256)',
  'function pendingPlatform(address token) view returns (uint256)',
  'function pendingCreator(address token) view returns (uint256)',
  'function bidCount(address token) view returns (uint256)',
  'function poolKeyOf(address token) view returns (PoolKey)',
  'function launchOf(address token) view returns (bytes32 poolId, Launch launch)',
  'function snipeBpsOf(address token) view returns (uint256)',
])

/**
 * IArchitexV4Router: exact-in buys and sells of graduated v1.4 tokens in their pools. `quoteBuy` and `quoteSell` are
 * not views on chain (each runs the swap inside the PoolManager and reverts with the result, so nothing is kept);
 * they are declared view here so they are read with eth_call like any view, fees included.
 */
export const v4RouterAbi = parseAbi([
  'error Expired()',
  'error SlippageExceeded()',
  'error NotGraduated()',
  'error OnlyPoolManager()',
  'error Quote(uint256 amountOut)',
  ...launchTokenV14Errors,
  ...launchHookErrors,
  ...uniswapV4Errors,
  ...oz20Errors,
  'function launchpad() view returns (address)',
  'function usdc() view returns (address)',
  'function poolManager() view returns (address)',
  'function buy(address token, uint256 usdcIn, uint256 minTokensOut, address to, uint256 deadline) returns (uint256 tokensOut)',
  'function sell(address token, uint256 tokensIn, uint256 minUsdcOut, address to, uint256 deadline) returns (uint256 usdcOut)',
  'function quoteBuy(address token, uint256 usdcIn) view returns (uint256 tokensOut)',
  'function quoteSell(address token, uint256 tokensIn) view returns (uint256 usdcOut)',
])

/** Uniswap v4's StateView (periphery): a pool's price and in-range liquidity, by pool id. */
export const stateViewAbi = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
])

// ─── Creator-fee plugins (contracts/interfaces/plugins/*.sol) ───────────────────────────────────────────────

/** Errors every reference plugin shares (ILaunchFeePlugin), so a plugin revert inside createToken or a collection decodes. */
export const launchFeePluginErrors = [
  'error UnknownToken(address token)',
  'error NotTokenPlugin(address token)',
  'error Unauthorized(address caller)',
  'error AlreadyConfigured(address token)',
  'error NotConfigured(address token)',
  'error DataNotEmpty()',
  'error NonCanonicalData()',
  'error LengthMismatch()',
  'error InvalidRecipient(address recipient)',
  'error PullMismatch(address puller, uint256 expected, uint256 actual)',
  'error AllowanceNotConsumed(address spender)',
] as const

/** ILaunchFeePlugin: what every reference plugin exposes (IArchitexFeePlugin plus per-token views). */
export const launchFeePluginEntries = [
  ...launchFeePluginErrors,
  'error ZeroAddress()',
  'event Configured(address indexed token, address indexed creator)',
  'event FeesReceived(address indexed token, address indexed from, uint256 amount)',
  'function supportsInterface(bytes4 interfaceId) view returns (bool)',
  'function onLaunch(address token, address creator, bytes data)',
  'function onFees(address token, uint256 amount)',
  'function launchpad() view returns (address)',
  'function usdc() view returns (address)',
  'function isConfigured(address token) view returns (bool)',
  'function usdcHeld(address token) view returns (uint256)',
] as const

export const launchFeePluginAbi = parseAbi(launchFeePluginEntries)

const splitPluginErrors = [
  'error InvalidPayeeCount(uint256 count)',
  'error ZeroShare(address payee)',
  'error DuplicatePayee(address payee)',
  'error NothingToRelease(address token, address payee)',
] as const

/** ISplitPlugin: fixed payees and shares per token; anyone may release a payee's USDC to them. */
export const splitPluginAbi = parseAbi([
  ...launchFeePluginEntries,
  ...splitPluginErrors,
  'event SplitConfigured(address indexed token, address[] payees, uint256[] shares)',
  'event Released(address indexed token, address indexed payee, uint256 amount)',
  'function MAX_PAYEES() view returns (uint256)',
  'function payeesOf(address token) view returns (address[] payees, uint256[] shares)',
  'function sharesOf(address token, address payee) view returns (uint256)',
  'function totalShares(address token) view returns (uint256)',
  'function totalReceived(address token) view returns (uint256)',
  'function totalReleased(address token) view returns (uint256)',
  'function released(address token, address payee) view returns (uint256)',
  'function releasable(address token, address payee) view returns (uint256)',
  'function release(address token, address payee) returns (uint256 amount)',
])

const buybackPluginErrors = [
  'error AlreadyRanThisBlock(address token)',
  'error NothingToBuy(address token)',
  'error RouterNotSet()',
  'error PairNotSet(address token)',
  'error SpendMismatch(uint256 reported, uint256 actual)',
  'error BadSpend(uint256 offered, uint256 actual)',
  'error NothingBought(address token)',
] as const

/**
 * IBuybackBurnPlugin: anyone runs a buyback, paced by time (at most 0.25% of the USDC-side reserve per hour, the
 * budget refilling since the token's last run) and at most once per block; everything bought is burned.
 */
export const buybackPluginAbi = parseAbi([
  ...launchFeePluginEntries,
  ...buybackPluginErrors,
  // A run buys through the launchpad or the launch router, whose refusals surface here.
  'error ZeroAmount()',
  'error CurveGraduated()',
  'error NotGraduated()',
  'error SlippageExceeded()',
  'error Expired()',
  'event BuybackRun(address indexed token, address indexed caller, bool graduated, uint256 usdcSpent, uint256 tokensBurned)',
  'function CAP_BPS() view returns (uint256)',
  'function RUN_INTERVAL() view returns (uint256)',
  'function MIN_RUN_USDC() view returns (uint256)',
  'function totalUsdcSpent(address token) view returns (uint256)',
  'function totalTokensBurned(address token) view returns (uint256)',
  'function nextRunBlock(address token) view returns (uint256)',
  'function lastRunAt(address token) view returns (uint256)',
  'function previewRun(address token) view returns (uint256 usdcOffered, bool graduated)',
  'function run(address token) returns (uint256 usdcSpent, uint256 tokensBurned)',
])

/** Deepen pool's own errors; its runs share Buyback & burn's (same names, same selectors). */
const deepenPluginErrors = [
  'error InvalidBurnBps(uint256 burnBps)',
  'error LiquidityMismatch(uint256 expected, uint256 minted)',
] as const

/**
 * IDeepenPoolPlugin: anyone runs it, paced like Buyback & burn (at most 0.25% of the curve's virtual USDC, or of the
 * locked part of the pool's USDC reserve, per hour, and at most once per block). On the curve a run buys and burns;
 * in the pool it splits by the token's burn share between buying and burning and buying and adding liquidity, which
 * is minted to 0x…dEaD.
 */
export const deepenPluginAbi = parseAbi([
  ...launchFeePluginEntries,
  ...buybackPluginErrors,
  ...deepenPluginErrors,
  // A run buys through the launchpad or the launch router and adds to the launch pair, whose refusals surface here.
  'error ZeroAmount()',
  'error CurveGraduated()',
  'error NotGraduated()',
  'error SlippageExceeded()',
  'error Expired()',
  ...launchPairErrors,
  'event DeepenRun(address indexed token, address indexed caller, bool graduated, uint256 usdcSpent, uint256 usdcBurning, uint256 usdcAdded, uint256 tokensBought, uint256 tokensAdded, uint256 tokensBurned, uint256 liquidity)',
  'event BurnShareSet(address indexed token, uint16 burnBps)',
  'function CAP_BPS() view returns (uint256)',
  'function RUN_INTERVAL() view returns (uint256)',
  'function MIN_RUN_USDC() view returns (uint256)',
  'function DEFAULT_BURN_BPS() view returns (uint16)',
  'function LP_RECIPIENT() view returns (address)',
  'function burnBpsOf(address token) view returns (uint16)',
  'function totalUsdcSpent(address token) view returns (uint256)',
  'function totalUsdcBurning(address token) view returns (uint256)',
  'function totalTokensBurned(address token) view returns (uint256)',
  'function totalUsdcAdded(address token) view returns (uint256)',
  'function totalTokensAdded(address token) view returns (uint256)',
  'function totalLiquidityLocked(address token) view returns (uint256)',
  'function nextRunBlock(address token) view returns (uint256)',
  'function lastRunAt(address token) view returns (uint256)',
  'function previewRun(address token) view returns (uint256 usdcOffered, uint256 usdcToBurn, uint256 usdcToDeepen, bool graduated)',
  'function previewSplit(address token, uint256 usdcOffered) view returns (uint256 usdcToBurn, uint256 usdcToBuy, uint256 usdcForLiquidity)',
  'function run(address token) returns (uint256 usdcSpent, uint256 tokensBurned, uint256 liquidity)',
])

const comboPluginErrors = [
  'error InvalidEntryCount(uint256 count)',
  'error ZeroBps(address target)',
  'error BpsSumNot10000(uint256 sum)',
  'error DuplicateEntry(address target)',
  'error DataForNonPlugin(address target)',
] as const

/** IComboPlugin: a token's fees split across up to 5 destinations by bps summing to 10,000. */
export const comboPluginAbi = parseAbi([
  ...launchFeePluginEntries,
  ...comboPluginErrors,
  'event ComboConfigured(address indexed token, address[] targets, uint16[] bps, bool[] isPlugin)',
  'event FeesForwarded(address indexed token, address indexed target, uint256 amount, bool viaHook)',
  'function MAX_ENTRIES() view returns (uint256)',
  'function TOTAL_BPS() view returns (uint256)',
  'function allocationOf(address token) view returns (address[] targets, uint16[] bps, bool[] isPlugin)',
  'function previewSplit(address token, uint256 amount) view returns (uint256[] slices)',
])

/**
 * createToken runs the chosen plugin's onLaunch (and a Combo runs its entries'), and a collection runs onFees, so a
 * plugin's own refusal can end either call. This is the launchpad ABI plus every reference plugin's errors, for
 * those two calls only, so the reason decodes to a sentence instead of "Transaction reverted".
 */
export const launchpadWithPluginErrorsAbi = parseAbi([
  'struct Curve { address token; address creator; address pair; uint128 virtualUsdc; uint128 virtualTokens; uint128 tokensSold; uint64 createdAt; bool graduated; uint16 creatorFeeBps; bool pluginHooks; address plugin; string metadataURI; }',
  'event TokenCreated(address indexed token, address indexed creator, address indexed plugin, address pair, uint16 creatorFeeBps, string name, string symbol, string metadataURI)',
  'error ZeroAddress()',
  'error ZeroAmount()',
  'error UnknownToken()',
  'error CurveGraduated()',
  'error SlippageExceeded()',
  'error InvalidName()',
  'error InvalidSymbol()',
  'error InvalidMetadata()',
  'error LaunchFeeAboveMax()',
  'error CreatorFeeTooHigh()',
  'error InvalidPlugin()',
  // The launchpad's own (no argument); the Combo's DataForNonPlugin(address) is an overload with its own selector.
  'error DataForNonPlugin()',
  'error NotInitialized()',
  'error PluginPullMismatch()',
  ...oz20Errors,
  ...launchFeePluginErrors,
  ...splitPluginErrors,
  ...deepenPluginErrors,
  ...comboPluginErrors,
  'function createToken(string name, string symbol, string metadataURI, uint16 creatorFeeBps, address plugin, bytes pluginData, uint256 initialBuyUsdc, uint256 minTokensOut, uint256 maxLaunchFee) returns (address token)',
  'function collectCreatorFees(address token) returns (uint256 amount)',
])

/** launchpadWithPluginErrorsAbi for the v1.4 launchpad: its createToken takes the pool choice. */
export const launchpadV14WithPluginErrorsAbi = parseAbi([
  curveV14,
  tokenCreatedV14,
  ...launchpadV14Errors,
  ...oz20Errors,
  ...launchFeePluginErrors,
  ...splitPluginErrors,
  ...comboPluginErrors,
  createTokenV14,
  'function collectCreatorFees(address token) returns (uint256 amount)',
])

/** The ERC-165 id of IArchitexFeePlugin: onLaunch(address,address,bytes) ^ onFees(address,uint256). */
export const FEE_PLUGIN_INTERFACE_ID = '0x87732014' as const
