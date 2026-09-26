// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/console2.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {V4Quoter} from "@uniswap/v4-periphery/src/lens/V4Quoter.sol";
import {IV4Quoter} from "@uniswap/v4-periphery/src/interfaces/IV4Quoter.sol";
import {IV4Router} from "@uniswap/v4-periphery/src/interfaces/IV4Router.sol";
import {PrePaySwapper} from "../review7/ReviewBase.sol";
import {Review9Base} from "./Review9Base.sol";
import {MockV4RouterCode} from "./MockV4RouterCode.sol";

interface IMockV4Router {
    function executeActions(bytes calldata params) external payable;
}

/// @notice Claude review #9 (holds): a window buy, whose afterSwap now mints claims, adds a position and burns claims,
///         works through every integration pattern and quotes exactly:
///         - Uniswap's V4Router logic (the Universal Router's v4 path, Uniswap's own build of MockV4Router), exact in and
///           exact out, SETTLE_ALL / TAKE_ALL reading the router's own deltas: the hook's position never leaks into them,
///           and each bid lands from the cheaper of the pre-swap and graduation ticks (the second from above
///           graduation, so capped);
///         - Uniswap's V4Quoter (exact in and exact out), and our router's revert-based quote, equal the fill in the same
///           block and leave no trace (no bid, no claims);
///         - pay-first integrators (sync, transfer, settle, then swap, then take).
abstract contract WindowBuyFlowsTest is Review9Base {
    uint256 internal constant SWAP_EXACT_IN_SINGLE = 0x06;
    uint256 internal constant SWAP_EXACT_OUT_SINGLE = 0x08;
    uint256 internal constant SETTLE_ALL = 0x0c;
    uint256 internal constant TAKE_ALL = 0x0f;

    function _deployMockV4Router() internal returns (address r) {
        bytes memory code = abi.encodePacked(MockV4RouterCode.CREATION, abi.encode(address(manager)));
        assembly ("memory-safe") {
            r := create(0, add(code, 0x20), mload(code))
        }
        require(r != address(0), "deploy");
    }

    struct Books {
        uint256 bids;
        uint256 claims;
        uint256 held;
        uint256 pmUsdc;
    }

    function _books(address token) internal view returns (Books memory b) {
        b = Books(hook.bidCount(token), _hookClaims(), hook.lockHeld(token), usdc.balanceOf(POOL_MANAGER));
    }

    /// @dev The one bid in `logs` sits where the hook puts a window buy's bid made from `pre`: from the cheaper of `pre`
    ///      and the graduation tick (review #9's L1 fix).
    function _assertRange(address token, Vm.Log[] memory logs, int24 pre) internal view {
        Bid[] memory bids = _bidsIn(logs, token);
        assertEq(bids.length, 1, "one bid");
        (int24 lo, int24 hi) = _expectedRange(token, pre);
        assertEq(bids[0].lower, lo, "bid lower");
        assertEq(bids[0].upper, hi, "bid upper");
    }

    function test_universalRouterV4PathExactInAndExactOutInTheWindow() public {
        address token = _graduateWithCurveSnipe(100, false, dave, 0); // opening block, 1% creator fee
        address ur = _deployMockV4Router();
        bool u0 = _usdcIs0(token);
        PoolKey memory key = _key(token);
        Currency cu = Currency.wrap(address(usdc));
        Currency ct = Currency.wrap(token);
        vm.prank(carol);
        usdc.approve(ur, MAX);

        // Exact in: 3,000 USDC, SETTLE_ALL (at most 3,000), TAKE_ALL.
        Books memory b0 = _books(token);
        uint256 u0Bal = usdc.balanceOf(carol);
        bytes memory actions = abi.encodePacked(uint8(SWAP_EXACT_IN_SINGLE), uint8(SETTLE_ALL), uint8(TAKE_ALL));
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(IV4Router.ExactInputSingleParams(key, u0, 3_000e6, 1, ""));
        params[1] = abi.encode(cu, uint256(3_000e6));
        params[2] = abi.encode(ct, uint256(1));
        (, int24 pre) = _slot0(token);
        vm.recordLogs();
        vm.prank(carol);
        IMockV4Router(ur).executeActions(abi.encode(actions, params));
        assertEq(u0Bal - usdc.balanceOf(carol), 3_000e6, "paid exactly the gross");
        assertEq(hook.bidCount(token), b0.bids + 1, "a bid inside the buy");
        _assertRange(token, vm.getRecordedLogs(), pre);
        assertEq(usdc.balanceOf(POOL_MANAGER), b0.pmUsdc + 3_000e6, "the whole buy stays in the PoolManager");
        assertGt(IERC20(token).balanceOf(carol), 0);

        // Exact out: 2M tokens, SETTLE_ALL capped at 100,000 USDC.
        b0 = _books(token);
        u0Bal = usdc.balanceOf(carol);
        uint256 t0 = IERC20(token).balanceOf(carol);
        actions = abi.encodePacked(uint8(SWAP_EXACT_OUT_SINGLE), uint8(SETTLE_ALL), uint8(TAKE_ALL));
        params[0] = abi.encode(IV4Router.ExactOutputSingleParams(key, u0, 2_000_000e18, 100_000e6, ""));
        params[1] = abi.encode(cu, uint256(100_000e6));
        params[2] = abi.encode(ct, uint256(2_000_000e18));
        (, pre) = _slot0(token);
        vm.recordLogs();
        vm.prank(carol);
        IMockV4Router(ur).executeActions(abi.encode(actions, params));
        assertEq(IERC20(token).balanceOf(carol) - t0, 2_000_000e18, "exactly the tokens asked for");
        assertEq(hook.bidCount(token), b0.bids + 1, "a bid inside the exact-out buy too");
        _assertRange(token, vm.getRecordedLogs(), pre); // from above graduation: capped at the graduation tick
        assertEq(usdc.balanceOf(POOL_MANAGER) - b0.pmUsdc, u0Bal - usdc.balanceOf(carol), "all paid is in the PM");
        assertLe(hook.lockHeld(token), 2);
        assertEq(usdc.balanceOf(ur), 0, "nothing stuck in the router");
        assertEq(IERC20(token).balanceOf(ur), 0);
        _assertHookClean(token);
        _assertSolvent();
    }

    function test_quotesInTheWindowEqualTheFillAndLeaveNoTrace() public {
        address token = _graduateWithCurveSnipe(0, false, dave, 0);
        _step(7); // 58.5%
        V4Quoter quoter = new V4Quoter(manager);
        bool u0 = _usdcIs0(token);
        PoolKey memory key = _key(token);
        Books memory b0 = _books(token);

        (uint256 outQ, uint256 gasQ) =
            quoter.quoteExactInputSingle(IV4Quoter.QuoteExactSingleParams(key, u0, 4_000e6, ""));
        (uint256 inQ,) = quoter.quoteExactOutputSingle(IV4Quoter.QuoteExactSingleParams(key, u0, 3_000_000e18, ""));
        uint256 ourQ = router.quoteBuy(token, 4_000e6);
        Books memory b1 = _books(token);
        assertEq(b1.bids, b0.bids, "quotes place no bid");
        assertEq(b1.claims, b0.claims, "quotes leave no claims");
        assertEq(b1.held, b0.held);
        assertEq(outQ, ourQ, "Uniswap's quoter and ours agree");
        console2.log("V4Quoter's gas estimate for a window buy", gasQ);

        uint256 snap = vm.snapshotState();
        vm.prank(carol);
        uint256 got = router.buy(token, 4_000e6, 0, carol, MAX);
        assertEq(got, outQ, "exact-in quote == fill");
        vm.revertToState(snap);

        uint256 before = usdc.balanceOf(address(raw));
        raw.swap(
            key, SwapParams(u0, int256(3_000_000e18), u0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1)
        );
        assertEq(before - usdc.balanceOf(address(raw)), inQ, "exact-out quote == what the fill cost");
    }

    function test_payFirstIntegratorsBuyInTheWindow() public {
        address token = _graduateWithCurveSnipe(0, false, dave, 0);
        PrePaySwapper pp = new PrePaySwapper(manager);
        usdc.mint(address(pp), 10_000e6);
        uint256 bids = hook.bidCount(token);
        uint256 out = pp.buyExactIn(_key(token), _usdcIs0(token), 10_000e6);
        assertGt(out, 0);
        assertEq(hook.bidCount(token), bids + 1);
        _assertHookClean(token);
    }
}

contract WindowBuyFlowsUsdcLowTest is WindowBuyFlowsTest {
    function _usdcAt() internal pure override returns (address) {
        return address(0x0000000000000000000000000000000000001000);
    }
}

contract WindowBuyFlowsUsdcHighTest is WindowBuyFlowsTest {
    function _usdcAt() internal pure override returns (address) {
        return address(uint160(type(uint160).max - 0xfff));
    }
}
