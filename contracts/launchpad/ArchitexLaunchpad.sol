// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../interfaces/IArchitexLaunchpad.sol";
import "../interfaces/IArchitexFactory.sol";
import "../interfaces/IArchitexPair.sol";
import "../interfaces/ILaunchToken.sol";
import "./LaunchToken.sol";

/// @title ArchitexLaunchpad
/// @notice Bonding-curve token launches that graduate into Architex AMM pools.
///
/// Each token gets a constant-product virtual reserve curve:
///   k = virtualUsdc * virtualTokens  (recomputed every trade, never stored)
///   real USDC held = virtualUsdc - VIRTUAL_USDC_0
///
/// Graduation: when the last curve token is sold, POOL_SUPPLY tokens + all real USDC are
/// deposited directly into the Architex pair and LP tokens are permanently locked at DEAD.
/// The router is deliberately NOT used; direct pair.mint() is immune to sync-attack.
///
/// Not supported: fee-on-transfer / rebasing tokens (only USDC and LaunchTokens are handled).
contract ArchitexLaunchpad is IArchitexLaunchpad, ReentrancyGuard {
    using SafeERC20 for IERC20;

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
    uint256 public constant VIRTUAL_USDC_0 = 2_916_666_667;
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

    // ─── Admin ────────────────────────────────────────────────────────────────

    /// @inheritdoc IArchitexLaunchpad
    function setFeeTo(address _feeTo) external {
        if (msg.sender != feeToSetter) revert Forbidden();
        if (_feeTo == address(0)) revert ZeroAddress();
        feeTo = _feeTo;
        emit FeeToUpdated(_feeTo);
    }

    /// @inheritdoc IArchitexLaunchpad
    function setFeeToSetter(address _feeToSetter) external {
        if (msg.sender != feeToSetter) revert Forbidden();
        if (_feeToSetter == address(0)) revert ZeroAddress();
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

    // ─── Token creation ───────────────────────────────────────────────────────

    /// @inheritdoc IArchitexLaunchpad
    /// @notice Deploys a new LaunchToken, registers its curve, and optionally performs
    ///         the creator's first buy atomically (anti-snipe protection).
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

        // ── Pull launch fee ───────────────────────────────────────────────────
        if (launchFee > 0) {
            IERC20(usdc).safeTransferFrom(msg.sender, feeTo, launchFee);
        }

        // ── Deploy token ──────────────────────────────────────────────────────
        LaunchToken lt = new LaunchToken(name, symbol);
        token = address(lt);

        // ── Resolve / create the Architex pair ───────────────────────────────
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
            virtualUsdc: uint128(VIRTUAL_USDC_0),
            virtualTokens: uint128(VIRTUAL_TOKENS_0),
            tokensSold: 0,
            createdAt: uint64(block.timestamp),
            graduated: false,
            metadataURI: metadataURI
        });
        _tokens.push(token);

        emit TokenCreated(token, msg.sender, _pair, name, symbol, metadataURI);

        // ── Optional creator first buy ─────────────────────────────────────────
        if (initialBuyUsdc > 0) {
            _buy(token, initialBuyUsdc, minTokensOut, msg.sender);
        }
    }

    // ─── Trading ─────────────────────────────────────────────────────────────

    /// @inheritdoc IArchitexLaunchpad
    /// @notice Buy tokens from the curve. On the sell-out buy, pulls only net+fee
    ///         (never pull-then-refund). Graduates atomically when the last token is sold.
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
    function sell(
        address token,
        uint256 tokensIn,
        uint256 minUsdcOut,
        address to
    ) external nonReentrant returns (uint256 usdcOut) {
        Curve storage c = _curves[token];
        if (c.token == address(0)) revert UnknownToken();
        if (c.graduated) revert CurveGraduated();
        if (tokensIn == 0) revert ZeroAmount();

        uint256 vUsdc = c.virtualUsdc;
        uint256 vTokens = c.virtualTokens;

        // ── Curve math ────────────────────────────────────────────────────────
        // k = vUsdc * vTokens (computed fresh, never stored)
        // gross = vUsdc - ceil(k / (vTokens + tokensIn))
        uint256 k = vUsdc * vTokens;
        uint256 gross = vUsdc - _divCeil(k, vTokens + tokensIn);
        uint256 fee = gross * FEE_BPS / 10_000;
        usdcOut = gross - fee;

        if (usdcOut < minUsdcOut) revert SlippageExceeded();

        // ── Effects ───────────────────────────────────────────────────────────
        c.virtualUsdc = uint128(vUsdc - gross);
        c.virtualTokens = uint128(vTokens + tokensIn);
        c.tokensSold = uint128(uint256(c.tokensSold) - tokensIn);

        emit Trade(token, msg.sender, false, gross, tokensIn, fee, c.virtualUsdc, c.virtualTokens);

        // ── Interactions ──────────────────────────────────────────────────────
        // Pull tokens from seller (no approval needed via launchpadPull)
        ILaunchToken(token).launchpadPull(msg.sender, tokensIn);
        // Send fee and net USDC
        if (fee > 0) IERC20(usdc).safeTransfer(feeTo, fee);
        IERC20(usdc).safeTransfer(to, usdcOut);
    }

    // ─── Internal buy logic ───────────────────────────────────────────────────

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

        uint256 vUsdc = c.virtualUsdc;
        uint256 vTokens = c.virtualTokens;
        uint256 sold = c.tokensSold;
        uint256 remaining = CURVE_SUPPLY - sold;

        // ── k recomputed fresh ────────────────────────────────────────────────
        uint256 k = vUsdc * vTokens;

        // ── Normal buy: tokensOut = vTokens - ceil(k / (vUsdc + net)) ─────────
        uint256 fee = usdcIn * FEE_BPS / 10_000;
        uint256 net = usdcIn - fee;
        tokensOut = vTokens - _divCeil(k, vUsdc + net);

        bool graduates = false;

        if (tokensOut >= remaining) {
            // ── Exact-fill: only pull what's needed for the remaining tokens ──
            // net = ceil(k / (vTokens - remaining)) - vUsdc
            net = _divCeil(k, vTokens - remaining) - vUsdc;
            // fee = ceil(net * FEE_BPS / (10_000 - FEE_BPS))
            fee = _divCeil(net * FEE_BPS, 10_000 - FEE_BPS);
            usdcSpent = net + fee;
            tokensOut = remaining;
            graduates = true;
        } else {
            usdcSpent = usdcIn;
        }

        if (tokensOut < minTokensOut) revert SlippageExceeded();

        // ── Effects ───────────────────────────────────────────────────────────
        uint256 newVUsdc = vUsdc + net;
        uint256 newVTokens = vTokens - tokensOut;
        c.virtualUsdc = uint128(newVUsdc);
        c.virtualTokens = uint128(newVTokens);
        c.tokensSold = uint128(sold + tokensOut);

        emit Trade(token, to, true, usdcSpent, tokensOut, fee, newVUsdc, newVTokens);

        // ── Interactions ──────────────────────────────────────────────────────
        // Pull USDC from buyer (exact amount — never pull-then-refund)
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), usdcSpent);
        // Send fee
        if (fee > 0) IERC20(usdc).safeTransfer(feeTo, fee);
        // Send tokens to recipient
        IERC20(token).safeTransfer(to, tokensOut);

        // ── Graduation (atomic, inside the sell-out buy) ──────────────────────
        if (graduates) {
            _graduate(c);
        }
    }

    // ─── Graduation ───────────────────────────────────────────────────────────

    /// @dev Called atomically from _buy when the last curve token is sold.
    ///      Transfers POOL_SUPPLY tokens + all real USDC directly into the pair and
    ///      mints LP to DEAD. Does NOT use the router (immune to sync-attack).
    function _graduate(Curve storage c) internal {
        address token = c.token;
        address _pair = c.pair;

        // Real USDC accumulated = virtualUsdc - VIRTUAL_USDC_0
        uint256 realUsdc = uint256(c.virtualUsdc) - VIRTUAL_USDC_0;

        // Effects: mark graduated BEFORE external calls
        c.graduated = true;
        ILaunchToken(token).markGraduated();

        // Transfer POOL_SUPPLY tokens directly to pair
        IERC20(token).safeTransfer(_pair, POOL_SUPPLY);
        // Transfer all real USDC directly to pair
        if (realUsdc > 0) {
            IERC20(usdc).safeTransfer(_pair, realUsdc);
        }

        // Mint LP tokens to DEAD (permanently locked)
        uint256 liquidity = IArchitexPair(_pair).mint(DEAD);

        emit Graduated(token, _pair, realUsdc, POOL_SUPPLY, liquidity);
    }

    // ─── View functions ───────────────────────────────────────────────────────

    /// @inheritdoc IArchitexLaunchpad
    function curves(address token) external view returns (Curve memory) {
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
    function curvesPage(uint256 start, uint256 count) external view returns (Curve[] memory result) {
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
    /// @notice Returns gross tokensOut, fee, usdcSpent, and whether this buy graduates the curve.
    function quoteBuy(address token, uint256 usdcIn)
        external
        view
        returns (uint256 tokensOut, uint256 fee, uint256 usdcSpent, bool graduates)
    {
        Curve storage c = _curves[token];
        if (c.token == address(0)) revert UnknownToken();
        if (c.graduated) revert CurveGraduated();

        uint256 vUsdc = c.virtualUsdc;
        uint256 vTokens = c.virtualTokens;
        uint256 remaining = CURVE_SUPPLY - uint256(c.tokensSold);
        uint256 k = vUsdc * vTokens;

        fee = usdcIn * FEE_BPS / 10_000;
        uint256 net = usdcIn - fee;
        tokensOut = vTokens - _divCeil(k, vUsdc + net);

        if (tokensOut >= remaining) {
            uint256 netExact = _divCeil(k, vTokens - remaining) - vUsdc;
            uint256 feeExact = _divCeil(netExact * FEE_BPS, 10_000 - FEE_BPS);
            usdcSpent = netExact + feeExact;
            tokensOut = remaining;
            fee = feeExact;
            graduates = true;
        } else {
            usdcSpent = usdcIn;
            graduates = false;
        }
    }

    /// @inheritdoc IArchitexLaunchpad
    /// @notice Returns USDC out after fee, and the fee amount.
    function quoteSell(address token, uint256 tokensIn)
        external
        view
        returns (uint256 usdcOut, uint256 fee)
    {
        Curve storage c = _curves[token];
        if (c.token == address(0)) revert UnknownToken();
        if (c.graduated) revert CurveGraduated();

        uint256 vUsdc = c.virtualUsdc;
        uint256 vTokens = c.virtualTokens;
        uint256 k = vUsdc * vTokens;

        uint256 gross = vUsdc - _divCeil(k, vTokens + tokensIn);
        fee = gross * FEE_BPS / 10_000;
        usdcOut = gross - fee;
    }

    /// @inheritdoc IArchitexLaunchpad
    /// @return USDC (6 decimals) per whole token, scaled by 1e18.
    ///         = virtualUsdc * 1e18 / virtualTokens  (tokens are 18-dec, USDC 6-dec)
    function spotPrice(address token) external view returns (uint256) {
        Curve storage c = _curves[token];
        if (c.token == address(0)) revert UnknownToken();
        // virtualUsdc (6-dec) / virtualTokens (18-dec) * 1e18 = virtualUsdc * 1e18 / virtualTokens
        // Result is in units of (USDC / whole_token) * 1e18
        return uint256(c.virtualUsdc) * 1e18 / uint256(c.virtualTokens);
    }

    /// @inheritdoc IArchitexLaunchpad
    /// @return Spot price × CURVE_SUPPLY / 1e18, in USDC (6 decimals).
    function marketCap(address token) external view returns (uint256) {
        Curve storage c = _curves[token];
        if (c.token == address(0)) revert UnknownToken();
        // spotPrice = vUsdc * 1e18 / vTokens
        // marketCap = spotPrice * CURVE_SUPPLY / 1e18
        //           = vUsdc * 1e18 / vTokens * CURVE_SUPPLY / 1e18
        //           = vUsdc * CURVE_SUPPLY / vTokens
        return uint256(c.virtualUsdc) * CURVE_SUPPLY / uint256(c.virtualTokens);
    }

    /// @inheritdoc IArchitexLaunchpad
    /// @return tokensSold / CURVE_SUPPLY in basis points (0–10_000).
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
