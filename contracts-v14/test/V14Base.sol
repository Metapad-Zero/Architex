// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {ArchitexLaunchpadV14} from "../src/ArchitexLaunchpadV14.sol";
import {ArchitexLaunchHook} from "../src/ArchitexLaunchHook.sol";
import {ArchitexV4Router} from "../src/ArchitexV4Router.sol";
import {IArchitexLaunchHook} from "../src/interfaces/IArchitexLaunchHook.sol";
import {MockUSDC} from "./utils/MockUSDC.sol";

/// @dev Swaps with any SwapParams (exact in or out, any direction), changes liquidity and donates, paying from its own
///      balances. The v1.4 router only does exact-in; this drives the hook's other branches.
contract RawSwapper is IUnlockCallback {
    IPoolManager public immutable manager;

    uint8 private constant _SWAP = 0;
    uint8 private constant _MODIFY = 1;
    uint8 private constant _DONATE = 2;

    constructor(IPoolManager manager_) {
        manager = manager_;
    }

    function swap(PoolKey memory key, SwapParams memory params) external returns (BalanceDelta delta) {
        delta = abi.decode(manager.unlock(abi.encode(_SWAP, key, abi.encode(params))), (BalanceDelta));
    }

    function addLiquidity(PoolKey memory key, ModifyLiquidityParams memory params)
        external
        returns (BalanceDelta delta)
    {
        delta = abi.decode(manager.unlock(abi.encode(_MODIFY, key, abi.encode(params))), (BalanceDelta));
    }

    function donate(PoolKey memory key, uint256 amount0, uint256 amount1) external returns (BalanceDelta delta) {
        delta = abi.decode(manager.unlock(abi.encode(_DONATE, key, abi.encode(amount0, amount1))), (BalanceDelta));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager), "only manager");
        (uint8 op, PoolKey memory key, bytes memory inner) = abi.decode(data, (uint8, PoolKey, bytes));
        BalanceDelta delta;
        if (op == _SWAP) {
            delta = manager.swap(key, abi.decode(inner, (SwapParams)), "");
        } else if (op == _MODIFY) {
            (delta,) = manager.modifyLiquidity(key, abi.decode(inner, (ModifyLiquidityParams)), "");
        } else {
            (uint256 amount0, uint256 amount1) = abi.decode(inner, (uint256, uint256));
            delta = manager.donate(key, amount0, amount1, "");
        }
        _square(key.currency0, delta.amount0());
        _square(key.currency1, delta.amount1());
        return abi.encode(delta);
    }

    function _square(Currency currency, int128 amount) private {
        if (amount < 0) {
            manager.sync(currency);
            IERC20(Currency.unwrap(currency)).transfer(address(manager), uint128(-amount));
            manager.settle();
        } else if (amount > 0) {
            manager.take(currency, address(this), uint128(amount));
        }
    }
}

