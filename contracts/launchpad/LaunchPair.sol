// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "../interfaces/ILaunchPair.sol";

/// @title LaunchPair (launchpad v1.3)
/// @notice A graduated launch token's pool: constant product token × USDC with no built-in fee, and its own ERC-20 LP
///         token. V13-SPEC §4:
///         - `swap` is callable only by the launch router, which charges the platform and creator fees, so no trade can
///           skip them. There are no flash swaps (no callback) and no protocol fee.
///         - `mint`/`burn`/`skim`/`sync` are open as in Uniswap V2. The launchpad seeds the pool at graduation with a
///           direct `mint` to 0x…dEaD; anyone can add liquidity on top.
///         - Before graduation the token refuses transfers into this pair, so it holds no tokens and nobody can mint:
///           a first mint of USDC alone underflows (sqrt(0) - MINIMUM_LIQUIDITY).
///
/// Not supported: fee-on-transfer or rebasing tokens (the only tokens here are a LaunchToken and USDC).
contract LaunchPair is ERC20, ILaunchPair {
    using SafeERC20 for IERC20;

    uint256 private constant _MINIMUM_LIQUIDITY = 1000;
    /// @dev Receives the permanently locked MINIMUM_LIQUIDITY on the first mint.
    address private constant _DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @inheritdoc ILaunchPair
    address public immutable factory;
    /// @inheritdoc ILaunchPair
    address public immutable router;
    /// @inheritdoc ILaunchPair
    address public immutable token;
    /// @inheritdoc ILaunchPair
    address public immutable usdc;

    uint112 private _reserveToken;
    uint112 private _reserveUsdc;
    uint32 private _blockTimestampLast;

    uint256 private _unlocked = 1;

    modifier lock() {
        if (_unlocked != 1) revert Locked();
        _unlocked = 2;
        _;
        _unlocked = 1;
    }

    constructor(address token_, address usdc_, address router_) ERC20("Architex Launch LP", "ATX-LLP") {
        factory = msg.sender;
        token = token_;
        usdc = usdc_;
        router = router_;
    }

    // ─── Views ───────────────────────────────────────────────────────────────

    /// @inheritdoc ILaunchPair
    function MINIMUM_LIQUIDITY() external pure returns (uint256) {
        return _MINIMUM_LIQUIDITY;
    }

    /// @inheritdoc ILaunchPair
    function getReserves() public view returns (uint112 reserveToken, uint112 reserveUsdc, uint32 blockTimestampLast) {
        reserveToken = _reserveToken;
        reserveUsdc = _reserveUsdc;
        blockTimestampLast = _blockTimestampLast;
    }

    // ─── Pool ────────────────────────────────────────────────────────────────

    /// @inheritdoc ILaunchPair
    /// @dev Transfer both assets in first. The first mint locks MINIMUM_LIQUIDITY at 0x…dEaD.
    function mint(address to) external lock returns (uint256 liquidity) {
        (uint112 reserveToken, uint112 reserveUsdc,) = getReserves();
        uint256 balanceToken = IERC20(token).balanceOf(address(this));
        uint256 balanceUsdc = IERC20(usdc).balanceOf(address(this));
        uint256 amountToken = balanceToken - reserveToken;
        uint256 amountUsdc = balanceUsdc - reserveUsdc;

        uint256 supply = totalSupply();
        if (supply == 0) {
            uint256 root = Math.sqrt(amountToken * amountUsdc);
            if (root <= _MINIMUM_LIQUIDITY) revert InsufficientLiquidityMinted();
            liquidity = root - _MINIMUM_LIQUIDITY;
            _mint(_DEAD, _MINIMUM_LIQUIDITY);
        } else {
            liquidity = Math.min(amountToken * supply / reserveToken, amountUsdc * supply / reserveUsdc);
        }
        if (liquidity == 0) revert InsufficientLiquidityMinted();
        _mint(to, liquidity);

        _setReserves(balanceToken, balanceUsdc);
        emit Mint(msg.sender, amountToken, amountUsdc);
    }

    /// @inheritdoc ILaunchPair
    /// @dev Transfer the LP tokens in first. Rounds down: the pool keeps the dust.
    function burn(address to) external lock returns (uint256 amountToken, uint256 amountUsdc) {
        IERC20 token_ = IERC20(token);
        IERC20 usdc_ = IERC20(usdc);
        uint256 balanceToken = token_.balanceOf(address(this));
        uint256 balanceUsdc = usdc_.balanceOf(address(this));
        uint256 liquidity = balanceOf(address(this));

        uint256 supply = totalSupply();
        amountToken = liquidity * balanceToken / supply;
        amountUsdc = liquidity * balanceUsdc / supply;
        if (amountToken == 0 || amountUsdc == 0) revert InsufficientLiquidityBurned();
        _burn(address(this), liquidity);

        token_.safeTransfer(to, amountToken);
        usdc_.safeTransfer(to, amountUsdc);

        _setReserves(token_.balanceOf(address(this)), usdc_.balanceOf(address(this)));
        emit Burn(msg.sender, amountToken, amountUsdc, to);
    }

    /// @inheritdoc ILaunchPair
    /// @dev The router transfers the input in before calling. No fee: the check is balanceToken * balanceUsdc >= k.
    function swap(uint256 tokenOut, uint256 usdcOut, address to) external lock {
        if (msg.sender != router) revert OnlyRouter();
        if (tokenOut == 0 && usdcOut == 0) revert InsufficientOutputAmount();
        (uint112 reserveToken, uint112 reserveUsdc,) = getReserves();
        if (tokenOut >= reserveToken || usdcOut >= reserveUsdc) revert InsufficientLiquidity();

        IERC20 token_ = IERC20(token);
        IERC20 usdc_ = IERC20(usdc);
        if (to == address(token_) || to == address(usdc_)) revert InvalidTo();

        if (tokenOut > 0) token_.safeTransfer(to, tokenOut);
        if (usdcOut > 0) usdc_.safeTransfer(to, usdcOut);

        uint256 balanceToken = token_.balanceOf(address(this));
        uint256 balanceUsdc = usdc_.balanceOf(address(this));
        uint256 tokenIn = balanceToken > reserveToken - tokenOut ? balanceToken - (reserveToken - tokenOut) : 0;
        uint256 usdcIn = balanceUsdc > reserveUsdc - usdcOut ? balanceUsdc - (reserveUsdc - usdcOut) : 0;
        if (tokenIn == 0 && usdcIn == 0) revert InsufficientInputAmount();
        if (balanceToken * balanceUsdc < uint256(reserveToken) * uint256(reserveUsdc)) revert K();

        _setReserves(balanceToken, balanceUsdc);
        emit Swap(msg.sender, tokenIn, usdcIn, tokenOut, usdcOut, to);
    }

    /// @inheritdoc ILaunchPair
    /// @dev Sends balances above the reserves to `to`.
    function skim(address to) external lock {
        IERC20 token_ = IERC20(token);
        IERC20 usdc_ = IERC20(usdc);
        uint256 excessToken = token_.balanceOf(address(this)) - _reserveToken;
        uint256 excessUsdc = usdc_.balanceOf(address(this)) - _reserveUsdc;
        if (excessToken > 0) token_.safeTransfer(to, excessToken);
        if (excessUsdc > 0) usdc_.safeTransfer(to, excessUsdc);
    }

    /// @inheritdoc ILaunchPair
    /// @dev Sets the reserves to the balances (e.g. after a donation).
    function sync() external lock {
        _setReserves(IERC20(token).balanceOf(address(this)), IERC20(usdc).balanceOf(address(this)));
    }

    function _setReserves(uint256 balanceToken, uint256 balanceUsdc) private {
        if (balanceToken > type(uint112).max || balanceUsdc > type(uint112).max) revert Overflow();
        _reserveToken = uint112(balanceToken);
        _reserveUsdc = uint112(balanceUsdc);
        _blockTimestampLast = uint32(block.timestamp);
        emit Sync(uint112(balanceToken), uint112(balanceUsdc));
    }
}
