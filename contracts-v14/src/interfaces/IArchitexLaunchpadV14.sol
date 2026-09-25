// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../../../contracts/interfaces/IArchitexLaunchpadLite.sol";

/// @notice ABI of the Architex launchpad v1.4 (docs/launchpad/V14-SPEC.md): v1.3's curves, fees and plugins, graduating
///         into a Uniswap v4 pool behind the Architex launch hook instead of a launch pair, with an anti-sniping
///         surcharge on the curve's first blocks. Plugins rely only on IArchitexLaunchpadLite, which v1.4 keeps: there
///         `router` is the Architex v4 router, `pairFactory` the hook, and `isLaunchPair` is true for the PoolManager and
///         the hook, so a plugin's recipient checks refuse both.
interface IArchitexLaunchpadV14 is IArchitexLaunchpadLite {
    struct Curve {
        address token;
        address creator;
        uint128 virtualUsdc; // 6 decimals
        uint128 virtualTokens; // 18 decimals
        uint128 tokensSold; // 18 decimals, at most CURVE_SUPPLY
        uint64 createdAt;
        uint64 createdBlock; // the curve's snipe window counts from here
        bool graduated;
        bool openPool; // the creator's choice: anyone may add liquidity to the Uniswap pool
        uint16 creatorFeeBps; // 0..MAX_CREATOR_FEE_BPS, on every buy and sell, locked at launch
        // Whether the plugin declared IArchitexFeePlugin (ERC-165) at launch. Decided once: if true, onLaunch ran and
        // every collection calls onFees with an exact pull; if false, collections are plain transfers.
        bool pluginHooks;
        address plugin; // where creator fees are collected to, locked at launch
        string metadataURI;
    }