/// @notice Shared fixture for the v1.4 tests: Uniswap's own PoolManager code from Arc etched at its real address, a
///         mock USDC etched where the concrete test says (so launch tokens sort on either side of it), the v1.4
///         launchpad, the hook at an address carrying its permission bits, and the router.
abstract contract V14Base is Test {
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    /// @dev beforeInitialize, beforeAddLiquidity, beforeSwap, afterSwap, beforeDonate, beforeSwapReturnDelta,
    ///      afterSwapReturnDelta.
    uint160 internal constant HOOK_FLAGS = 0x28EC;
    uint256 internal constant CURVE_RAISE = 24_999_999_968; // what every curve raises (V13-SPEC vectors)
    uint256 internal constant MAX = type(uint256).max;

    IPoolManager internal manager;
    MockUSDC internal usdc;
    ArchitexLaunchpadV14 internal pad;
    ArchitexLaunchHook internal hook;
    ArchitexV4Router internal router;
    RawSwapper internal raw;

    address internal feeTo = makeAddr("feeTo");
    address internal setter = makeAddr("setter");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave");
    address internal creatorWallet = makeAddr("creatorWallet");

    /// @dev Where the mock USDC lives: below every launch token, or above.
    function _usdcAt() internal view virtual returns (address);

    function setUp() public virtual {
        vm.etch(POOL_MANAGER, vm.parseBytes(vm.readFile("contracts-v14/test/fixtures/PoolManager.arc.hex")));
        manager = IPoolManager(POOL_MANAGER);
        deployCodeTo("MockUSDC.sol:MockUSDC", "", _usdcAt());
        usdc = MockUSDC(_usdcAt());

        pad = new ArchitexLaunchpadV14(address(usdc), POOL_MANAGER, feeTo, setter, 1e6);
        address hookAddr = address((uint160(0x4444) << 144) | HOOK_FLAGS);
        deployCodeTo(
            "ArchitexLaunchHook.sol:ArchitexLaunchHook", abi.encode(POOL_MANAGER, address(pad), address(usdc)), hookAddr
        );
        hook = ArchitexLaunchHook(hookAddr);
        router = new ArchitexV4Router(address(pad), address(usdc), POOL_MANAGER);
        pad.initialize(address(hook), address(router));
        raw = new RawSwapper(manager);

        address[5] memory actors = [alice, bob, carol, dave, address(raw)];
        for (uint256 i; i < actors.length; ++i) {
            usdc.mint(actors[i], 100_000_000e6);
            vm.startPrank(actors[i]);
            usdc.approve(address(pad), MAX);
            usdc.approve(address(router), MAX);
            vm.stopPrank();
        }
        vm.roll(1_000);
        vm.warp(1_700_000_000);
    }

    // ─── Fixture ──────────────────────────────────────────────────────────────

    function _launch(uint16 creatorFeeBps, address plugin, bytes memory data, bool openPool, uint256 firstBuy)
        internal
        returns (address token)
    {
        vm.prank(alice);
        token = pad.createToken("Vfour", "VFR", "", creatorFeeBps, plugin, data, openPool, firstBuy, 0, MAX);
    }

    /// @dev A token past the curve's snipe window, bought out by bob in a later block, then stepped past the pool's.
    function _graduated(uint16 creatorFeeBps, bool openPool) internal returns (address token) {
        token = _launch(creatorFeeBps, creatorWallet, "", openPool, 0);
        _step(pad.SNIPE_BLOCKS());
        vm.prank(bob);
        pad.buy(token, 1_000_000e6, 0, bob, MAX);
        assertTrue(pad.isGraduated(token), "graduated");
        _step(hook.SNIPE_BLOCKS());
    }

    /// @dev `blocks` blocks later, about half a second each (Arc), at least a second in all.
    function _step(uint256 blocks) internal {
        vm.roll(vm.getBlockNumber() + blocks);
        vm.warp(vm.getBlockTimestamp() + blocks / 2 + 1);
    }

    function _key(address token) internal view returns (PoolKey memory) {
        return hook.poolKeyOf(token);
    }

    function _usdcIs0(address token) internal view returns (bool) {
        return address(usdc) < token;
    }

    function _ceil(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }

    /// @dev Books `token`'s pool fees in the launchpad (the hook holds them as claims until then).
    function _sync(address token) internal {
        pad.syncPoolFees(token);
    }

    /// @dev The hook's USDC claims in the PoolManager.
    function _hookClaims() internal view returns (uint256) {
        return manager.balanceOf(address(hook), uint256(uint160(address(usdc))));
    }

    // ─── Invariants ───────────────────────────────────────────────────────────

    /// @dev V13-SPEC §6, carried over: the launchpad's USDC is exactly its books.
    function _assertSolvent() internal view {
        uint256 owed = pad.pendingFees();
        uint256 n = pad.tokensLength();
        for (uint256 i; i < n; ++i) {
            address t = pad.tokenAt(i);
            owed += pad.pendingCreatorFees(t) + pad.pendingSnipe(t);
            if (!pad.isGraduated(t)) owed += pad.virtualUsdcOf(t) - pad.VIRTUAL_USDC_0();
        }
        assertEq(usdc.balanceOf(address(pad)), owed, "launchpad USDC == its books");
    }

    /// @dev The hook keeps no launch token and no USDC: all it holds is USDC claims in the PoolManager, exactly what it
    ///      owes over every token (pool fees not yet released, USDC waiting for a bid).
    function _assertHookClean(address token) internal view {
        assertEq(IERC20(token).balanceOf(address(hook)), 0, "hook keeps no token");
        assertEq(usdc.balanceOf(address(hook)), 0, "hook keeps no USDC");
        uint256 owed;
        uint256 n = pad.tokensLength();
        for (uint256 i; i < n; ++i) {
            address t = pad.tokenAt(i);
            owed += hook.pendingPlatform(t) + hook.pendingCreator(t) + hook.lockHeld(t);
        }
        assertEq(_hookClaims(), owed, "hook claims == what it owes");
    }
}
