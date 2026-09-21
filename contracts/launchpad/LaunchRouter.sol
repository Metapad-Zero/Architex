// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/ILaunchRouter.sol";
import "../interfaces/ILaunchPair.sol";
import "../interfaces/ILaunchPairFactory.sol";
import "../interfaces/IArchitexLaunchpadLite.sol";
import "../interfaces/ILaunchToken.sol";

/// @title LaunchRouter (launchpad v1.3)
/// @notice The only way to trade in a launch pool (V13-SPEC §4): exact-in buys and sells of graduated launch tokens
///         against USDC. Both fees come from the USDC side and round up: a buy pays them out of the USDC in, a sell
///         out of the USDC out. They are transferred to the launchpad and recorded there with accrueTradeFees, in
///         the same call. Sells move the seller's tokens straight into the pool with the token's `pull`, so they need
///         no approval; the seller is always `msg.sender`.
///
///         The router holds nothing between calls and never reads a balance for accounting: every amount it moves
///         is computed from the pool's reserves. It only calls a token after the launchpad has vouched for it.
contract LaunchRouter is ILaunchRouter {
    using SafeERC20 for IERC20;

    uint256 private constant _BPS = 10_000;

    /// @inheritdoc ILaunchRouter
    address public immutable launchpad;
    /// @inheritdoc ILaunchRouter
    address public immutable factory;
    /// @inheritdoc ILaunchRouter
    address public immutable usdc;
    /// @dev The launchpad's platform fee (FEE_BPS), read once at construction.
    uint256 private immutable _platformFeeBps;

    /// @notice One launch-pool trade. `usdcAmount` is the gross USDC a buyer paid, or the gross USDC leaving the pool
    ///         on a sell (the seller receives usdcAmount - platformFee - creatorFee).
    event PoolTrade(
        address indexed token,
        address indexed trader,
        bool isBuy,
        uint256 usdcAmount,
        uint256 tokenAmount,
        uint256 platformFee,
        uint256 creatorFee
    );

    error ZeroAddress();
    /// @notice The factory or USDC given at construction does not belong to the launchpad.
    error InvalidWiring();

    constructor(address launchpad_, address factory_, address usdc_) {
        if (launchpad_ == address(0) || factory_ == address(0) || usdc_ == address(0)) revert ZeroAddress();
        if (ILaunchPairFactory(factory_).launchpad() != launchpad_) revert InvalidWiring();
        if (IArchitexLaunchpadLite(launchpad_).usdc() != usdc_) revert InvalidWiring();
        launchpad = launchpad_;
        factory = factory_;
        usdc = usdc_;
        _platformFeeBps = IArchitexLaunchpadLite(launchpad_).FEE_BPS();
    }

    // ─── Quotes (the same code path as the trades) ───────────────────────────

    /// @inheritdoc ILaunchRouter
    function quoteBuy(address token, uint256 usdcIn)
        external
        view
        returns (uint256 tokensOut, uint256 platformFee, uint256 creatorFee)
    {
        (address pair, uint256 creatorFeeBps) = _pool(token);
        return _quoteBuy(pair, creatorFeeBps, usdcIn);
    }

    /// @inheritdoc ILaunchRouter
    function quoteSell(address token, uint256 tokensIn)
        external
        view
        returns (uint256 usdcOut, uint256 platformFee, uint256 creatorFee)
    {
        (address pair, uint256 creatorFeeBps) = _pool(token);
        (, platformFee, creatorFee, usdcOut) = _quoteSell(pair, creatorFeeBps, tokensIn);
    }

    // ─── Trades ──────────────────────────────────────────────────────────────

    /// @inheritdoc ILaunchRouter
    function buy(address token, uint256 usdcIn, uint256 minTokensOut, address to, uint256 deadline)
        external
        returns (uint256 tokensOut)
    {
        if (block.timestamp > deadline) revert Expired();
        (address pair, uint256 creatorFeeBps) = _pool(token);
        uint256 platformFee;
        uint256 creatorFee;
        (tokensOut, platformFee, creatorFee) = _quoteBuy(pair, creatorFeeBps, usdcIn);
        if (tokensOut < minTokensOut) revert SlippageExceeded();

        emit PoolTrade(token, msg.sender, true, usdcIn, tokensOut, platformFee, creatorFee);

        IERC20 usdc_ = IERC20(usdc);
        uint256 fees = platformFee + creatorFee;
        usdc_.safeTransferFrom(msg.sender, launchpad, fees);
        IArchitexLaunchpadLite(launchpad).accrueTradeFees(token, platformFee, creatorFee);
        usdc_.safeTransferFrom(msg.sender, pair, usdcIn - fees);
        ILaunchPair(pair).swap(tokensOut, 0, to);
    }

    /// @inheritdoc ILaunchRouter
    function sell(address token, uint256 tokensIn, uint256 minUsdcOut, address to, uint256 deadline)
        external
        returns (uint256 usdcOut)
    {
        if (block.timestamp > deadline) revert Expired();
        (address pair, uint256 creatorFeeBps) = _pool(token);
        (uint256 gross, uint256 platformFee, uint256 creatorFee, uint256 out) = _quoteSell(pair, creatorFeeBps, tokensIn);
        usdcOut = out;
        if (usdcOut < minUsdcOut) revert SlippageExceeded();

        emit PoolTrade(token, msg.sender, false, gross, tokensIn, platformFee, creatorFee);

        // The seller is always msg.sender; the token only lets the router pull into this pair.
        ILaunchToken(token).pull(msg.sender, pair, tokensIn);
        ILaunchPair(pair).swap(0, gross, address(this));
        IERC20 usdc_ = IERC20(usdc);
        usdc_.safeTransfer(launchpad, platformFee + creatorFee);
        IArchitexLaunchpadLite(launchpad).accrueTradeFees(token, platformFee, creatorFee);
        usdc_.safeTransfer(to, usdcOut);
    }

    // ─── Internals ───────────────────────────────────────────────────────────

    /// @dev The launchpad is the source of truth: an address it never launched has no pair, and a token that has not
    ///      graduated has an empty, locked pool.
    function _pool(address token) private view returns (address pair, uint256 creatorFeeBps) {
        IArchitexLaunchpadLite pad = IArchitexLaunchpadLite(launchpad);
        pair = pad.pairOf(token);
        if (pair == address(0)) revert UnknownToken();
        if (!pad.isGraduated(token)) revert NotGraduated();
        creatorFeeBps = pad.creatorFeeBpsOf(token);
    }

    /// @dev Fees round up on the USDC in; the pool pays out floor(net * reserveToken / (reserveUsdc + net)), which
    ///      keeps reserveToken * reserveUsdc from falling.
    function _quoteBuy(address pair, uint256 creatorFeeBps, uint256 usdcIn)
        private
        view
        returns (uint256 tokensOut, uint256 platformFee, uint256 creatorFee)
    {
        if (usdcIn == 0) revert ZeroAmount();
        platformFee = _divCeil(usdcIn * _platformFeeBps, _BPS);
        creatorFee = _divCeil(usdcIn * creatorFeeBps, _BPS);
        if (platformFee + creatorFee >= usdcIn) revert ZeroAmount();
        uint256 net = usdcIn - platformFee - creatorFee;
        (uint112 reserveToken, uint112 reserveUsdc,) = ILaunchPair(pair).getReserves();
        tokensOut = net * reserveToken / (uint256(reserveUsdc) + net);
        if (tokensOut == 0) revert ZeroAmount();
    }

    /// @dev The pool pays floor(tokensIn * reserveUsdc / (reserveToken + tokensIn)) gross; fees round up on that gross.
    function _quoteSell(address pair, uint256 creatorFeeBps, uint256 tokensIn)
        private
        view
        returns (uint256 gross, uint256 platformFee, uint256 creatorFee, uint256 usdcOut)
    {
        if (tokensIn == 0) revert ZeroAmount();
        (uint112 reserveToken, uint112 reserveUsdc,) = ILaunchPair(pair).getReserves();
        gross = tokensIn * reserveUsdc / (uint256(reserveToken) + tokensIn);
        platformFee = _divCeil(gross * _platformFeeBps, _BPS);
        creatorFee = _divCeil(gross * creatorFeeBps, _BPS);
        if (platformFee + creatorFee >= gross) revert ZeroAmount();
        usdcOut = gross - platformFee - creatorFee;
    }

    function _divCeil(uint256 a, uint256 b) private pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }
}
