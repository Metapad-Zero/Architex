// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";
import "../interfaces/IArchitexLaunchpad.sol";
import "../interfaces/IArchitexFactory.sol";
import "../interfaces/IArchitexPair.sol";
import "../interfaces/ILaunchToken.sol";
import "./LaunchToken.sol";

/// @title ArchitexLaunchpad v1.2
/// @notice Bonding-curve token launches that graduate into Architex AMM pools.
///
/// Each token gets a constant-product virtual reserve curve:
///   k = virtualUsdc * virtualTokens  (recomputed every trade, never stored)
///   real USDC held for a curve = virtualUsdc - VIRTUAL_USDC_0
///
/// Fee model (v1.1): fees are ACCRUED in `pendingFees` and never pushed to `feeTo` during
/// a trade. Call `collectFees()` permissionlessly to flush. A reverting or USDC-blocklisted
/// `feeTo` can never stop a trade, a launch, or a graduation.
///
/// Graduation: when the last curve token is sold, POOL_SUPPLY tokens + exactly
/// `virtualUsdc - VIRTUAL_USDC_0` USDC (per that curve, never balanceOf) are deposited
/// directly into the Architex pair and LP tokens are permanently locked at DEAD.
/// The router is deliberately NOT used; direct pair.mint() is immune to sync-attack.
///
/// Arc trap: native USDC (18-dec) and ERC-20 USDC (6-dec) are the same balance on Arc.
/// We never call balanceOf or address.balance for accounting — all amounts come from
/// the stored virtual reserves.
///
/// Fee-on-transfer / rebasing tokens are NOT supported (only USDC and LaunchTokens).
/// @dev `name`, `symbol`, `metadataURI` are untrusted bytes — length limits only,
///      no charset validation, no HTML escaping. Rendering rules live in FRONTEND-BRIEF.md.
contract ArchitexLaunchpad is IArchitexLaunchpad, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    // ─── Constants ───────────────────────────────────────────────────────────

    /// @inheritdoc IArchitexLaunchpad
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;
    /// @inheritdoc IArchitexLaunchpad
    uint256 public constant CURVE_SUPPLY = 800_000_000e18;
    /// @inheritdoc IArchitexLaunchpad
    uint256 public constant POOL_SUPPLY = 200_000_000e18;
    /// @inheritdoc IArchitexLaunchpad
    uint256 public constant VIRTUAL_TOKENS_0 = 1_066_666_667e18;
    /// @inheritdoc IArchitexLaunchpad
    /// @dev Sets the scale of every curve. A curve raises 3x this (the virtual token reserve falls to a
    ///      quarter as the 800M sell, so virtual USDC quadruples): 25,000 USDC, which opens the pool at
    ///      25,000 USDC x 200M tokens. v1.1 used 2_916_666_667 (8,750 USDC); the owner judged that pool too
    ///      thin. The shape is unchanged: a 16x price rise, from a 6,250 to a 100,000 USDC market cap.
    uint256 public constant VIRTUAL_USDC_0 = 8_333_333_333;
    /// @inheritdoc IArchitexLaunchpad
    uint256 public constant FEE_BPS = 50;
    /// @inheritdoc IArchitexLaunchpad
    uint256 public constant MAX_LAUNCH_FEE = 100e6;

    address private constant DEAD = 0x000000000000000000000000000000000000dEaD;

    // ─── Immutables ───────────────────────────────────────────────────────────

    /// @inheritdoc IArchitexLaunchpad
    address public immutable usdc;
    /// @inheritdoc IArchitexLaunchpad
    address public immutable factory;

    // ─── Mutable admin ───────────────────────────────────────────────────────

    /// @inheritdoc IArchitexLaunchpad
    address public feeTo;
    /// @inheritdoc IArchitexLaunchpad
    address public feeToSetter;
    /// @inheritdoc IArchitexLaunchpad
    uint256 public launchFee;

    // ─── Fee accrual ─────────────────────────────────────────────────────────

    /// @inheritdoc IArchitexLaunchpad
    /// @notice Trade fees and the launch fee are accrued here; never pushed during a trade.
    ///         Call collectFees() to send to feeTo.
    uint256 public pendingFees;

    // ─── Token registry ──────────────────────────────────────────────────────

    mapping(address => Curve) private _curves;
    address[] private _tokens;

    // ─── Constructor ─────────────────────────────────────────────────────────

    constructor(
        address _usdc,
        address _factory,
        address _feeTo,
        address _feeToSetter,
        uint256 _launchFee
    ) {
        if (_usdc == address(0)) revert ZeroAddress();
        if (_factory == address(0)) revert ZeroAddress();
        if (_feeTo == address(0)) revert ZeroAddress();
        if (_feeToSetter == address(0)) revert ZeroAddress();
        if (_launchFee > MAX_LAUNCH_FEE) revert LaunchFeeTooHigh();
        usdc = _usdc;
        factory = _factory;
        feeTo = _feeTo;
        feeToSetter = _feeToSetter;
        launchFee = _launchFee;
    }

    // ─── No ETH receive ──────────────────────────────────────────────────────

    receive() external payable { revert(); }
    fallback() external payable { revert(); }

    // ─── Admin ────────────────────────────────────────────────────────────────

    /// @inheritdoc IArchitexLaunchpad
    /// @notice Only callable by feeToSetter. Rejects the zero address and the launchpad itself.
    function setFeeTo(address _feeTo) external {
        if (msg.sender != feeToSetter) revert Forbidden();
        if (_feeTo == address(0)) revert ZeroAddress();
        if (_feeTo == address(this)) revert ZeroAddress();
        feeTo = _feeTo;
        emit FeeToUpdated(_feeTo);
    }

    /// @inheritdoc IArchitexLaunchpad
    /// @notice Only callable by the current feeToSetter. Setting to address(0) is an
    ///         IRREVERSIBLE RENOUNCE: the fee admin role is permanently abandoned and
    ///         feeTo can never be changed again.
    function setFeeToSetter(address _feeToSetter) external {
        if (msg.sender != feeToSetter) revert Forbidden();
        // address(0) is allowed here as an explicit irreversible renounce.
        feeToSetter = _feeToSetter;
        emit FeeToSetterUpdated(_feeToSetter);
    }

    /// @inheritdoc IArchitexLaunchpad
    function setLaunchFee(uint256 _launchFee) external {
        if (msg.sender != feeToSetter) revert Forbidden();
        if (_launchFee > MAX_LAUNCH_FEE) revert LaunchFeeTooHigh();
        launchFee = _launchFee;
        emit LaunchFeeUpdated(_launchFee);
    }

    // ─── Fee collection ───────────────────────────────────────────────────────

    /// @inheritdoc IArchitexLaunchpad
    /// @notice Permissionless: sends `pendingFees` to `feeTo`. Safe to call at any time;
    ///         a reverting feeTo reverts only this call, never a trade.
    function collectFees() external returns (uint256 amount) {
        amount = pendingFees;
        if (amount == 0) return 0;
        pendingFees = 0;
        IERC20(usdc).safeTransfer(feeTo, amount);
        emit FeesCollected(feeTo, amount);
    }

    // ─── Token creation ───────────────────────────────────────────────────────

    /// @inheritdoc IArchitexLaunchpad
    /// @notice Deploys a new LaunchToken, registers its curve, and optionally performs
    ///         the creator's first buy atomically (anti-snipe protection).
    ///         `name`/`symbol`/`metadataURI` are untrusted bytes; length limits enforced only.
    function createToken(
        string calldata name,
        string calldata symbol,
        string calldata metadataURI,
        uint256 initialBuyUsdc,
        uint256 minTokensOut
    ) external nonReentrant returns (address token) {
        // ── Validate metadata lengths ─────────────────────────────────────────
        if (bytes(name).length == 0 || bytes(name).length > 32) revert InvalidName();
        if (bytes(symbol).length == 0 || bytes(symbol).length > 10) revert InvalidSymbol();
        if (bytes(metadataURI).length > 256) revert InvalidMetadata();

        // ── Accrue launch fee (pull from creator; accrued, not pushed) ────────
        if (launchFee > 0) {
            IERC20(usdc).safeTransferFrom(msg.sender, address(this), launchFee);
            pendingFees += launchFee;
        }

        // ── Deploy token ──────────────────────────────────────────────────────
        LaunchToken lt = new LaunchToken(name, symbol);
        token = address(lt);

        // ── Resolve / create the Architex pair ───────────────────────────────
        // Never reverts because the pair already exists (attacker can pre-create it).
        address _pair = IArchitexFactory(factory).getPair(token, usdc);
        if (_pair == address(0)) {
            _pair = IArchitexFactory(factory).createPair(token, usdc);
        }
        lt.initPair(_pair);

        // ── Register curve ────────────────────────────────────────────────────
        _curves[token] = Curve({
            token: token,
            creator: msg.sender,
            pair: _pair,
            virtualUsdc: VIRTUAL_USDC_0.toUint128(),
            virtualTokens: VIRTUAL_TOKENS_0.toUint128(),
            tokensSold: 0,
            createdAt: uint64(block.timestamp),
            graduated: false,
            metadataURI: metadataURI
        });
        _tokens.push(token);

        emit TokenCreated(token, msg.sender, _pair, name, symbol, metadataURI);

        // ── Optional creator first buy (anti-snipe; uses internal _buy) ───────
        // initialBuyUsdc == 0 skips entirely and does NOT revert ZeroAmount.
        if (initialBuyUsdc > 0) {
            _buy(token, initialBuyUsdc, minTokensOut, msg.sender);
        }
    }

    // ─── Trading ─────────────────────────────────────────────────────────────

    /// @inheritdoc IArchitexLaunchpad
    /// @notice Buy tokens from the curve. On the sell-out buy, pulls only usdcSpent
    ///         (which is <= usdcIn — never pull-then-refund). Graduates atomically when the
    ///         last token is sold.
    function buy(
        address token,
        uint256 usdcIn,
        uint256 minTokensOut,
        address to
    ) external nonReentrant returns (uint256 tokensOut, uint256 usdcSpent) {
        return _buy(token, usdcIn, minTokensOut, to);
    }

    /// @inheritdoc IArchitexLaunchpad
    /// @notice Sell tokens into the curve. Uses launchpadPull — no ERC-20 approval needed.
    ///         `to` is the USDC recipient; `trader` is always msg.sender.
    function sell(
        address token,
        uint256 tokensIn,
        uint256 minUsdcOut,
        address to
    ) external nonReentrant returns (uint256 usdcOut) {
        Curve storage c = _curves[token];
        if (c.token == address(0)) revert UnknownToken();
        if (c.graduated) revert CurveGraduated();

        uint256 vUsdc = c.virtualUsdc;
        uint256 vTokens = c.virtualTokens;

        // ── Guards + math, the one path quoteSell also takes ──────────────────
        uint256 gross;
        uint256 fee;
        (gross, fee, usdcOut) = _sellQuote(c, tokensIn);
        if (usdcOut < minUsdcOut) revert SlippageExceeded();

        // ── Effects ───────────────────────────────────────────────────────────
        uint256 newVUsdc   = vUsdc - gross;
        uint256 newVTokens = vTokens + tokensIn;
        c.virtualUsdc   = newVUsdc.toUint128();
        c.virtualTokens = newVTokens.toUint128();
        c.tokensSold    = (uint256(c.tokensSold) - tokensIn).toUint128();

        // Accrue fee (never push — feeTo cannot block a sell)
        pendingFees += fee;

        emit Trade(token, msg.sender, false, gross, tokensIn, fee, newVUsdc, newVTokens);

        // ── Interactions ──────────────────────────────────────────────────────
        // Pull tokens from seller via launchpadPull (no ERC-20 approval needed).
        // Always msg.sender — never a user-supplied `from`.
        ILaunchToken(token).launchpadPull(msg.sender, tokensIn);
        // Send net USDC to recipient
        IERC20(usdc).safeTransfer(to, usdcOut);
    }

    // ─── Internal buy logic ───────────────────────────────────────────────────

    /// @dev Shared by buy() and createToken(). The nonReentrant guard is held by the caller.
    function _buy(
        address token,
        uint256 usdcIn,
        uint256 minTokensOut,
        address to
    ) internal returns (uint256 tokensOut, uint256 usdcSpent) {
        Curve storage c = _curves[token];
        if (c.token == address(0)) revert UnknownToken();
        if (c.graduated) revert CurveGraduated();
        if (usdcIn == 0) revert ZeroAmount();

        uint256 vUsdc   = c.virtualUsdc;
        uint256 vTokens = c.virtualTokens;
        uint256 sold    = c.tokensSold;
        uint256 remaining = CURVE_SUPPLY - sold;

        // ── Buy math (shared with quoteBuy) ───────────────────────────────────
        uint256 fee;
        bool graduates;
        (tokensOut, fee, usdcSpent, graduates) = _calcBuy(vUsdc, vTokens, remaining, usdcIn);

        if (tokensOut < minTokensOut) revert SlippageExceeded();

        // ── Effects ───────────────────────────────────────────────────────────
        uint256 net        = usdcSpent - fee;
        uint256 newVUsdc   = vUsdc + net;
        uint256 newVTokens = vTokens - tokensOut;
        c.virtualUsdc   = newVUsdc.toUint128();
        c.virtualTokens = newVTokens.toUint128();
        c.tokensSold    = (sold + tokensOut).toUint128();

        // Accrue fee (never push — feeTo cannot block a buy or graduation)
        pendingFees += fee;

        emit Trade(token, msg.sender, true, usdcSpent, tokensOut, fee, newVUsdc, newVTokens);

        // ── Interactions ──────────────────────────────────────────────────────
        // Pull exact usdcSpent from buyer (never pull-then-refund; usdcSpent <= usdcIn)
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), usdcSpent);
        // Send tokens to recipient
        IERC20(token).safeTransfer(to, tokensOut);

        // ── Graduation (atomic inside the sell-out buy) ───────────────────────
        if (graduates) {
            _graduate(c);
        }
    }

    // ─── Graduation ───────────────────────────────────────────────────────────

    /// @dev Graduation sequence (spec v1.1 §3, exact order):
    ///      (b) require totalSupply==0; (c) markGraduated; (d) transfer tokens+USDC;
    ///      (e) mint LP to DEAD; (f) emit Graduated.
    ///      No other external call in between. No router.
    function _graduate(Curve storage c) internal {
        address token  = c.token;
        address _pair  = c.pair;

        // Real USDC raised on this curve only — never balanceOf
        uint256 usdcSeeded = uint256(c.virtualUsdc) - VIRTUAL_USDC_0;

        // (b) Defense in depth: pair must have no LP yet (enforced by token transfer lock)
        require(IArchitexPair(_pair).totalSupply() == 0, "pair already seeded");

        // (c) Mark graduated; opens transfer-to-pair for token
        c.graduated = true;
        ILaunchToken(token).markGraduated();

        // (d) Transfer POOL_SUPPLY tokens and exactly usdcSeeded USDC directly to pair
        IERC20(token).safeTransfer(_pair, POOL_SUPPLY);
        if (usdcSeeded > 0) {
            IERC20(usdc).safeTransfer(_pair, usdcSeeded);
        }

        // (e) Mint LP tokens permanently to DEAD
        uint256 liquidity = IArchitexPair(_pair).mint(DEAD);

        // (f) Emit
        emit Graduated(token, _pair, usdcSeeded, POOL_SUPPLY, liquidity);
    }

    // ─── Core math — pure, shared by trades and quotes ────────────────────────

    /// @dev Buy math. Returns (tokensOut, fee, usdcSpent, graduates).
    ///      All rounding favours the curve (ceil divisions where needed).
    ///      usdcSpent is ALWAYS <= usdcIn.
    function _calcBuy(
        uint256 vUsdc,
        uint256 vTokens,
        uint256 remaining,
        uint256 usdcIn
    ) internal pure returns (uint256 tokensOut, uint256 fee, uint256 usdcSpent, bool graduates) {
        // k recomputed fresh every trade, never stored
        uint256 k = vUsdc * vTokens;

        // Normal buy fee: ceil(usdcIn * FEE_BPS / 10_000)
        fee = _divCeil(usdcIn * FEE_BPS, 10_000);
        uint256 net = usdcIn - fee;

        // tokensOut = vTokens - ceil(k / (vUsdc + net))
        tokensOut = vTokens - _divCeil(k, vUsdc + net);

        if (tokensOut == 0) revert ZeroAmount();

        if (tokensOut >= remaining) {
            // ── Exact-fill: only pull what's needed for the remaining tokens ──
            // net = ceil(k / (vTokens - remaining)) - vUsdc
            net = _divCeil(k, vTokens - remaining) - vUsdc;
            // usdcSpent = min(usdcIn, net + ceil(net * FEE_BPS / (10_000 - FEE_BPS))): never more than offered.
            uint256 gross = net + _divCeil(net * FEE_BPS, 10_000 - FEE_BPS);
            usdcSpent = gross < usdcIn ? gross : usdcIn;
            // The fee is whatever was pulled beyond `net`. Keeping the uncapped fee here would credit
            // one unit more than was received whenever the cap bites. usdcSpent >= net always holds:
            // this branch is only reached when the offered net already covers `remaining`.
            fee = usdcSpent - net;
            tokensOut = remaining;
            graduates = true;
        } else {
            usdcSpent = usdcIn;
        }
    }

    /// @dev Sell math. Returns (gross, fee).
    ///      gross = vUsdc - ceil(k / (vTokens + tokensIn))
    ///      fee   = ceil(gross * FEE_BPS / 10_000)
    ///      All rounding favours the curve.
    function _calcSell(
        uint256 vUsdc,
        uint256 vTokens,
        uint256 tokensIn
    ) internal pure returns (uint256 gross, uint256 fee) {
        uint256 k = vUsdc * vTokens;
        gross = vUsdc - _divCeil(k, vTokens + tokensIn);
        fee   = _divCeil(gross * FEE_BPS, 10_000);
    }

    // ─── View functions ───────────────────────────────────────────────────────

    /// @inheritdoc IArchitexLaunchpad
    /// @dev Reverts UnknownToken for an address that was never launched here.
    function curves(address token) external view returns (Curve memory) {
        if (_curves[token].token == address(0)) revert UnknownToken();
        return _curves[token];
    }

    /// @inheritdoc IArchitexLaunchpad
    function tokensLength() external view returns (uint256) {
        return _tokens.length;
    }

    /// @inheritdoc IArchitexLaunchpad
    function tokenAt(uint256 index) external view returns (address) {
        return _tokens[index];
    }

    /// @inheritdoc IArchitexLaunchpad
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

    /// @inheritdoc IArchitexLaunchpad
    /// @notice Returns (tokensOut, fee, usdcSpent, graduates). Same code path as buy().
    function quoteBuy(address token, uint256 usdcIn)
        external
        view
        returns (uint256 tokensOut, uint256 fee, uint256 usdcSpent, bool graduates)
    {
        Curve storage c = _curves[token];
        if (c.token == address(0)) revert UnknownToken();
        if (c.graduated) revert CurveGraduated();
        if (usdcIn == 0) revert ZeroAmount();

        uint256 remaining = CURVE_SUPPLY - uint256(c.tokensSold);
        return _calcBuy(c.virtualUsdc, c.virtualTokens, remaining, usdcIn);
    }

    /// @inheritdoc IArchitexLaunchpad
    /// @notice Returns (usdcOut after fee, fee). Same code path as sell().
    ///         `Trade.usdcAmount` on a sell is gross (seller receives usdcOut = gross - fee).
    function quoteSell(address token, uint256 tokensIn)
        external
        view
        returns (uint256 usdcOut, uint256 fee)
    {
        Curve storage c = _curves[token];
        if (c.token == address(0)) revert UnknownToken();
        if (c.graduated) revert CurveGraduated();
        (, fee, usdcOut) = _sellQuote(c, tokensIn);
    }

    /// @dev Every check a sell makes before it touches state, so a quote can never promise what a
    ///      sell would refuse: nothing to sell, more than the curve has sold, or dust worth nothing.
    function _sellQuote(Curve storage c, uint256 tokensIn)
        internal
        view
        returns (uint256 gross, uint256 fee, uint256 usdcOut)
    {
        if (tokensIn == 0) revert ZeroAmount();
        if (tokensIn > uint256(c.tokensSold)) revert ExceedsSold();
        (gross, fee) = _calcSell(c.virtualUsdc, c.virtualTokens, tokensIn);
        usdcOut = gross - fee;
        if (usdcOut == 0) revert ZeroAmount();
    }

    /// @inheritdoc IArchitexLaunchpad
    /// @return USDC (6 decimals) per whole token, scaled by 1e18.
    ///         Formula: virtualUsdc * 1e36 / virtualTokens
    ///         (virtualTokens is 18-dec, so dividing 1e36 by 1e18 gives 1e18-scaled USDC/token)
    function spotPrice(address token) external view returns (uint256) {
        Curve storage c = _curves[token];
        if (c.token == address(0)) revert UnknownToken();
        // After graduation this is the curve's final price (the reserves are frozen), not a revert:
        // lists and indexers read it for every token.
        return uint256(c.virtualUsdc) * 1e36 / uint256(c.virtualTokens);
    }

    /// @inheritdoc IArchitexLaunchpad
    /// @return Spot price × CURVE_SUPPLY / 1e18, in USDC (6 decimals).
    ///         = virtualUsdc * CURVE_SUPPLY / virtualTokens
    function marketCap(address token) external view returns (uint256) {
        Curve storage c = _curves[token];
        if (c.token == address(0)) revert UnknownToken();
        return uint256(c.virtualUsdc) * CURVE_SUPPLY / uint256(c.virtualTokens);
    }

    /// @inheritdoc IArchitexLaunchpad
    /// @return tokensSold * 10_000 / CURVE_SUPPLY (multiply first to avoid truncation to 0)
    function progressBps(address token) external view returns (uint256) {
        Curve storage c = _curves[token];
        if (c.token == address(0)) revert UnknownToken();
        return uint256(c.tokensSold) * 10_000 / CURVE_SUPPLY;
    }

    // ─── Pure math helpers ────────────────────────────────────────────────────

    /// @dev Ceiling division: ceil(a / b). Reverts on b == 0.
    function _divCeil(uint256 a, uint256 b) internal pure returns (uint256) {
        return (a + b - 1) / b;
    }
}
