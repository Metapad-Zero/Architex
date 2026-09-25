// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import "./interfaces/IArchitexLaunchpadV14.sol";
import "./interfaces/IArchitexLaunchHook.sol";
import "./interfaces/IArchitexV4Router.sol";
import "./interfaces/ILaunchTokenV14.sol";
import "../../contracts/interfaces/IArchitexFeePlugin.sol";
import "./LaunchTokenV14.sol";

/// @dev The hook's `poolManager()` (Uniswap's ImmutableState), read as an address.
interface IImmutableStateLite {
    function poolManager() external view returns (address);
}

/// @title ArchitexLaunchpad v1.4
/// @notice v1.3's bonding-curve launches (docs/launchpad/V13-SPEC.md), graduating into a Uniswap v4 pool behind the
///         Architex launch hook (docs/launchpad/V14-SPEC.md) instead of a launch pair, with an anti-sniping surcharge on
///         the curve's first SNIPE_BLOCKS blocks that is held for the token's pool and locked into it at graduation.
///
/// Curves: every curve is identical. Constant product on virtual reserves:
///   k = virtualUsdc * virtualTokens  (recomputed every trade, never stored)
///   real USDC held for a curve = virtualUsdc - VIRTUAL_USDC_0
///
/// Fees: a 0.5% platform fee and the token's creator fee (0-10%, locked at launch) on every buy and sell, both in USDC,
/// both rounded up. They are ACCRUED here (`pendingFees`, `pendingCreatorFees[token]`) and never pushed during a
/// trade: `collectFees()` sends the platform's to `feeTo`, `collectCreatorFees(token)` pays the token's plugin, both
/// permissionless. A trade never calls a plugin or `feeTo`, so neither can stop a trade, a launch or a graduation.
/// Pool trades pay the same fees through the hook, which takes them here from the PoolManager and calls
/// `accrueTradeFees`. USDC held == pendingFees + Σ pendingCreatorFees + Σ pendingSnipe + Σ(virtualUsdc -
/// VIRTUAL_USDC_0) over live curves, to the unit (absent donations).
///
/// Graduation: the buy that sells the last curve token sends the hook POOL_SUPPLY tokens, exactly
/// `virtualUsdc - VIRTUAL_USDC_0` USDC (that curve's, never balanceOf) and the curve's snipe fees, and the hook opens the
/// token's pool at the curve's final price and locks it all, atomically. Nobody can open that pool first: the hook only
/// lets itself initialize a pool naming it, and the token refuses transfers into the PoolManager until graduation.
///
/// Arc trap: native USDC (18-dec) and ERC-20 USDC (6-dec) are the same balance on Arc. Accounting never reads
/// balanceOf or address.balance; the only balance read is the exact-pull check in collectCreatorFees, which compares
/// two readings inside one non-reentrant call.
///
/// @dev `name`, `symbol`, `metadataURI` are untrusted bytes: length limits only, no charset validation, no HTML
///      escaping. Rendering rules live in FRONTEND-BRIEF.md. Fee-on-transfer and rebasing tokens are irrelevant: the
///      only quote asset is USDC and the only tokens are LaunchTokens.
contract ArchitexLaunchpadV14 is IArchitexLaunchpadV14, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    // ─── Constants ───────────────────────────────────────────────────────────

    /// @inheritdoc IArchitexLaunchpadV14
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;
    /// @inheritdoc IArchitexLaunchpadV14
    uint256 public constant CURVE_SUPPLY = 800_000_000e18;
    /// @inheritdoc IArchitexLaunchpadV14
    uint256 public constant POOL_SUPPLY = 200_000_000e18;
    /// @inheritdoc IArchitexLaunchpadV14
    uint256 public constant VIRTUAL_TOKENS_0 = 1_066_666_667e18;
    /// @inheritdoc IArchitexLaunchpadV14
    /// @dev Sets the scale of every curve. A curve raises 3x this (the virtual token reserve falls to a quarter as the
    ///      800M sell, so virtual USDC quadruples): 25,000 USDC, which opens the pool at 25,000 USDC x 200M tokens.
    ///      The shape: a 16x price rise, from a 6,250 to a 100,000 USDC market cap. Identical for every curve (owner).
    uint256 public constant VIRTUAL_USDC_0 = 8_333_333_333;
    /// @inheritdoc IArchitexLaunchpadLite
    uint256 public constant FEE_BPS = 50;
    /// @inheritdoc IArchitexLaunchpadV14
    uint256 public constant MAX_LAUNCH_FEE = 100e6;
    /// @inheritdoc IArchitexLaunchpadV14
    uint256 public constant MAX_CREATOR_FEE_BPS = 1000;
    /// @inheritdoc IArchitexLaunchpadV14
    uint256 public constant SNIPE_BLOCKS = 20;
    /// @inheritdoc IArchitexLaunchpadV14
    uint256 public constant SNIPE_START_BPS = 9000;
    /// @inheritdoc IArchitexLaunchpadV14
    uint256 public constant MAX_TOTAL_FEE_BPS = 9900;

    uint256 private constant _BPS = 10_000;

    // ─── Immutables ──────────────────────────────────────────────────────────

    /// @inheritdoc IArchitexLaunchpadLite
    address public immutable usdc;
    /// @inheritdoc IArchitexLaunchpadV14
    address public immutable poolManager;
    /// @dev The only address that may call initialize().
    address private immutable _deployer;

    // ─── Wiring (set once by initialize) ─────────────────────────────────────

    /// @inheritdoc IArchitexLaunchpadV14
    address public hook;
    /// @inheritdoc IArchitexLaunchpadLite
    address public router;

    // ─── Mutable admin ───────────────────────────────────────────────────────

    /// @inheritdoc IArchitexLaunchpadV14
    address public feeTo;
    /// @inheritdoc IArchitexLaunchpadV14
    address public feeToSetter;
    /// @inheritdoc IArchitexLaunchpadV14
    uint256 public launchFee;

    // ─── Fee accrual ─────────────────────────────────────────────────────────

    /// @inheritdoc IArchitexLaunchpadV14
    uint256 public pendingFees;
    /// @inheritdoc IArchitexLaunchpadV14
    mapping(address => uint256) public pendingCreatorFees;
    /// @inheritdoc IArchitexLaunchpadV14
    mapping(address => uint256) public pendingSnipe;

    // ─── Token registry ──────────────────────────────────────────────────────

    mapping(address => Curve) private _curves;
    address[] private _tokens;

    // ─── Constructor ─────────────────────────────────────────────────────────

    /// @dev Deploy order (V14-SPEC §10): this, then the hook (at a mined address, naming this launchpad), then the
    ///      router, then initialize(hook, router) from the same deployer.
    constructor(address _usdc, address _poolManager, address _feeTo, address _feeToSetter, uint256 _launchFee) {
        if (_usdc == address(0) || _poolManager == address(0)) revert ZeroAddress();
        if (_feeTo == address(0)) revert ZeroAddress();
        if (_feeToSetter == address(0)) revert ZeroAddress();
        if (_launchFee > MAX_LAUNCH_FEE) revert LaunchFeeTooHigh();
        usdc = _usdc;
        poolManager = _poolManager;
        _deployer = msg.sender;
        feeTo = _feeTo;
        feeToSetter = _feeToSetter;
        launchFee = _launchFee;
    }

    // ─── No native receive ───────────────────────────────────────────────────

    receive() external payable { revert(); }
    fallback() external payable { revert(); }

    // ─── Wiring ──────────────────────────────────────────────────────────────

    /// @inheritdoc IArchitexLaunchpadV14
    /// @dev The hook and router must point back at this launchpad, its USDC and its PoolManager, so a mis-wired
    ///      deployment fails here, before any token exists. After this call the deployer has no power left.
    function initialize(address _hook, address _router) external {
        if (msg.sender != _deployer) revert Forbidden();
        if (hook != address(0)) revert AlreadyInitialized();
        if (_hook == address(0) || _router == address(0)) revert ZeroAddress();
        hook = _hook;
        router = _router;
        emit Initialized(_hook, _router);

        if (
            IArchitexLaunchHook(_hook).launchpad() != address(this) || IArchitexLaunchHook(_hook).usdc() != usdc
                || address(IImmutableStateLite(_hook).poolManager()) != poolManager
                || IArchitexV4Router(_router).launchpad() != address(this) || IArchitexV4Router(_router).usdc() != usdc
                || IArchitexV4Router(_router).poolManager() != poolManager
        ) revert InvalidWiring();
    }

    /// @inheritdoc IArchitexLaunchpadLite
    /// @dev v1.4 has no pair factory; the hook is what opens pools, so it answers here and plugins' recipient checks
    ///      refuse it.
    function pairFactory() external view returns (address) {
        return hook;
    }

    /// @inheritdoc IArchitexLaunchpadLite
    /// @dev The PoolManager and the hook: USDC sent to either by plain transfer is anyone's to take, or nobody's.
    function isLaunchPair(address account) public view returns (bool) {
        return account != address(0) && (account == poolManager || account == hook);
    }

    // ─── Admin ───────────────────────────────────────────────────────────────

    /// @inheritdoc IArchitexLaunchpadV14
    /// @notice Only callable by feeToSetter. Rejects the zero address and the launchpad itself.
    function setFeeTo(address _feeTo) external {
        if (msg.sender != feeToSetter) revert Forbidden();
        if (_feeTo == address(0)) revert ZeroAddress();
        if (_feeTo == address(this)) revert ZeroAddress();
        feeTo = _feeTo;
        emit FeeToUpdated(_feeTo);
    }

    /// @inheritdoc IArchitexLaunchpadV14
    /// @notice Only callable by the current feeToSetter. Setting to address(0) is an IRREVERSIBLE RENOUNCE: the fee
    ///         admin role is permanently abandoned and feeTo can never be changed again.
    function setFeeToSetter(address _feeToSetter) external {
        if (msg.sender != feeToSetter) revert Forbidden();
        // address(0) is allowed here as an explicit irreversible renounce.
        feeToSetter = _feeToSetter;
        emit FeeToSetterUpdated(_feeToSetter);
    }

    /// @inheritdoc IArchitexLaunchpadV14
    function setLaunchFee(uint256 _launchFee) external {
        if (msg.sender != feeToSetter) revert Forbidden();
        if (_launchFee > MAX_LAUNCH_FEE) revert LaunchFeeTooHigh();
        launchFee = _launchFee;
        emit LaunchFeeUpdated(_launchFee);
    }

    // ─── Fee collection ──────────────────────────────────────────────────────

    /// @inheritdoc IArchitexLaunchpadV14
    /// @notice Permissionless: sends `pendingFees` to `feeTo`. A reverting feeTo reverts only this call, never a trade.
    function collectFees() external nonReentrant returns (uint256 amount) {
        amount = pendingFees;
        if (amount == 0) return 0;
        pendingFees = 0;
        address to = feeTo;
        emit FeesCollected(to, amount);
        IERC20(usdc).safeTransfer(to, amount);
    }

    /// @inheritdoc IArchitexLaunchpadV14
    /// @dev V13-SPEC §2.1. The accrual is zeroed before any external call. For a plugin that declared
    ///      IArchitexFeePlugin at launch (the stored decision, never re-probed, so a plugin whose ERC-165 answer later
    ///      changes cannot be paid in a way it does not credit): approve exactly `amount`, call onFees, then require
    ///      that exactly `amount` left this contract and the allowance is back to zero; otherwise revert and the fees
    ///      stay accrued. Every other address gets a plain transfer. The two balance readings sit inside one
    ///      non-reentrant call that no other launchpad function can interleave with (every value-moving entry point,
    ///      including the hook's accrueTradeFees, holds the same guard).
    function collectCreatorFees(address token) external nonReentrant returns (uint256 amount) {
        Curve storage c = _curves[token];
        address plugin = c.plugin;
        if (plugin == address(0)) revert UnknownToken();
        amount = pendingCreatorFees[token];
        if (amount == 0) return 0;
        pendingCreatorFees[token] = 0;
        emit CreatorFeesCollected(token, plugin, amount);

        IERC20 usdc_ = IERC20(usdc);
        if (c.pluginHooks) {
            uint256 balanceBefore = usdc_.balanceOf(address(this));
            usdc_.forceApprove(plugin, amount);
            IArchitexFeePlugin(plugin).onFees(token, amount);
            // The pre-call balance is the point of this check (V13-SPEC §2.1), not a stale read: during onFees USDC can
            // leave only through the plugin's allowance (exactly `amount`), and every launchpad entry point that moves
            // USDC or accounting holds this call's reentrancy guard. Anything sent in makes the check fail.
            // slither-disable-next-line reentrancy-balance
            if (usdc_.balanceOf(address(this)) + amount != balanceBefore || usdc_.allowance(address(this), plugin) != 0) {
                revert PluginPullMismatch();
            }
        } else {
            usdc_.safeTransfer(plugin, amount);
        }
    }

    /// @inheritdoc IArchitexLaunchpadLite
    /// @dev Hook only, after it has taken exactly these fees here from the PoolManager. Graduated tokens only: before
    ///      graduation the pool does not exist and every trade runs on the curve.
    function accrueTradeFees(address token, uint256 platformFee, uint256 creatorFee) external nonReentrant {
        // Before initialize() the hook is zero, which no caller can be.
        if (msg.sender != hook) revert Forbidden();
        Curve storage c = _curves[token];
        if (c.token == address(0)) revert UnknownToken();
        if (!c.graduated) revert NotGraduated();
        pendingFees += platformFee;
        if (creatorFee != 0) pendingCreatorFees[token] += creatorFee;
        emit PoolFeesAccrued(token, platformFee, creatorFee);
    }

    // ─── Token creation ──────────────────────────────────────────────────────

    /// @inheritdoc IArchitexLaunchpadV14
    /// @notice Deploys a LaunchTokenV14, registers the curve, lets the plugin configure itself
    ///         (onLaunch, only if it declares IArchitexFeePlugin), then runs the creator's optional first buy in the
    ///         same transaction (anti-snipe). The creator's first buy pays the creator fee like any other.
    ///         Reverts InvalidPlugin for a plugin that could never pass fees on, and DataForNonPlugin for pluginData
    ///         given to an address that does not declare IArchitexFeePlugin.
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
    ) external nonReentrant returns (address token) {
        address _router = router;
        address _hook = hook;
        if (_router == address(0)) revert NotInitialized();

        // ── Validate ──────────────────────────────────────────────────────────
        if (bytes(name).length == 0 || bytes(name).length > 32) revert InvalidName();
        if (bytes(symbol).length == 0 || bytes(symbol).length > 10) revert InvalidSymbol();
        if (bytes(metadataURI).length > 256) revert InvalidMetadata();
        if (creatorFeeBps > MAX_CREATOR_FEE_BPS) revert CreatorFeeTooHigh();
        // Paying itself would leave the fees in the launchpad untracked. The rest of the plugin checks need the new
        // token's address (below). The dead address stays allowed: burning the fees is a choice.
        if (plugin == address(0) || plugin == address(this)) revert InvalidPlugin();

        // ── Accrue launch fee (pulled from the creator; accrued, not pushed) ──
        uint256 fee = launchFee;
        if (fee > maxLaunchFee) revert LaunchFeeAboveMax();
        if (fee > 0) {
            pendingFees += fee;
            IERC20(usdc).safeTransferFrom(msg.sender, address(this), fee);
        }

        // ── Deploy token ─────────────────────────────────────────────────────
        // Its pool does not exist until graduation; the token refuses transfers into the PoolManager until then.
        token = address(new LaunchTokenV14(name, symbol, usdc, _router, poolManager, _hook));

        // Addresses that could never pass fees on (V13-SPEC §2.1). USDC, the router and the hook would strand them,
        // and so would this token or any other launch token (the curve registry knows them all: every registered curve
        // has a creator). The PoolManager is worse: USDC sent to it by plain transfer is anyone's to take. The new
        // token's address is predictable.
        if (
            plugin == usdc || plugin == _router || plugin == _hook || plugin == poolManager || plugin == token
                || _curves[plugin].creator != address(0)
        ) revert InvalidPlugin();

        // ── Register curve ───────────────────────────────────────────────────
        // Hooks or plain address is decided here, once, and stored: onFees is called for this token exactly when
        // onLaunch was.
        bool hooks = _hasHooks(plugin);
        // Configuration for an address that turns out not to be a plugin would be silently dropped: a mistyped plugin
        // address would launch fine and take every fee.
        if (!hooks && pluginData.length != 0) revert DataForNonPlugin();
        _curves[token] = Curve({
            token: token,
            creator: msg.sender,
            virtualUsdc: VIRTUAL_USDC_0.toUint128(),
            virtualTokens: VIRTUAL_TOKENS_0.toUint128(),
            tokensSold: 0,
            createdAt: uint64(block.timestamp),
            createdBlock: uint64(block.number),
            graduated: false,
            openPool: openPool,
            creatorFeeBps: creatorFeeBps,
            pluginHooks: hooks,
            plugin: plugin,
            metadataURI: metadataURI
        });
        _tokens.push(token);

        emit TokenCreated(token, msg.sender, plugin, openPool, creatorFeeBps, name, symbol, metadataURI);

        // ── Plugin configuration: after registration, before the first buy ────
        // All remaining gas is forwarded (a large Split or Combo configuration costs over 1M). A reverting onLaunch
        // reverts the launch (the creator's own choice of plugin).
        if (hooks) {
            IArchitexFeePlugin(plugin).onLaunch(token, msg.sender, pluginData);
        }

        // ── Optional creator first buy (anti-snipe; uses internal _buy) ───────
        // initialBuyUsdc == 0 skips entirely and does NOT revert ZeroAmount. It runs in the launch transaction itself,
        // before any bot can act, so it pays no snipe fee.
        if (initialBuyUsdc > 0) {
            _buy(token, initialBuyUsdc, minTokensOut, msg.sender, true);
        }
    }

    // ─── Trading ─────────────────────────────────────────────────────────────

    /// @inheritdoc IArchitexLaunchpadLite
    /// @notice Buy tokens from the curve. On the sell-out buy, pulls only usdcSpent (which is <= usdcIn — never
    ///         pull-then-refund). Graduates atomically when the last token is sold. Reverts Expired after `deadline`.
    function buy(address token, uint256 usdcIn, uint256 minTokensOut, address to, uint256 deadline)
        external
        nonReentrant
        returns (uint256 tokensOut, uint256 usdcSpent)
    {
        if (block.timestamp > deadline) revert Expired();
        return _buy(token, usdcIn, minTokensOut, to, false);
    }

    /// @inheritdoc IArchitexLaunchpadV14
    /// @notice Sell tokens into the curve. The token's `pull` moves them back without an ERC-20 approval, always from
    ///         msg.sender. `to` is the USDC recipient; `trader` in the event is always msg.sender. Reverts Expired
    ///         after `deadline`.
    function sell(address token, uint256 tokensIn, uint256 minUsdcOut, address to, uint256 deadline)
        external
        nonReentrant
        returns (uint256 usdcOut)
    {
        if (block.timestamp > deadline) revert Expired();
        Curve storage c = _curves[token];
        if (c.token == address(0)) revert UnknownToken();
        if (c.graduated) revert CurveGraduated();

        uint256 vUsdc = c.virtualUsdc;
        uint256 vTokens = c.virtualTokens;

        // ── Guards + math, the one path quoteSell also takes ──────────────────
        (uint256 gross, uint256 platformFee, uint256 creatorFee, uint256 out) = _sellQuote(c, tokensIn);
        usdcOut = out;
        if (usdcOut < minUsdcOut) revert SlippageExceeded();

        // ── Effects ──────────────────────────────────────────────────────────
        uint256 newVUsdc = vUsdc - gross;
        uint256 newVTokens = vTokens + tokensIn;
        c.virtualUsdc = newVUsdc.toUint128();
        c.virtualTokens = newVTokens.toUint128();
        c.tokensSold = (uint256(c.tokensSold) - tokensIn).toUint128();

        // Accrue fees (never pushed: neither feeTo nor the plugin can block a sell)
        pendingFees += platformFee;
        if (creatorFee != 0) pendingCreatorFees[token] += creatorFee;

        emit Trade(token, msg.sender, false, gross, tokensIn, platformFee, creatorFee, 0, newVUsdc, newVTokens);

        // ── Interactions ─────────────────────────────────────────────────────
        // Always msg.sender as the seller, never a parameter; the token only lets the launchpad pull into itself.
        ILaunchTokenV14(token).pull(msg.sender, address(this), tokensIn);
        IERC20(usdc).safeTransfer(to, usdcOut);
    }

    // ─── Internal buy logic ──────────────────────────────────────────────────

    /// @dev Shared by buy() and createToken(). The nonReentrant guard is held by the caller. No deadline here:
    ///      buy() checks its own, and createToken's first buy runs in the launch transaction itself (`firstBuy`, which
    ///      pays no snipe fee).
    function _buy(address token, uint256 usdcIn, uint256 minTokensOut, address to, bool firstBuy)
        internal
        returns (uint256 tokensOut, uint256 usdcSpent)
    {
        Curve storage c = _curves[token];
        if (c.token == address(0)) revert UnknownToken();
        if (c.graduated) revert CurveGraduated();
        if (usdcIn == 0) revert ZeroAmount();

        uint256 vUsdc = c.virtualUsdc;
        uint256 vTokens = c.virtualTokens;
        uint256 sold = c.tokensSold;

        // ── Buy math (shared with quoteBuy) ──────────────────────────────────
        uint256 platformFee;
        uint256 creatorFee;
        uint256 snipeFee;
        bool graduates;
        (tokensOut, platformFee, creatorFee, snipeFee, usdcSpent, graduates) = _calcBuy(
            vUsdc, vTokens, CURVE_SUPPLY - sold, usdcIn, c.creatorFeeBps, firstBuy ? 0 : _curveSnipeBps(c)
        );

        if (tokensOut < minTokensOut) revert SlippageExceeded();

        // ── Effects ──────────────────────────────────────────────────────────
        uint256 newVUsdc = vUsdc + (usdcSpent - platformFee - creatorFee - snipeFee);
        uint256 newVTokens = vTokens - tokensOut;
        c.virtualUsdc = newVUsdc.toUint128();
        c.virtualTokens = newVTokens.toUint128();
        c.tokensSold = (sold + tokensOut).toUint128();

        // Accrue fees (never pushed: neither feeTo nor the plugin can block a buy or graduation). The snipe fee waits
        // here for the token's pool.
        pendingFees += platformFee;
        if (creatorFee != 0) pendingCreatorFees[token] += creatorFee;
        if (snipeFee != 0) pendingSnipe[token] += snipeFee;

        emit Trade(token, msg.sender, true, usdcSpent, tokensOut, platformFee, creatorFee, snipeFee, newVUsdc, newVTokens);

        // ── Interactions ─────────────────────────────────────────────────────
        // Pull exact usdcSpent from the buyer (never pull-then-refund; usdcSpent <= usdcIn)
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), usdcSpent);
        IERC20(token).safeTransfer(to, tokensOut);

        // ── Graduation (atomic inside the sell-out buy) ──────────────────────
        if (graduates) {
            _graduate(c);
        }
    }

    // ─── Graduation ──────────────────────────────────────────────────────────

    /// @dev Graduation sequence (V14-SPEC §4, exact order): mark graduated (the token then accepts transfers into the
    ///      PoolManager), send the hook POOL_SUPPLY tokens, the curve's USDC and its snipe fees, and have the hook open
    ///      the pool and lock them. The hook is the only external call after the transfers.
    function _graduate(Curve storage c) internal {
        address token = c.token;
        address _hook = hook;

        // Real USDC raised on this curve only, never balanceOf; the snipe fees are the curve's own too.
        uint256 usdcSeeded = uint256(c.virtualUsdc) - VIRTUAL_USDC_0;
        uint256 snipe = pendingSnipe[token];
        pendingSnipe[token] = 0;

        c.graduated = true;
        ILaunchTokenV14(token).markGraduated();

        IERC20(token).safeTransfer(_hook, POOL_SUPPLY);
        if (usdcSeeded + snipe > 0) {
            IERC20(usdc).safeTransfer(_hook, usdcSeeded + snipe);
        }
        (PoolId poolId, uint128 liquidity) =
            IArchitexLaunchHook(_hook).graduate(token, POOL_SUPPLY, usdcSeeded, snipe, c.openPool, c.creatorFeeBps);

        emit Graduated(token, PoolId.unwrap(poolId), usdcSeeded, POOL_SUPPLY, liquidity, snipe);
    }

    // ─── Core math — pure, shared by trades and quotes ───────────────────────

    /// @dev Buy math (V13-SPEC §5, with the snipe fee as a third fee). All rounding favours the curve; usdcSpent is
    ///      ALWAYS <= usdcIn.
    ///      Normal buy: each fee = ceil(usdcIn*bps/1e4), net = usdcIn - all three.
    ///      Sell-out buy: net = what the remaining tokens cost; gross = net + ceil(net*r/(1e4-r)) capped at usdcIn, with
    ///      r = 50 + c + s; totalFee = usdcSpent - net, split platformFee = ceil(totalFee*50/r), creatorFee =
    ///      ceil(totalFee*c/r) capped at what is left, snipeFee = the rest.
    function _calcBuy(
        uint256 vUsdc,
        uint256 vTokens,
        uint256 remaining,
        uint256 usdcIn,
        uint256 creatorFeeBps,
        uint256 snipeBps
    )
        internal
        pure
        returns (
            uint256 tokensOut,
            uint256 platformFee,
            uint256 creatorFee,
            uint256 snipeFee,
            uint256 usdcSpent,
            bool graduates
        )
    {
        // k recomputed fresh every trade, never stored
        uint256 k = vUsdc * vTokens;

        platformFee = _divCeil(usdcIn * FEE_BPS, _BPS);
        creatorFee = _divCeil(usdcIn * creatorFeeBps, _BPS);
        snipeFee = _divCeil(usdcIn * snipeBps, _BPS);
        // Fees that eat the whole input buy nothing (and would underflow `net`).
        if (platformFee + creatorFee + snipeFee >= usdcIn) revert ZeroAmount();
        uint256 net = usdcIn - platformFee - creatorFee - snipeFee;

        // tokensOut = vTokens - ceil(k / (vUsdc + net))
        tokensOut = vTokens - _divCeil(k, vUsdc + net);

        if (tokensOut == 0) revert ZeroAmount();

        if (tokensOut >= remaining) {
            // ── Exact-fill: only pull what's needed for the remaining tokens ──
            uint256 feeBps = FEE_BPS + creatorFeeBps + snipeBps;
            // net = ceil(k / (vTokens - remaining)) - vUsdc. It is <= the net offered above, so the fee below is >= 0.
            net = _divCeil(k, vTokens - remaining) - vUsdc;
            // usdcSpent = min(usdcIn, net + ceil(net * feeBps / (10_000 - feeBps))): never more than offered. The cap
            // cannot actually bind (the rounded-up normal fees on usdcIn already cover that ceil for the larger offered
            // net), but it stays as the spec writes it. The fees are whatever was pulled beyond `net`, so every unit
            // credited was received.
            uint256 gross = net + _divCeil(net * feeBps, _BPS - feeBps);
            usdcSpent = gross < usdcIn ? gross : usdcIn;
            uint256 totalFee = usdcSpent - net;
            platformFee = _divCeil(totalFee * FEE_BPS, feeBps);
            creatorFee = Math.min(_divCeil(totalFee * creatorFeeBps, feeBps), totalFee - platformFee);
            snipeFee = totalFee - platformFee - creatorFee;
            tokensOut = remaining;
            graduates = true;
        } else {
            usdcSpent = usdcIn;
        }
    }

    /// @dev Sell math. gross = vUsdc - ceil(k / (vTokens + tokensIn)); both fees = ceil(gross * bps / 1e4).
    ///      All rounding favours the curve.
    function _calcSell(uint256 vUsdc, uint256 vTokens, uint256 tokensIn, uint256 creatorFeeBps)
        internal
        pure
        returns (uint256 gross, uint256 platformFee, uint256 creatorFee)
    {
        uint256 k = vUsdc * vTokens;
        gross = vUsdc - _divCeil(k, vTokens + tokensIn);
        platformFee = _divCeil(gross * FEE_BPS, _BPS);
        creatorFee = _divCeil(gross * creatorFeeBps, _BPS);
    }

    /// @dev Every check a sell makes before it touches state, so a quote can never promise what a sell would refuse:
    ///      nothing to sell, more than the curve has sold, or dust whose proceeds the fees consume.
    function _sellQuote(Curve storage c, uint256 tokensIn)
        internal
        view
        returns (uint256 gross, uint256 platformFee, uint256 creatorFee, uint256 usdcOut)
    {
        if (tokensIn == 0) revert ZeroAmount();
        if (tokensIn > uint256(c.tokensSold)) revert ExceedsSold();
        (gross, platformFee, creatorFee) = _calcSell(c.virtualUsdc, c.virtualTokens, tokensIn, c.creatorFeeBps);
        if (platformFee + creatorFee >= gross) revert ZeroAmount();
        usdcOut = gross - platformFee - creatorFee;
    }

    // ─── View functions ──────────────────────────────────────────────────────

    /// @inheritdoc IArchitexLaunchpadV14
    /// @dev Reverts UnknownToken for an address that was never launched here.
    function curves(address token) external view returns (Curve memory) {
        if (_curves[token].token == address(0)) revert UnknownToken();
        return _curves[token];
    }

    /// @inheritdoc IArchitexLaunchpadLite
    function pluginOf(address token) external view returns (address) {
        return _curves[token].plugin;
    }

    /// @inheritdoc IArchitexLaunchpadLite
    function creatorOf(address token) external view returns (address) {
        return _curves[token].creator;
    }

    /// @inheritdoc IArchitexLaunchpadLite
    function creatorFeeBpsOf(address token) external view returns (uint16) {
        return _curves[token].creatorFeeBps;
    }

    /// @inheritdoc IArchitexLaunchpadLite
    /// @dev Where the token's pool liquidity lives: the PoolManager once graduated, nothing before.
    function pairOf(address token) external view returns (address) {
        return _curves[token].graduated ? poolManager : address(0);
    }

    /// @inheritdoc IArchitexLaunchpadV14
    function snipeBpsOf(address token) external view returns (uint256) {
        Curve storage c = _curves[token];
        if (c.token == address(0)) revert UnknownToken();
        return c.graduated ? 0 : _curveSnipeBps(c);
    }

    /// @inheritdoc IArchitexLaunchpadLite
    function isGraduated(address token) external view returns (bool) {
        return _curves[token].graduated;
    }

    /// @inheritdoc IArchitexLaunchpadLite
    function virtualUsdcOf(address token) external view returns (uint256) {
        return _curves[token].virtualUsdc;
    }

    /// @inheritdoc IArchitexLaunchpadV14
    function tokensLength() external view returns (uint256) {
        return _tokens.length;
    }

    /// @inheritdoc IArchitexLaunchpadV14
    function tokenAt(uint256 index) external view returns (address) {
        return _tokens[index];
    }

    /// @inheritdoc IArchitexLaunchpadV14
    /// @param count Clamped to 100 to bound gas.
    function curvesPage(uint256 start, uint256 count) external view returns (Curve[] memory result) {
        if (count > 100) count = 100;
        uint256 len = _tokens.length;
        if (start >= len) return new Curve[](0);
        uint256 end = start + count;
        if (end > len) end = len;
        result = new Curve[](end - start);
        for (uint256 i = start; i < end; i++) {
            result[i - start] = _curves[_tokens[i]];
        }
    }

    /// @inheritdoc IArchitexLaunchpadV14
    /// @notice Same code path as buy().
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
        )
    {
        Curve storage c = _curves[token];
        if (c.token == address(0)) revert UnknownToken();
        if (c.graduated) revert CurveGraduated();
        if (usdcIn == 0) revert ZeroAmount();

        uint256 remaining = CURVE_SUPPLY - uint256(c.tokensSold);
        return _calcBuy(c.virtualUsdc, c.virtualTokens, remaining, usdcIn, c.creatorFeeBps, _curveSnipeBps(c));
    }

    /// @inheritdoc IArchitexLaunchpadV14
    /// @notice Same code path as sell(). `Trade.usdcAmount` on a sell is gross (the seller receives usdcOut).
    function quoteSell(address token, uint256 tokensIn)
        external
        view
        returns (uint256 usdcOut, uint256 platformFee, uint256 creatorFee)
    {
        Curve storage c = _curves[token];
        if (c.token == address(0)) revert UnknownToken();
        if (c.graduated) revert CurveGraduated();
        (, platformFee, creatorFee, usdcOut) = _sellQuote(c, tokensIn);
    }

    /// @inheritdoc IArchitexLaunchpadV14
    /// @return USDC (6 decimals) per whole token, scaled by 1e18: virtualUsdc * 1e36 / virtualTokens.
    function spotPrice(address token) external view returns (uint256) {
        Curve storage c = _curves[token];
        if (c.token == address(0)) revert UnknownToken();
        // After graduation this is the curve's final price (the reserves are frozen), not a revert:
        // lists and indexers read it for every token.
        return uint256(c.virtualUsdc) * 1e36 / uint256(c.virtualTokens);
    }

    /// @inheritdoc IArchitexLaunchpadV14
    /// @return virtualUsdc * CURVE_SUPPLY / virtualTokens, in USDC (6 decimals).
    function marketCap(address token) external view returns (uint256) {
        Curve storage c = _curves[token];
        if (c.token == address(0)) revert UnknownToken();
        return uint256(c.virtualUsdc) * CURVE_SUPPLY / uint256(c.virtualTokens);
    }

    /// @inheritdoc IArchitexLaunchpadV14
    /// @return tokensSold * 10_000 / CURVE_SUPPLY (multiply first to avoid truncation to 0)
    function progressBps(address token) external view returns (uint256) {
        Curve storage c = _curves[token];
        if (c.token == address(0)) revert UnknownToken();
        return uint256(c.tokensSold) * _BPS / CURVE_SUPPLY;
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    /// @dev Whether `plugin` declares IArchitexFeePlugin through ERC-165 (OpenZeppelin ERC165Checker: staticcalls capped
    ///      at 30k gas; an EOA, or a contract that does not answer, is a plain address). Asked once, at launch.
    function _hasHooks(address plugin) private view returns (bool) {
        return ERC165Checker.supportsInterface(plugin, type(IArchitexFeePlugin).interfaceId);
    }

    /// @dev The surcharge on a curve buy in this block: SNIPE_START_BPS in the creation block, falling linearly to 0 after
    ///      SNIPE_BLOCKS, and never more than leaves the total under MAX_TOTAL_FEE_BPS. (The creator's own first buy, in
    ///      the creation transaction, does not ask.)
    function _curveSnipeBps(Curve storage c) internal view returns (uint256 bps) {
        uint256 end = uint256(c.createdBlock) + SNIPE_BLOCKS;
        if (block.number >= end) return 0;
        bps = SNIPE_START_BPS * (end - block.number) / SNIPE_BLOCKS;
        uint256 room = MAX_TOTAL_FEE_BPS - FEE_BPS - c.creatorFeeBps;
        if (bps > room) bps = room;
    }

    /// @dev Ceiling division: ceil(a / b). Reverts on b == 0.
    function _divCeil(uint256 a, uint256 b) internal pure returns (uint256) {
        return (a + b - 1) / b;
    }
}
