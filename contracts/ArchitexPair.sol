// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IArchitexPair.sol";
import "./interfaces/IArchitexFactory.sol";
import "./interfaces/IArchitexCallee.sol";

/// @title Architex Pair
/// @notice Constant-product (x*y=k) pool that is also its own ERC-20 LP token (with EIP-2612 permit).
///
/// Fee model
/// - Swap fee: 0.30% stays in reserves (numerator 997, denominator 1000).
/// - Protocol fee: when factory.feeTo() != address(0), 1/6 of the sqrt(k) growth since kLast
///   is minted to feeTo as LP tokens on the next mint/burn (exact Uniswap V2 _mintFee).
///
/// Not supported: fee-on-transfer tokens — such tokens cause the K-check to revert because
/// the actual balance received is less than what was transferred. Use only standard ERC-20s.
///
/// Limitations: reserve overflow at uint112 max (~5.19 × 10^33) reverts with Overflow().
///
/// Note: inheriting IArchitexPair would duplicate events already declared in IERC20 (via ERC20),
/// so the contract does NOT list IArchitexPair in its base list. It implements every function
/// the interface declares; casts to IArchitexPair work correctly at runtime.
contract ArchitexPair is ERC20, ERC20Permit {
    using SafeERC20 for IERC20;

    // ─── AMM events (declared here; Transfer/Approval come from ERC20) ────────

    event Mint(address indexed sender, uint256 amount0, uint256 amount1);
    event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to);
    event Swap(
        address indexed sender,
        uint256 amount0In,
        uint256 amount1In,
        uint256 amount0Out,
        uint256 amount1Out,
        address indexed to
    );
    event Sync(uint112 reserve0, uint112 reserve1);

    // ─── Custom errors ────────────────────────────────────────────────────────

    error Locked();
    error Forbidden();
    error InsufficientLiquidityMinted();
    error InsufficientLiquidityBurned();
    error InsufficientOutputAmount();
    error InsufficientLiquidity();
    error InsufficientInputAmount();
    error InvalidTo();
    error K();
    error Overflow();

    // ─── Constants ───────────────────────────────────────────────────────────

    /// @notice See IArchitexPair
    uint256 public constant MINIMUM_LIQUIDITY = 1000;
    /// @dev Address that receives the permanently locked MINIMUM_LIQUIDITY on first mint.
    address private constant DEAD = address(0x000000000000000000000000000000000000dEaD);

    // ─── Storage ──────────────────────────────────────────────────────────────

    /// @notice See IArchitexPair
    address public factory;
    /// @notice See IArchitexPair
    address public token0;
    /// @notice See IArchitexPair
    address public token1;

    uint112 private reserve0;
    uint112 private reserve1;
    uint32  private blockTimestampLast;

    /// @notice See IArchitexPair
    uint256 public price0CumulativeLast;
    /// @notice See IArchitexPair
    uint256 public price1CumulativeLast;
    /// @notice See IArchitexPair
    uint256 public kLast; // reserve0 * reserve1 after the most recent fee-adjusting event

    bool private _locked;

    // ─── Reentrancy guard ────────────────────────────────────────────────────

    modifier lock() {
        if (_locked) revert Locked();
        _locked = true;
        _;
        _locked = false;
    }

    // ─── Constructor ─────────────────────────────────────────────────────────

    constructor() ERC20("Architex LP", "ATX-LP") ERC20Permit("Architex LP") {
        factory = msg.sender;
    }

    // ─── Initialization ───────────────────────────────────────────────────────

    /// @notice See IArchitexPair
    /// @dev Called once by the factory immediately after deployment.
    function initialize(address _token0, address _token1) external {
        if (msg.sender != factory) revert Forbidden();
        token0 = _token0;
        token1 = _token1;
    }

    // ─── Views ───────────────────────────────────────────────────────────────

    /// @notice See IArchitexPair
    function getReserves() public view returns (uint112 _reserve0, uint112 _reserve1, uint32 _blockTimestampLast) {
        _reserve0 = reserve0;
        _reserve1 = reserve1;
        _blockTimestampLast = blockTimestampLast;
    }

    // ─── Internal helpers ─────────────────────────────────────────────────────

    /// @dev Update reserves and cumulative prices. Overflow on uint112 is an error; cumulative
    ///      price overflow is desired (UQ112x112 wraps naturally in uint256 arithmetic).
    function _update(uint256 balance0, uint256 balance1, uint112 _reserve0, uint112 _reserve1) private {
        if (balance0 > type(uint112).max || balance1 > type(uint112).max) revert Overflow();

        uint32 blockTimestamp = uint32(block.timestamp);
        unchecked {
            uint32 timeElapsed = blockTimestamp - blockTimestampLast;
            if (timeElapsed > 0 && _reserve0 > 0 && _reserve1 > 0) {
                // UQ112x112 price: (reserve << 112) / otherReserve
                // Must cast to uint256 before shifting — uint112 << 112 overflows to 0.
                price0CumulativeLast += (uint256(_reserve1) << 112) / uint256(_reserve0) * timeElapsed;
                price1CumulativeLast += (uint256(_reserve0) << 112) / uint256(_reserve1) * timeElapsed;
            }
        }

        reserve0 = uint112(balance0);
        reserve1 = uint112(balance1);
        blockTimestampLast = blockTimestamp;
        emit Sync(reserve0, reserve1);
    }

    /// @dev Mint LP to feeTo equal to 1/6 of the sqrt(k) growth since kLast.
    ///      Returns true when fee was minted (feeTo != 0 and k has grown).
    function _mintFee(uint112 _reserve0, uint112 _reserve1) private returns (bool feeOn) {
        address _feeTo = IArchitexFactory(factory).feeTo();
        feeOn = (_feeTo != address(0));
        uint256 _kLast = kLast;
        if (feeOn) {
            if (_kLast != 0) {
                uint256 rootK = _sqrt(uint256(_reserve0) * uint256(_reserve1));
                uint256 rootKLast = _sqrt(_kLast);
                if (rootK > rootKLast) {
                    uint256 numerator = totalSupply() * (rootK - rootKLast);
                    uint256 denominator = rootK * 5 + rootKLast;
                    uint256 liquidity = numerator / denominator;
                    if (liquidity > 0) _mint(_feeTo, liquidity);
                }
            }
        } else if (_kLast != 0) {
            kLast = 0;
        }
    }

    /// @dev Integer square root (Babylonian method). Always rounds down, so the pool can never
    ///      lose value from MINIMUM_LIQUIDITY being over-estimated.
    function _sqrt(uint256 y) private pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }

    /// @dev min of two uint256s.
    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }

    // ─── AMM core ─────────────────────────────────────────────────────────────

    /// @notice See IArchitexPair
    /// @dev Caller must transfer tokens to this contract before calling mint().
    ///      On first mint, MINIMUM_LIQUIDITY LP units are permanently burned to DEAD.
    function mint(address to) external lock returns (uint256 liquidity) {
        (uint112 _reserve0, uint112 _reserve1,) = getReserves();
        uint256 balance0 = IERC20(token0).balanceOf(address(this));
        uint256 balance1 = IERC20(token1).balanceOf(address(this));
        uint256 amount0 = balance0 - _reserve0;
        uint256 amount1 = balance1 - _reserve1;

        bool feeOn = _mintFee(_reserve0, _reserve1);
        uint256 _totalSupply = totalSupply();

        if (_totalSupply == 0) {
            liquidity = _sqrt(amount0 * amount1) - MINIMUM_LIQUIDITY;
            _mint(DEAD, MINIMUM_LIQUIDITY); // permanent lock
        } else {
            liquidity = _min(amount0 * _totalSupply / _reserve0, amount1 * _totalSupply / _reserve1);
        }

        if (liquidity == 0) revert InsufficientLiquidityMinted();
        _mint(to, liquidity);

        _update(balance0, balance1, _reserve0, _reserve1);
        if (feeOn) kLast = uint256(reserve0) * uint256(reserve1);

        emit Mint(msg.sender, amount0, amount1);
    }

    /// @notice See IArchitexPair
    /// @dev Caller must transfer LP tokens to this contract before calling burn().
    function burn(address to) external lock returns (uint256 amount0, uint256 amount1) {
        (uint112 _reserve0, uint112 _reserve1,) = getReserves();
        address _token0 = token0;
        address _token1 = token1;
        uint256 balance0 = IERC20(_token0).balanceOf(address(this));
        uint256 balance1 = IERC20(_token1).balanceOf(address(this));
        uint256 liquidity = balanceOf(address(this));

        bool feeOn = _mintFee(_reserve0, _reserve1);
        uint256 _totalSupply = totalSupply();

        // Rounding direction: divide then truncate — pool keeps the dust.
        amount0 = liquidity * balance0 / _totalSupply;
        amount1 = liquidity * balance1 / _totalSupply;

        if (amount0 == 0 || amount1 == 0) revert InsufficientLiquidityBurned();
        _burn(address(this), liquidity);

        IERC20(_token0).safeTransfer(to, amount0);
        IERC20(_token1).safeTransfer(to, amount1);

        balance0 = IERC20(_token0).balanceOf(address(this));
        balance1 = IERC20(_token1).balanceOf(address(this));

        _update(balance0, balance1, _reserve0, _reserve1);
        if (feeOn) kLast = uint256(reserve0) * uint256(reserve1);

        emit Burn(msg.sender, amount0, amount1, to);
    }

    /// @notice See IArchitexPair
    /// @dev Either amount0Out or amount1Out (or both for flash swaps) must be > 0.
    ///      `to` must not equal token0 or token1 (guard against re-entrancy via token callbacks).
    ///      K check: (balance0*1000 - amount0In*3) * (balance1*1000 - amount1In*3) >= reserve0*reserve1*1e6
    ///      Flash swap: when data.length > 0, the callee is invoked before the K check.
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external lock {
        if (amount0Out == 0 && amount1Out == 0) revert InsufficientOutputAmount();
        (uint112 _reserve0, uint112 _reserve1,) = getReserves();
        if (amount0Out >= _reserve0 || amount1Out >= _reserve1) revert InsufficientLiquidity();

        address _token0 = token0;
        address _token1 = token1;
        if (to == _token0 || to == _token1) revert InvalidTo();

        // Optimistically transfer out.
        if (amount0Out > 0) IERC20(_token0).safeTransfer(to, amount0Out);
        if (amount1Out > 0) IERC20(_token1).safeTransfer(to, amount1Out);

        // Flash-swap callback.
        if (data.length > 0) IArchitexCallee(to).architexCall(msg.sender, amount0Out, amount1Out, data);

        uint256 balance0 = IERC20(_token0).balanceOf(address(this));
        uint256 balance1 = IERC20(_token1).balanceOf(address(this));

        // Compute amount in from balance delta.
        uint256 amount0In = balance0 > _reserve0 - amount0Out ? balance0 - (_reserve0 - amount0Out) : 0;
        uint256 amount1In = balance1 > _reserve1 - amount1Out ? balance1 - (_reserve1 - amount1Out) : 0;
        if (amount0In == 0 && amount1In == 0) revert InsufficientInputAmount();

        // K invariant check (fee-adjusted).
        unchecked {
            uint256 balance0Adjusted = balance0 * 1000 - amount0In * 3;
            uint256 balance1Adjusted = balance1 * 1000 - amount1In * 3;
            if (balance0Adjusted * balance1Adjusted < uint256(_reserve0) * uint256(_reserve1) * 1_000_000) revert K();
        }

        _update(balance0, balance1, _reserve0, _reserve1);
        emit Swap(msg.sender, amount0In, amount1In, amount0Out, amount1Out, to);
    }

    /// @notice See IArchitexPair
    /// @dev Forces balances to match reserves, sending excess tokens to `to`.
    function skim(address to) external lock {
        address _token0 = token0;
        address _token1 = token1;
        uint256 excess0 = IERC20(_token0).balanceOf(address(this)) - reserve0;
        uint256 excess1 = IERC20(_token1).balanceOf(address(this)) - reserve1;
        if (excess0 > 0) IERC20(_token0).safeTransfer(to, excess0);
        if (excess1 > 0) IERC20(_token1).safeTransfer(to, excess1);
    }

    /// @notice See IArchitexPair
    /// @dev Forces reserves to match current balances (e.g. after a donation).
    function sync() external lock {
        _update(
            IERC20(token0).balanceOf(address(this)),
            IERC20(token1).balanceOf(address(this)),
            reserve0,
            reserve1
        );
    }
}
