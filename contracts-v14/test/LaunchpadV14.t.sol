// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IArchitexLaunchHook} from "../src/interfaces/IArchitexLaunchHook.sol";
import {IArchitexLaunchpadV14} from "../src/interfaces/IArchitexLaunchpadV14.sol";
import {ILaunchTokenV14} from "../src/interfaces/ILaunchTokenV14.sol";
import {V14Base} from "./V14Base.sol";

/// @notice The v1.4 core: graduation into Uniswap v4, the hook's fees on every kind of swap, both snipe windows and
///         their locked bids, open and closed pools. Run for USDC on either side of the token (the two contracts at the
///         bottom), since Arc's USDC sorts below about a fifth of token addresses and above the rest.
abstract contract LaunchpadV14Test is V14Base {
    using PoolIdLibrary for PoolKey;

    // ─── Graduation ───────────────────────────────────────────────────────────

    function test_graduationOpensALockedPoolAtTheCurvesPrice() public {
        address token = _launch(100, creatorWallet, "", false, 0);
        _step(pad.SNIPE_BLOCKS());
        vm.prank(bob);
        pad.buy(token, 1_000_000e6, 0, bob, MAX);
        assertTrue(pad.isGraduated(token));

        (PoolId id, IArchitexLaunchHook.Launch memory l) = hook.launchOf(token);
        assertEq(PoolId.unwrap(id), PoolId.unwrap(_key(token).toId()));
        assertEq(l.token, token);
        assertEq(l.usdcIs0, _usdcIs0(token));
        assertFalse(l.open);
        assertEq(l.creatorFeeBps, 100);

        // The pool holds the 200M tokens and the curve's USDC (less rounding dust, burned or bid).
        assertApproxEqRel(IERC20(token).balanceOf(POOL_MANAGER), 200_000_000e18, 1e9, "pool tokens");
        assertApproxEqAbs(usdc.balanceOf(POOL_MANAGER), CURVE_RAISE, 2, "pool USDC");
        assertEq(IERC20(token).balanceOf(address(pad)), 0, "curve inventory all gone");
        _assertHookClean(token);
        _assertSolvent();
    }

    function test_nobodyElseCanOpenThePool() public {
        address token = _launch(0, creatorWallet, "", false, 0);
        PoolKey memory key = _key(token);
        vm.expectRevert();
        manager.initialize(key, TickMath.getSqrtPriceAtTick(0));
    }

    function test_tokensCannotReachThePoolManagerBeforeGraduation() public {
        address token = _launch(0, creatorWallet, "", false, 0);
        _step(pad.SNIPE_BLOCKS());
        vm.prank(carol);
        pad.buy(token, 100e6, 0, carol, MAX);
        vm.prank(carol);
        vm.expectRevert(ILaunchTokenV14.PoolLockedUntilGraduation.selector);
        IERC20(token).transfer(POOL_MANAGER, 1);
    }

    // ─── Fees: the router (exact in) ──────────────────────────────────────────

    function test_routerBuyPaysBothFeesOnTheUsdcIn() public {
        address token = _graduated(250, false);
        uint256 pf0 = pad.pendingFees();
        uint256 cf0 = pad.pendingCreatorFees(token);
        uint256 usdcIn = 1_000e6;
        uint256 quoted = router.quoteBuy(token, usdcIn);
        uint256 usdc0 = usdc.balanceOf(carol);

        vm.prank(carol);
        uint256 got = router.buy(token, usdcIn, 0, carol, MAX);

        assertEq(got, quoted, "quote is exact");
        assertEq(IERC20(token).balanceOf(carol), got);
        assertEq(usdc0 - usdc.balanceOf(carol), usdcIn, "paid exactly usdcIn");
        // The hook holds the fees as claims; the launchpad books them on a sync.
        assertEq(hook.pendingPlatform(token), _ceil(usdcIn * 50, 1e4), "platform fee held");
        assertEq(hook.pendingCreator(token), _ceil(usdcIn * 250, 1e4), "creator fee held");
        assertEq(pad.pendingFees(), pf0, "not booked before a sync");
        _assertHookClean(token);
        _sync(token);
        assertEq(pad.pendingFees() - pf0, _ceil(usdcIn * 50, 1e4), "platform fee");
        assertEq(pad.pendingCreatorFees(token) - cf0, _ceil(usdcIn * 250, 1e4), "creator fee");
        assertEq(hook.pendingPlatform(token) + hook.pendingCreator(token), 0, "released");
        _assertHookClean(token);
        _assertSolvent();
    }

    function test_routerSellPaysBothFeesOutOfTheUsdcOut() public {
        address token = _graduated(250, false);
        uint256 tokensIn = 10_000_000e18;
        vm.prank(bob);
        IERC20(token).transfer(carol, tokensIn);
        uint256 pf0 = pad.pendingFees();
        uint256 cf0 = pad.pendingCreatorFees(token);
        uint256 quoted = router.quoteSell(token, tokensIn);

        vm.prank(carol);
        uint256 out = router.sell(token, tokensIn, 0, carol, MAX); // no approval: the token lets the router pull
        _sync(token);

        assertEq(out, quoted, "quote is exact");
        uint256 pf = pad.pendingFees() - pf0;
        uint256 cf = pad.pendingCreatorFees(token) - cf0;
        uint256 gross = out + pf + cf;
        assertEq(pf, _ceil(gross * 50, 1e4), "platform fee on the gross");
        assertEq(cf, _ceil(gross * 250, 1e4), "creator fee on the gross");
        assertEq(usdc.balanceOf(carol), 100_000_000e6 + out);
        _assertHookClean(token);
        _assertSolvent();
    }

    function test_aRoundTripNeverReturnsMoreThanWasPaid() public {
        address token = _graduated(0, false);
        vm.startPrank(carol);
        uint256 got = router.buy(token, 5_000e6, 0, carol, MAX);
        uint256 out = router.sell(token, got, 0, carol, MAX);
        vm.stopPrank();
        assertLt(out, 5_000e6);
    }

    function test_slippageAndDeadline() public {
        address token = _graduated(0, false);
        uint256 quoted = router.quoteBuy(token, 100e6);
        vm.prank(carol);
        vm.expectRevert();
        router.buy(token, 100e6, quoted + 1, carol, MAX);
        vm.prank(carol);
        vm.expectRevert();
        router.buy(token, 100e6, 0, carol, block.timestamp - 1);
    }

    // ─── Fees: exact out, through any router ──────────────────────────────────

    function test_exactOutBuyPaysFeesOnTopOfWhatThePoolNeeds() public {
        address token = _graduated(300, false);
        PoolKey memory key = _key(token);
        bool usdcIs0 = _usdcIs0(token);
        uint256 pf0 = pad.pendingFees();
        uint256 cf0 = pad.pendingCreatorFees(token);
        uint256 usdc0 = usdc.balanceOf(address(raw));
        uint256 tokensWanted = 1_000_000e18;

        BalanceDelta d = raw.swap(
            key,
            SwapParams({
                zeroForOne: usdcIs0,
                amountSpecified: int256(tokensWanted),
                sqrtPriceLimitX96: usdcIs0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            })
        );
        assertEq(uint256(int256(usdcIs0 ? d.amount1() : d.amount0())), tokensWanted, "exactly the tokens asked for");
        _sync(token);
        uint256 paid = usdc0 - usdc.balanceOf(address(raw));
        uint256 pf = pad.pendingFees() - pf0;
        uint256 cf = pad.pendingCreatorFees(token) - cf0;
        uint256 net = paid - pf - cf;
        // v1.3's exact-fill rule: gross = net + ceil(net * r / (1e4 - r)), split platform first.
        uint256 total = _ceil(net * 350, 1e4 - 350);
        assertEq(pf + cf, total, "fees on top of the pool's net");
        assertEq(pf, _ceil(total * 50, 350), "platform share");
        _assertHookClean(token);
        _assertSolvent();
    }

    function test_exactOutSellPaysOutExactlyTheUsdcAsked() public {
        address token = _graduated(300, false);
        vm.prank(bob);
        IERC20(token).transfer(address(raw), 50_000_000e18);
        PoolKey memory key = _key(token);
        bool usdcIs0 = _usdcIs0(token);
        uint256 pf0 = pad.pendingFees();
        uint256 cf0 = pad.pendingCreatorFees(token);
        uint256 usdc0 = usdc.balanceOf(address(raw));
        uint256 usdcWanted = 1_000e6;

        raw.swap(
            key,
            SwapParams({
                zeroForOne: !usdcIs0,
                amountSpecified: int256(usdcWanted),
                sqrtPriceLimitX96: !usdcIs0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            })
        );
        assertEq(usdc.balanceOf(address(raw)) - usdc0, usdcWanted, "exactly the USDC asked for");
        _sync(token);
        uint256 total = _ceil(usdcWanted * 350, 1e4 - 350);
        assertEq((pad.pendingFees() - pf0) + (pad.pendingCreatorFees(token) - cf0), total, "fees on top of the net");
        _assertHookClean(token);
        _assertSolvent();
    }

    function test_aPriceLimitThatStopsTheSwapEarlyIsRefused() public {
        address token = _graduated(100, false);
        PoolKey memory key = _key(token);
        bool usdcIs0 = _usdcIs0(token);
        // An exact-in buy with a limit a hair from the current price cannot fill: the hook refuses rather than charge
        // fees on USDC the pool did not take.
        (uint160 sqrtP,,,) = _slot0(key);
        uint160 limit = usdcIs0 ? sqrtP - 1 : sqrtP + 1;
        vm.expectRevert();
        raw.swap(key, SwapParams({zeroForOne: usdcIs0, amountSpecified: -int256(10_000e6), sqrtPriceLimitX96: limit}));
    }

    // ─── Snipe windows ────────────────────────────────────────────────────────

    function test_curveSnipeFeeIsHeldAndLockedAtGraduation() public {
        // The creator's own first buy, in the launch transaction, pays no snipe fee.
        address token = _launch(0, creatorWallet, "", false, 100e6);
        assertEq(pad.pendingSnipe(token), 0, "first buy exempt");
        assertEq(pad.snipeBpsOf(token), 9000, "creation block: 90%");

        vm.prank(carol);
        (, uint256 spent) = pad.buy(token, 1_000e6, 0, carol, MAX);
        assertEq(spent, 1_000e6);
        assertEq(pad.pendingSnipe(token), _ceil(1_000e6 * 9000, 1e4), "90% held for the pool");

        _step(10);
        assertEq(pad.snipeBpsOf(token), 4500, "half way: 45%");
        _step(10);
        assertEq(pad.snipeBpsOf(token), 0, "window over");
        uint256 held = pad.pendingSnipe(token);
        _assertSolvent();

        vm.prank(bob);
        pad.buy(token, 1_000_000e6, 0, bob, MAX);
        assertEq(pad.pendingSnipe(token), 0, "handed to the hook");
        // Locked as a USDC-only bid below the price: all of it (to a unit or two) is in the PoolManager.
        assertLe(hook.lockHeld(token), 2, "locked, not held");
        assertApproxEqAbs(usdc.balanceOf(POOL_MANAGER), CURVE_RAISE + held, 4, "curve USDC + the bid");
        _assertHookClean(token);
        _assertSolvent();
    }

    function test_poolSnipeFeeFallsBlockByBlockAndIsLocked() public {
        address token = _launch(100, creatorWallet, "", false, 0);
        _step(pad.SNIPE_BLOCKS());
        vm.prank(bob);
        pad.buy(token, 1_000_000e6, 0, bob, MAX);
        assertEq(hook.snipeBpsOf(token), 9000, "graduation block: 90%");

        vm.prank(carol);
        router.buy(token, 1_000e6, 0, carol, MAX);
        uint256 held = hook.lockHeld(token);
        assertEq(held, _ceil(1_000e6 * 9000, 1e4), "90% held by the hook");

        _step(10);
        assertEq(hook.snipeBpsOf(token), 4500);
        _step(10);
        assertEq(hook.snipeBpsOf(token), 0);

        // Sells never pay it.
        vm.prank(bob);
        router.sell(token, 1_000_000e18, 0, bob, MAX);
        assertEq(hook.lockHeld(token), held, "sells pay no snipe fee");

        // The surcharge never left the PoolManager: the lock turns the hook's claims into liquidity.
        uint256 pmUsdc = usdc.balanceOf(POOL_MANAGER);
        uint256 claims = _hookClaims();
        vm.prank(dave);
        uint128 liquidity = hook.lock(token);
        assertGt(liquidity, 0, "locked as liquidity");
        assertLe(hook.lockHeld(token), 2);
        assertApproxEqAbs(claims - _hookClaims(), held, 2, "claims into the pool");
        assertEq(usdc.balanceOf(POOL_MANAGER), pmUsdc, "no USDC moved");
        _assertHookClean(token);
        _assertSolvent();
    }

    // ─── Open and closed pools ────────────────────────────────────────────────

    function test_aClosedPoolRefusesOutsideLiquidity() public {
        address token = _graduated(0, false);
        vm.prank(bob);
        IERC20(token).transfer(address(raw), 10_000_000e18);
        PoolKey memory key = _key(token);
        vm.expectRevert();
        raw.addLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(200),
                tickUpper: TickMath.maxUsableTick(200),
                liquidityDelta: 1e12,
                salt: 0
            })
        );
    }

    function test_anOpenPoolTakesOutsideLiquidity() public {
        address token = _graduated(0, true);
        vm.prank(bob);
        IERC20(token).transfer(address(raw), 10_000_000e18);
        PoolKey memory key = _key(token);
        raw.addLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(200),
                tickUpper: TickMath.maxUsableTick(200),
                liquidityDelta: 1e12,
                salt: 0
            })
        );
        // and a trade still pays the fees
        uint256 pf0 = pad.pendingFees();
        vm.prank(carol);
        router.buy(token, 100e6, 0, carol, MAX);
        _sync(token);
        assertEq(pad.pendingFees() - pf0, _ceil(100e6 * 50, 1e4));
    }

    // ─── Pool fees: held as claims, released to the launchpad ─────────────────

    function test_collectingCreatorFeesReleasesThePoolsFirst() public {
        address token = _graduated(500, false);
        uint256 curveFees = pad.pendingCreatorFees(token); // from the curve
        vm.prank(carol);
        router.buy(token, 10_000e6, 0, carol, MAX);
        uint256 poolFees = hook.pendingCreator(token);
        assertEq(poolFees, _ceil(10_000e6 * 500, 1e4));

        uint256 before = usdc.balanceOf(creatorWallet);
        uint256 paid = pad.collectCreatorFees(token); // anyone may call it
        assertEq(paid, curveFees + poolFees, "curve and pool fees together");
        assertEq(usdc.balanceOf(creatorWallet) - before, paid);
        assertEq(hook.pendingCreator(token), 0);
        // The platform's share was booked on the way.
        assertEq(hook.pendingPlatform(token), 0);
        pad.collectFees();
        assertEq(pad.pendingFees(), 0);
        _assertHookClean(token);
        _assertSolvent();
    }

    function test_syncIsPermissionlessAndOnlyTheLaunchpadReleases() public {
        address a = _graduated(100, false);
        address b = _graduated(200, true);
        address live = _launch(0, creatorWallet, "", false, 0);
        vm.startPrank(carol);
        router.buy(a, 1_000e6, 0, carol, MAX);
        router.buy(b, 2_000e6, 0, carol, MAX);
        vm.stopPrank();

        vm.prank(carol);
        vm.expectRevert(IArchitexLaunchHook.OnlyLaunchpad.selector);
        hook.release(a);
        vm.prank(address(hook));
        vm.expectRevert(IArchitexLaunchpadV14.Forbidden.selector);
        pad.accrueTradeFees(a, 1, 1); // the v1.3 push path is gone

        (uint256 p, uint256 c) = pad.syncPoolFees(live);
        assertEq(p + c, 0, "nothing for a live curve");

        uint256 pf0 = pad.pendingFees();
        address[] memory both = new address[](2);
        (both[0], both[1]) = (a, b);
        vm.prank(dave);
        pad.syncPoolFeesBatch(both);
        assertEq(pad.pendingFees() - pf0, _ceil(1_000e6 * 50, 1e4) + _ceil(2_000e6 * 50, 1e4));
        (p, c) = pad.syncPoolFees(a);
        assertEq(p + c, 0, "released once");
        _assertHookClean(a);
        _assertSolvent();
    }

    // ─── Bids ─────────────────────────────────────────────────────────────────

    function test_nobodyCanDonate() public {
        address token = _graduated(0, true);
        vm.prank(bob);
        IERC20(token).transfer(address(raw), 1e18);
        bool usdcIs0 = _usdcIs0(token);
        PoolKey memory key = _key(token);
        vm.expectRevert();
        raw.donate(key, usdcIs0 ? 0 : 1e18, usdcIs0 ? 1e18 : 0);
        vm.expectRevert();
        raw.donate(key, usdcIs0 ? 1e6 : 0, usdcIs0 ? 0 : 1e6);
    }

    function test_everyBidIsItsOwnPositionAnchoredToTheGraduationPrice() public {
        address token = _launch(0, creatorWallet, "", false, 0);
        _step(pad.SNIPE_BLOCKS());
        vm.prank(bob);
        pad.buy(token, 1_000_000e6, 0, bob, MAX);
        (, IArchitexLaunchHook.Launch memory l) = hook.launchOf(token);
        (int24 lower, int24 upper) = _expectedBid(l);

        vm.prank(carol);
        router.buy(token, 2_000e6, 0, carol, MAX); // opening block: 90% held
        vm.recordLogs();
        hook.lock(token);
        _assertBid(vm.getRecordedLogs(), token, 1, lower, upper);

        _step(5);
        vm.prank(carol);
        router.buy(token, 2_000e6, 0, carol, MAX); // still in the window
        vm.recordLogs();
        hook.lock(token);
        _assertBid(vm.getRecordedLogs(), token, 2, lower, upper);
        assertEq(hook.bidCount(token), 2, "two bids, two positions");
        _assertHookClean(token);
    }

    function test_aBidWaitsWhileThePriceIsBelowItsTop() public {
        address token = _launch(0, creatorWallet, "", false, 0);
        _step(pad.SNIPE_BLOCKS());
        vm.prank(bob);
        pad.buy(token, 1_000_000e6, 0, bob, MAX);
        vm.prank(carol);
        router.buy(token, 3_000e6, 0, carol, MAX);
        uint256 held = hook.lockHeld(token);
        assertGt(held, 0);

        // A dump takes the price under half the graduation price: the bid's range would not be USDC only.
        uint256 dumped = 150_000_000e18;
        vm.prank(bob);
        uint256 got = router.sell(token, dumped, 0, bob, MAX);
        assertEq(hook.lock(token), 0, "nothing locked");
        assertEq(hook.lockHeld(token), held, "the claims wait");
        assertEq(hook.bidCount(token), 0);

        // Back above it (after the window, so the buy-back pays no surcharge), the bid goes in.
        _step(hook.SNIPE_BLOCKS());
        vm.prank(bob);
        router.buy(token, got * 2, 0, bob, MAX);
        assertGt(hook.lock(token), 0, "locked");
        assertLe(hook.lockHeld(token), 2);
        _assertHookClean(token);
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    /// @dev The hook's bid range for a launch, recomputed from V14-SPEC §5: its top about half the graduation price,
    ///      BID_SPAN_TICKS deep.
    function _expectedBid(IArchitexLaunchHook.Launch memory l) internal view returns (int24 lower, int24 upper) {
        int24 d = hook.BID_DISCOUNT_TICKS();
        int24 span = hook.BID_SPAN_TICKS();
        if (l.usdcIs0) {
            int256 t = int256(l.graduationTick) + d + 1;
            int256 c = t / 200;
            if (t > 0 && t % 200 != 0) c++;
            lower = int24(c * 200);
            upper = lower + span;
        } else {
            int256 t = int256(l.graduationTick) - d;
            int256 c = t / 200;
            if (t < 0 && t % 200 != 0) c--;
            upper = int24(c * 200);
            lower = upper - span;
        }
    }

    function _assertBid(Vm.Log[] memory logs, address token, uint256 salt, int24 lower, int24 upper) internal view {
        bytes32 sig = keccak256("BidLocked(address,uint256,uint128,int24,int24)");
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != sig || address(uint160(uint256(logs[i].topics[1]))) != token) continue;
            (,, int24 lo, int24 hi) = abi.decode(logs[i].data, (uint256, uint128, int24, int24));
            assertEq(lo, lower, "bid lower tick");
            assertEq(hi, upper, "bid upper tick");
            found = true;
        }
        assertTrue(found, "a bid was locked");
        assertEq(hook.bidCount(token), salt, "fresh salt");
    }

    function _slot0(PoolKey memory key) internal view returns (uint160 sqrtP, int24 tick, uint24 a, uint24 b) {
        bytes32 data = manager.extsload(keccak256(abi.encodePacked(PoolId.unwrap(key.toId()), bytes32(uint256(6)))));
        assembly ("memory-safe") {
            sqrtP := and(data, 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF)
            tick := signextend(2, shr(160, data))
        }
        (a, b) = (0, 0);
    }
}

/// @notice USDC sorts below every launch token: it is currency0.
contract LaunchpadV14UsdcLowTest is LaunchpadV14Test {
    function _usdcAt() internal pure override returns (address) {
        return address(0x0000000000000000000000000000000000001000);
    }
}

/// @notice USDC sorts above every launch token: it is currency1.
contract LaunchpadV14UsdcHighTest is LaunchpadV14Test {
    function _usdcAt() internal pure override returns (address) {
        return address(uint160(type(uint160).max - 0xfff));
    }
}
