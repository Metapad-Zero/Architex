// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./interfaces/IArchitexRouter.sol";
import "./interfaces/IArchitexFactory.sol";
import "./interfaces/IArchitexPair.sol";

/// @title Architex Router
/// @notice The only contract end-users and the frontend call for liquidity and swap operations.
///         No native-token (ETH-style) variants: on Arc every asset is an ERC-20.
///
/// Not supported: fee-on-transfer tokens — the router uses exact-amount accounting
/// and does not measure balance deltas, so a deflationary token causes the K-check to revert.
contract ArchitexRouter is IArchitexRouter {
    using SafeERC20 for IERC20;

    /// @inheritdoc IArchitexRouter
    address public immutable factory;

    constructor(address _factory) {
        factory = _factory;
    }

    // ─── Deadline modifier ────────────────────────────────────────────────────

    modifier ensure(uint256 deadline) {
        if (block.timestamp > deadline) revert Expired();
        _;
    }

    // ─── Internal helpers ─────────────────────────────────────────────────────

    /// @dev Returns the pair address for (tokenA, tokenB); reverts when it doesn't exist.
    function _pairFor(address tokenA, address tokenB) internal view returns (address pair) {
        pair = IArchitexFactory(factory).getPair(tokenA, tokenB);
        if (pair == address(0)) revert PairDoesNotExist();
    }

    /// @dev Returns sorted token order and reserves for a pair.
    function _getReserves(address tokenA, address tokenB)
        internal
        view
        returns (uint256 reserveA, uint256 reserveB)
    {
        (address token0,) = _sortTokens(tokenA, tokenB);
        address pair = _pairFor(tokenA, tokenB);
        (uint112 reserve0, uint112 reserve1,) = IArchitexPair(pair).getReserves();
        (reserveA, reserveB) = tokenA == token0 ? (uint256(reserve0), uint256(reserve1)) : (uint256(reserve1), uint256(reserve0));
    }

    function _sortTokens(address tokenA, address tokenB) internal pure returns (address token0, address token1) {
        (token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
    }

    /// @dev Compute the optimal amountB given amountA and current reserves.
    function _optimalAmount(
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        uint256 reserveA,
        uint256 reserveB
    ) internal pure returns (uint256 amountA, uint256 amountB) {
        uint256 amountBOptimal = quote(amountADesired, reserveA, reserveB);
        if (amountBOptimal <= amountBDesired) {
            if (amountBOptimal < amountBMin) revert InsufficientBAmount();
            (amountA, amountB) = (amountADesired, amountBOptimal);
        } else {
            uint256 amountAOptimal = quote(amountBDesired, reserveB, reserveA);
            // amountAOptimal <= amountADesired by construction
            if (amountAOptimal < amountAMin) revert InsufficientAAmount();
            (amountA, amountB) = (amountAOptimal, amountBDesired);
        }
    }

    // ─── Liquidity ────────────────────────────────────────────────────────────

    /// @inheritdoc IArchitexRouter
    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256 amountA, uint256 amountB, uint256 liquidity) {
        // Create pair if needed.
        address pair = IArchitexFactory(factory).getPair(tokenA, tokenB);
        if (pair == address(0)) {
            pair = IArchitexFactory(factory).createPair(tokenA, tokenB);
        }

        (uint256 reserveA, uint256 reserveB) = _getReservesForAdd(tokenA, tokenB);

        if (reserveA == 0 && reserveB == 0) {
            (amountA, amountB) = (amountADesired, amountBDesired);
        } else {
            (amountA, amountB) = _optimalAmount(amountADesired, amountBDesired, amountAMin, amountBMin, reserveA, reserveB);
        }

        IERC20(tokenA).safeTransferFrom(msg.sender, pair, amountA);
        IERC20(tokenB).safeTransferFrom(msg.sender, pair, amountB);
        liquidity = IArchitexPair(pair).mint(to);
    }

    /// @dev Like _getReserves but returns (0,0) without reverting when pair does not exist yet.
    function _getReservesForAdd(address tokenA, address tokenB)
        internal
        view
        returns (uint256 reserveA, uint256 reserveB)
    {
        address pair = IArchitexFactory(factory).getPair(tokenA, tokenB);
        if (pair == address(0)) return (0, 0);
        (address token0,) = _sortTokens(tokenA, tokenB);
        (uint112 reserve0, uint112 reserve1,) = IArchitexPair(pair).getReserves();
        (reserveA, reserveB) = tokenA == token0 ? (uint256(reserve0), uint256(reserve1)) : (uint256(reserve1), uint256(reserve0));
    }

    /// @inheritdoc IArchitexRouter
    function removeLiquidity(
        address tokenA,
        address tokenB,
        uint256 liquidity,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) public ensure(deadline) returns (uint256 amountA, uint256 amountB) {
        address pair = _pairFor(tokenA, tokenB);
        IERC20(pair).safeTransferFrom(msg.sender, pair, liquidity);
        (uint256 amount0, uint256 amount1) = IArchitexPair(pair).burn(to);
        (address token0,) = _sortTokens(tokenA, tokenB);
        (amountA, amountB) = tokenA == token0 ? (amount0, amount1) : (amount1, amount0);
        if (amountA < amountAMin) revert InsufficientAAmount();
        if (amountB < amountBMin) revert InsufficientBAmount();
    }

    /// @inheritdoc IArchitexRouter
    function removeLiquidityWithPermit(
        address tokenA,
        address tokenB,
        uint256 liquidity,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline,
        bool approveMax,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (uint256 amountA, uint256 amountB) {
        address pair = _pairFor(tokenA, tokenB);
        uint256 value = approveMax ? type(uint256).max : liquidity;
        // Audit fix [permit-front-run-grief]: If the signature was already consumed by a
        // front-runner but the allowance is now sufficient, proceed without calling permit.
        // This prevents a griefing DoS where a front-runner submits the permit first.
        if (IERC20(pair).allowance(msg.sender, address(this)) < liquidity) {
            try IArchitexPair(pair).permit(msg.sender, address(this), value, deadline, v, r, s) {} catch {}
            // Re-check: if allowance is STILL insufficient after the try, the remove will revert
            // at safeTransferFrom — no silent bypass of slippage protection.
        }
        (amountA, amountB) = removeLiquidity(tokenA, tokenB, liquidity, amountAMin, amountBMin, to, deadline);
    }

    // ─── Swaps ────────────────────────────────────────────────────────────────

    /// @dev Executes a chain of swaps along `path`, sending each intermediate amount to the next pair.
    function _swap(uint256[] memory amounts, address[] calldata path, address _to) internal {
        for (uint256 i; i < path.length - 1; ++i) {
            (address input, address output) = (path[i], path[i + 1]);
            (address token0,) = _sortTokens(input, output);
            uint256 amountOut = amounts[i + 1];
            (uint256 amount0Out, uint256 amount1Out) =
                input == token0 ? (uint256(0), amountOut) : (amountOut, uint256(0));
            address to = i < path.length - 2 ? _pairFor(output, path[i + 2]) : _to;
            IArchitexPair(_pairFor(input, output)).swap(amount0Out, amount1Out, to, new bytes(0));
        }
    }

    /// @inheritdoc IArchitexRouter
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256[] memory amounts) {
        if (path.length < 2) revert InvalidPath();
        amounts = getAmountsOut(amountIn, path);
        if (amounts[amounts.length - 1] < amountOutMin) revert InsufficientOutputAmount();
        IERC20(path[0]).safeTransferFrom(msg.sender, _pairFor(path[0], path[1]), amounts[0]);
        _swap(amounts, path, to);
    }

    /// @inheritdoc IArchitexRouter
    function swapTokensForExactTokens(
        uint256 amountOut,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256[] memory amounts) {
        if (path.length < 2) revert InvalidPath();
        amounts = getAmountsIn(amountOut, path);
        if (amounts[0] > amountInMax) revert ExcessiveInputAmount();
        IERC20(path[0]).safeTransferFrom(msg.sender, _pairFor(path[0], path[1]), amounts[0]);
        _swap(amounts, path, to);
    }

    // ─── Pure math ────────────────────────────────────────────────────────────

    /// @inheritdoc IArchitexRouter
    function quote(uint256 amountA, uint256 reserveA, uint256 reserveB) public pure returns (uint256 amountB) {
        if (amountA == 0) revert InsufficientAAmount();
        if (reserveA == 0 || reserveB == 0) revert InsufficientLiquidity();
        amountB = amountA * reserveB / reserveA;
    }

    /// @inheritdoc IArchitexRouter
    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        public
        pure
        returns (uint256 amountOut)
    {
        if (amountIn == 0) revert InsufficientInputAmount();
        if (reserveIn == 0 || reserveOut == 0) revert InsufficientLiquidity();
        uint256 amountInWithFee = amountIn * 997;
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = reserveIn * 1000 + amountInWithFee;
        amountOut = numerator / denominator;
    }

    /// @inheritdoc IArchitexRouter
    function getAmountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut)
        public
        pure
        returns (uint256 amountIn)
    {
        if (amountOut == 0) revert InsufficientOutputAmount();
        if (reserveIn == 0 || reserveOut == 0) revert InsufficientLiquidity();
        uint256 numerator = reserveIn * amountOut * 1000;
        uint256 denominator = (reserveOut - amountOut) * 997;
        amountIn = numerator / denominator + 1;
    }

    /// @inheritdoc IArchitexRouter
    function getAmountsOut(uint256 amountIn, address[] calldata path)
        public
        view
        returns (uint256[] memory amounts)
    {
        if (path.length < 2) revert InvalidPath();
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        for (uint256 i; i < path.length - 1; ++i) {
            (uint256 reserveIn, uint256 reserveOut) = _getReserves(path[i], path[i + 1]);
            amounts[i + 1] = getAmountOut(amounts[i], reserveIn, reserveOut);
        }
    }

    /// @inheritdoc IArchitexRouter
    function getAmountsIn(uint256 amountOut, address[] calldata path)
        public
        view
        returns (uint256[] memory amounts)
    {
        if (path.length < 2) revert InvalidPath();
        amounts = new uint256[](path.length);
        amounts[amounts.length - 1] = amountOut;
        for (uint256 i = path.length - 1; i > 0; --i) {
            (uint256 reserveIn, uint256 reserveOut) = _getReserves(path[i - 1], path[i]);
            amounts[i - 1] = getAmountIn(amounts[i], reserveIn, reserveOut);
        }
    }

    // ─── Error forwarding for missing pair ────────────────────────────────────
    // NOTE: _getReserves calls _pairFor which already reverts PairDoesNotExist.

    error InsufficientLiquidity();
    error InsufficientInputAmount();
}