    event Initialized(address indexed hook, address indexed router);
    event TokenCreated(
        address indexed token,
        address indexed creator,
        address indexed plugin,
        bool openPool,
        uint16 creatorFeeBps,
        string name,
        string symbol,
        string metadataURI
    );
    event Trade(
        address indexed token,
        address indexed trader,
        bool isBuy,
        uint256 usdcAmount, // gross USDC paid by a buyer, or gross USDC leaving the curve on a sell
        uint256 tokenAmount,
        uint256 platformFee,
        uint256 creatorFee,
        uint256 snipeFee, // the curve's opening surcharge, held for the token's pool
        uint256 virtualUsdc,
        uint256 virtualTokens
    );
    /// @notice The curve sold out and `token`'s Uniswap pool opened: `usdcSeeded` and `tokensSeeded` went to the hook,
    ///         which locked them in a full-range position (`liquidityLocked`), and `snipeLocked` (the curve's snipe fees)
    ///         as a bid.
    event Graduated(
        address indexed token,
        bytes32 indexed poolId,
        uint256 usdcSeeded,
        uint256 tokensSeeded,
        uint256 liquidityLocked,
        uint256 snipeLocked
    );
    /// @notice Fees of a pool trade, already taken to the launchpad by the hook, recorded against `token`.
    event PoolFeesAccrued(address indexed token, uint256 platformFee, uint256 creatorFee);
    event CreatorFeesCollected(address indexed token, address indexed plugin, uint256 amount);
    event FeeToUpdated(address indexed feeTo);
    event FeeToSetterUpdated(address indexed feeToSetter);
    event LaunchFeeUpdated(uint256 launchFee);
    event FeesCollected(address indexed feeTo, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error Forbidden();
    error UnknownToken();
    error CurveGraduated();
    error NotGraduated();
    error SlippageExceeded();
    /// @notice A curve buy or sell mined after its deadline (block.timestamp > deadline), as the launch router rules.
    error Expired();
    /// @notice A sell (or its quote) for more tokens than the curve has sold.
    error ExceedsSold();
    error InvalidName();
    error InvalidSymbol();
    error InvalidMetadata();
    error LaunchFeeTooHigh();
    /// @notice The launch fee is above the most the creator agreed to pay (it was raised after they signed).
    error LaunchFeeAboveMax();
    error CreatorFeeTooHigh();
    /// @notice The plugin could never pass fees on: the zero address, the launchpad, USDC, the router, the hook, the
    ///         PoolManager (anyone could take what is sent there), the new token or another launch token.
    error InvalidPlugin();
    /// @notice pluginData was given for a plugin that does not declare IArchitexFeePlugin, so nothing would ever read
    ///         it: the plugin address is likely mistyped. A plain address (a wallet, a Safe) takes empty pluginData.
    error DataForNonPlugin();
    error NotInitialized();
    error AlreadyInitialized();
    /// @notice initialize() was given a hook or router that is not wired to this launchpad, its USDC and PoolManager.
    error InvalidWiring();
    /// @notice A plugin declaring IArchitexFeePlugin did not pull exactly the amount it was offered in onFees.
    error PluginPullMismatch();

    function feeTo() external view returns (address);
    function feeToSetter() external view returns (address);
    function launchFee() external view returns (uint256);
    /// @notice Platform fees (trade fees and launch fees) accrued in the launchpad and not yet sent to `feeTo`.
    function pendingFees() external view returns (uint256);
    /// @notice `token`'s creator fees accrued in the launchpad and not yet collected to its plugin.
    function pendingCreatorFees(address token) external view returns (uint256);

    function TOTAL_SUPPLY() external view returns (uint256);
    function CURVE_SUPPLY() external view returns (uint256);
    function POOL_SUPPLY() external view returns (uint256);
    function VIRTUAL_TOKENS_0() external view returns (uint256);
    function VIRTUAL_USDC_0() external view returns (uint256);
    function MAX_LAUNCH_FEE() external view returns (uint256);
    /// @notice 1000 (10%): the highest creator fee a token can launch with.
    function MAX_CREATOR_FEE_BPS() external view returns (uint256);
    /// @notice 20: the curve's snipe window, in blocks after the token's creation (about 10 seconds on Arc).
    function SNIPE_BLOCKS() external view returns (uint256);
    /// @notice 9,000 (90%): the surcharge on a curve buy in the creation block, falling to 0 over SNIPE_BLOCKS.
    function SNIPE_START_BPS() external view returns (uint256);
    /// @notice 9,900: platform, creator and snipe fees together never take more than 99% of a buy.
    function MAX_TOTAL_FEE_BPS() external view returns (uint256);
    /// @notice Uniswap v4's PoolManager, where every graduated token's pool lives.
    function poolManager() external view returns (address);
    /// @notice The Architex launch hook every pool is opened behind.
    function hook() external view returns (address);
    /// @notice The curve's snipe fees held for `token`, locked into its pool at graduation.
    function pendingSnipe(address token) external view returns (uint256);
    /// @notice The surcharge, in bps, a curve buy of `token` pays in the current block (0 outside the window).
    function snipeBpsOf(address token) external view returns (uint256);

    /// @notice Once, by the deployer: wires the hook and the router. createToken reverts until then.
    function initialize(address hook_, address router_) external;

    /// @param creatorFeeBps creator fee on every buy and sell, 0..MAX_CREATOR_FEE_BPS, locked forever
    /// @param plugin where creator fees go, locked forever: any address that can pass them on, so not zero, the
    ///        launchpad, USDC, the router, the hook, the PoolManager, the new token or another launch token
    /// @param pluginData passed to the plugin's onLaunch; must be empty unless the plugin declares IArchitexFeePlugin
    /// @param openPool whether anyone may add liquidity to the token's Uniswap pool after graduation, locked forever
    /// @param initialBuyUsdc gross USDC the creator spends on the curve in the same transaction (0 for none)
    /// @param maxLaunchFee the most launch fee the creator will pay; reverts LaunchFeeAboveMax if the fee was raised above it
    function createToken(
        string calldata name,
        string calldata symbol,
        string calldata metadataURI,
        uint16 creatorFeeBps,
        address plugin,
        bytes calldata pluginData,
        bool openPool,
        uint256 initialBuyUsdc,
        uint256 minTokensOut,
        uint256 maxLaunchFee
    ) external returns (address token);

    /// @param deadline reverts Expired if block.timestamp > deadline (the launch router's rule)
    /// @return usdcOut USDC received after both fees
    function sell(address token, uint256 tokensIn, uint256 minUsdcOut, address to, uint256 deadline)
        external
        returns (uint256 usdcOut);

    /// @return tokensOut tokens received
    /// @return platformFee platform fee in USDC, included in usdcSpent
    /// @return creatorFee creator fee in USDC, included in usdcSpent
    /// @return snipeFee the snipe surcharge in USDC, included in usdcSpent (0 outside the window)
    /// @return usdcSpent gross USDC pulled (less than usdcIn only on the buy that sells out the curve)
    /// @return graduates whether this buy sells out the curve and graduates the token
    function quoteBuy(address token, uint256 usdcIn)
        external
        view
        returns (
            uint256 tokensOut,
            uint256 platformFee,
            uint256 creatorFee,
            uint256 snipeFee,
            uint256 usdcSpent,
            bool graduates
        );
    function quoteSell(address token, uint256 tokensIn) external view returns (uint256 usdcOut, uint256 platformFee, uint256 creatorFee);

    function curves(address token) external view returns (Curve memory);
    function tokensLength() external view returns (uint256);
    function tokenAt(uint256 index) external view returns (address);
    function curvesPage(uint256 start, uint256 count) external view returns (Curve[] memory);

    /// @return USDC (6 decimals) per whole token, scaled by 1e18
    function spotPrice(address token) external view returns (uint256);
    /// @return spot price times CURVE_SUPPLY, in USDC (6 decimals)
    function marketCap(address token) external view returns (uint256);
    /// @return tokensSold / CURVE_SUPPLY in basis points
    function progressBps(address token) external view returns (uint256);

    /// @notice Permissionless: sends `pendingFees` to `feeTo`. Fees are never pushed during a trade, so a
    ///         reverting or blocklisted `feeTo` cannot stop trading.
    function collectFees() external returns (uint256 amount);
    /// @notice Permissionless: pays `token`'s accrued creator fees to its plugin (V13-SPEC §2.1). A plugin that declared
    ///         IArchitexFeePlugin at launch (Curve.pluginHooks) gets an exact allowance and onFees, and must pull
    ///         exactly the amount; any other address gets a plain transfer. If this reverts, the fees stay accrued.
    ///         onFees runs inside the launchpad's reentrancy guard: a plugin cannot buy, sell (on the curve or through
    ///         the launch router) or collect from inside it, so buybacks must be separate calls.
    function collectCreatorFees(address token) external returns (uint256 amount);

    function setFeeTo(address feeTo) external;
    /// @notice Setting the zero address is an irreversible renounce.
    function setFeeToSetter(address feeToSetter) external;
    function setLaunchFee(uint256 launchFee) external;
}
