// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

contract SmokeToken is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, uint8 decimals_) ERC20(name_, name_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Adds liquidity and swaps through the PoolManager's unlock callback, settling what it owes by transfer.
contract SmokeRouter is IUnlockCallback {
    IPoolManager public immutable manager;

    constructor(IPoolManager manager_) {
        manager = manager_;
    }

    function addLiquidity(PoolKey memory key, ModifyLiquidityParams memory params) external {
        manager.unlock(abi.encode(true, key, abi.encode(params)));
    }

    function swap(PoolKey memory key, SwapParams memory params) external returns (BalanceDelta delta) {
        delta = abi.decode(manager.unlock(abi.encode(false, key, abi.encode(params))), (BalanceDelta));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager), "only manager");
        (bool isAdd, PoolKey memory key, bytes memory inner) = abi.decode(data, (bool, PoolKey, bytes));
        BalanceDelta delta;
        if (isAdd) {
            (delta,) = manager.modifyLiquidity(key, abi.decode(inner, (ModifyLiquidityParams)), "");
        } else {
            delta = manager.swap(key, abi.decode(inner, (SwapParams)), "");
        }
        _square(key.currency0, delta.amount0());
        _square(key.currency1, delta.amount1());
        return abi.encode(delta);
    }

    function _square(Currency currency, int128 amount) private {
        if (amount < 0) {
            manager.sync(currency);
            ERC20(Currency.unwrap(currency)).transfer(address(manager), uint128(-amount));
            manager.settle();
        } else if (amount > 0) {
            manager.take(currency, address(this), uint128(amount));
        }
    }
}

/// @notice Proves the v1.4 test environment: Uniswap's own PoolManager bytecode from Arc, etched at its real address,
///         runs under this profile (Cancun, for its transient storage) and prices a plain pool as expected.
contract PoolManagerSmokeTest is Test {
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;

    IPoolManager internal manager;
    SmokeToken internal usdc;
    SmokeToken internal token;
    SmokeRouter internal router;

    function setUp() public {
        vm.etch(POOL_MANAGER, vm.parseBytes(vm.readFile("contracts-v14/test/fixtures/PoolManager.arc.hex")));
        manager = IPoolManager(POOL_MANAGER);
        usdc = new SmokeToken("USDC", 6);
        token = new SmokeToken("TKN", 18);
        router = new SmokeRouter(manager);
        usdc.mint(address(router), 1_000_000e6);
        token.mint(address(router), 1_000_000_000e18);
    }

    function test_etchedPoolManagerInitializesAddsAndSwaps() public {
        (Currency c0, Currency c1) = address(usdc) < address(token)
            ? (Currency.wrap(address(usdc)), Currency.wrap(address(token)))
            : (Currency.wrap(address(token)), Currency.wrap(address(usdc)));
        PoolKey memory key = PoolKey(c0, c1, 3000, 60, IHooks(address(0)));
        manager.initialize(key, TickMath.getSqrtPriceAtTick(0));
        router.addLiquidity(key, ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: 1e12, salt: 0}));
        BalanceDelta delta = router.swap(
            key, SwapParams({zeroForOne: true, amountSpecified: -1e6, sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1})
        );
        assertEq(delta.amount0(), -1e6, "paid exactly the exact input");
        assertGt(delta.amount1(), 0, "received the other side");
    }
}
