// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {ArchitexLaunchpadV14} from "../../src/ArchitexLaunchpadV14.sol";
import {ArchitexLaunchHook} from "../../src/ArchitexLaunchHook.sol";
import {ArchitexV4Router} from "../../src/ArchitexV4Router.sol";
import {RawSwapper} from "../V14Base.sol";
import {MockUSDC} from "../utils/MockUSDC.sol";
import {ReviewBase, Flash} from "./ReviewBase.sol";

/// @dev Claude review #7's invariant run, on the claims design with bids placed inside window buys. Random curve
///      trades, graduations, every kind of pool swap (raw and through the router), block rolls, donation attempts,
///      outside liquidity in the open pool (and attempts on the closed one), syncs and fee collections, with no USDC in
///      the PoolManager beyond the pools'.
contract Review7Handler is Test {
    using PoolIdLibrary for PoolKey;

    ArchitexLaunchpadV14 internal pad;
    ArchitexLaunchHook internal hook;
    ArchitexV4Router internal router;
    MockUSDC internal usdc;
    IPoolManager internal manager;
    RawSwapper internal raw;
    Flash internal flash;
    address[2] internal tokens; // [closed, open]
    address[3] internal actors;
    uint128[2] public fullRangeL;
    uint256 public closedAddSucceeded;
    uint256 public donations;
    uint256 public swaps;
    uint256 public swapFails;
    bytes public lastFail;

    constructor(
        ArchitexLaunchpadV14 pad_,
        ArchitexLaunchHook hook_,
        ArchitexV4Router router_,
        MockUSDC usdc_,
        IPoolManager manager_,
        RawSwapper raw_,
        Flash flash_,
        address[2] memory tokens_,
        address[3] memory actors_
    ) {
        (pad, hook, router, usdc, manager, raw, flash) = (pad_, hook_, router_, usdc_, manager_, raw_, flash_);
        tokens = tokens_;
        actors = actors_;
        _note(0);
        _note(1);
    }

    function _usdcIs0(address t) internal view returns (bool) {
        return address(usdc) < t;
    }

    function _note(uint256 i) internal {
        if (fullRangeL[i] == 0 && pad.isGraduated(tokens[i])) {
            PoolKey memory key = hook.poolKeyOf(tokens[i]);
            bytes32 pos = keccak256(
                abi.encodePacked(address(hook), TickMath.minUsableTick(200), TickMath.maxUsableTick(200), bytes32(0))
            );
            fullRangeL[i] = StateLibrary.getPositionLiquidity(manager, key.toId(), pos);
        }
    }

    function curveBuy(uint256 ti, uint256 ai, uint256 amt) external {
        uint256 i = ti % 2;
        address t = tokens[i];
        if (pad.isGraduated(t)) return;
        address a = actors[ai % 3];
        amt = bound(amt, 1e6, 40_000e6);
        vm.prank(a);
        try pad.buy(t, amt, 0, a, type(uint256).max) {} catch {}
        _note(i);
    }

    function curveSell(uint256 ti, uint256 ai, uint256 frac) external {
        address t = tokens[ti % 2];
        if (pad.isGraduated(t)) return;
        address a = actors[ai % 3];
        uint256 bal = IERC20(t).balanceOf(a);
        uint256 amt = bal * bound(frac, 1, 100) / 100;
        if (amt == 0) return;
        vm.prank(a);
        try pad.sell(t, amt, 0, a, type(uint256).max) {} catch {}
    }

    function roll(uint256 n) external {
        n = bound(n, 1, 25);
        vm.roll(block.number + n);
        vm.warp(block.timestamp + n / 2 + 1);
    }

    function routerTrade(uint256 ti, uint256 ai, uint256 amt, bool isBuy) external {
        address t = tokens[ti % 2];
        if (!pad.isGraduated(t)) return;
        address a = actors[ai % 3];
        if (isBuy) {
            amt = bound(amt, 10, 20_000e6);
            vm.prank(a);
            try router.buy(t, amt, 0, a, type(uint256).max) {
                ++swaps;
            } catch {}
        } else {
            uint256 bal = IERC20(t).balanceOf(a);
            amt = bal * bound(amt, 1, 100) / 100;
            if (amt == 0) return;
            vm.prank(a);
            try router.sell(t, amt, 0, a, type(uint256).max) {
                ++swaps;
            } catch {}
        }
    }

    function rawSwap(uint256 ti, uint256 kind, uint256 amt) external {
        address t = tokens[ti % 2];
        if (!pad.isGraduated(t)) return;
        bool u0 = _usdcIs0(t);
        kind = kind % 4;
        SwapParams memory p;
        if (kind == 0) {
            p = SwapParams(
                u0, -int256(bound(amt, 300, 20_000e6)), u0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            );
        } else if (kind == 1) {
            p = SwapParams(
                u0,
                int256(bound(amt, 1e12, 20_000_000e18)),
                u0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            );
        } else {
            uint256 bal = IERC20(t).balanceOf(address(raw));
            if (bal < 1e21) return;
            if (kind == 2) {
                p = SwapParams(
                    !u0, -int256(bound(amt, 1e21, bal)), !u0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
                );
            } else {
                p = SwapParams(
                    !u0, int256(bound(amt, 1, 2_000e6)), !u0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
                );
            }
        }
        try raw.swap(hook.poolKeyOf(t), p) {
            ++swaps;
        } catch (bytes memory reason) {
            ++swapFails;
            lastFail = reason;
        }
    }

    function donate(uint256 ti, uint256 amt, bool usdcSide) external {
        address t = tokens[ti % 2];
        if (!pad.isGraduated(t)) return;
        Flash.Op[] memory ops = new Flash.Op[](1);
        ops[0].kind = Flash.Kind.Donate;
        amt = bound(amt, 1, usdcSide ? 10e6 : 1e21);
        bool token0 = !_usdcIs0(t);
        if (usdcSide == token0) ops[0].amount1 = amt;
        else ops[0].amount0 = amt;
        try flash.run(hook.poolKeyOf(t), ops) {
            ++donations;
        } catch {}
    }

    /// @dev Outside liquidity: added to (and removed from) the open pool; always refused by the closed one.
    function outsideLiquidity(uint256 ti, uint256 amt, bool remove) external {
        uint256 i = ti % 2;
        address t = tokens[i];
        if (!pad.isGraduated(t)) return;
        int24 lo = TickMath.minUsableTick(200);
        int24 hi = TickMath.maxUsableTick(200);
        int256 delta = int256(bound(amt, 1e9, 1e15));
        if (i == 0) {
            try raw.addLiquidity(hook.poolKeyOf(t), ModifyLiquidityParams(lo, hi, delta, bytes32(uint256(7)))) {
                ++closedAddSucceeded;
            } catch {}
            return;
        }
        if (remove) delta = -delta;
        try raw.addLiquidity(hook.poolKeyOf(t), ModifyLiquidityParams(lo, hi, delta, bytes32(uint256(7)))) {} catch {}
    }

    function sync(uint256 ti) external {
        pad.syncPoolFees(tokens[ti % 2]);
    }

    function collect(uint256 ti) external {
        pad.collectFees();
        pad.collectCreatorFees(tokens[ti % 2]);
    }
}

abstract contract V14InvariantTest is ReviewBase {
    using PoolIdLibrary for PoolKey;

    Review7Handler internal handler;
    address[2] internal toks;

    function setUp() public override {
        super.setUp();
        toks[0] = _launch(300, creatorWallet, "", false, 0);
        vm.prank(dave);
        pad.buy(toks[0], 3_000e6, 0, dave, MAX); // creation-block snipe: a bid exists from graduation
        vm.prank(bob);
        toks[1] = pad.createToken("Open", "OPN", "", 0, creatorWallet, "", true, 0, 0, MAX);
        _step(pad.SNIPE_BLOCKS());
        vm.prank(bob);
        pad.buy(toks[0], 1_000_000e6, 0, bob, MAX); // the closed token graduates now; the open one via the handler
        vm.startPrank(bob);
        IERC20(toks[0]).transfer(carol, 200_000_000e18);
        IERC20(toks[0]).transfer(address(raw), 200_000_000e18);
        IERC20(toks[0]).transfer(address(flash), 1_000_000e18);
        vm.stopPrank();
        usdc.mint(address(flash), 1_000_000e6);
        vm.prank(address(raw));
        IERC20(address(usdc)).approve(address(pad), MAX);
        handler = new Review7Handler(pad, hook, router, usdc, manager, raw, flash, toks, [carol, dave, address(raw)]);
        targetContract(address(handler));
    }

    uint256 internal graduatedRuns;
    uint256 internal swapTotal;

    /// @dev Coverage: how many runs graduated at least one token, and how many swaps happened.
    function afterInvariant() public {
        if (pad.isGraduated(toks[0]) || pad.isGraduated(toks[1])) ++graduatedRuns;
        swapTotal += handler.swaps();
        emit log_named_uint(
            "run: graduated tokens", (pad.isGraduated(toks[0]) ? 1 : 0) + (pad.isGraduated(toks[1]) ? 1 : 0)
        );
        emit log_named_uint("run: successful pool swaps", handler.swaps());
        emit log_named_uint("run: bids", hook.bidCount(toks[0]) + hook.bidCount(toks[1]));
        emit log_named_uint("run: raw swap failures", handler.swapFails());
        emit log_named_bytes("run: last raw swap failure", handler.lastFail());
    }

    function invariant_launchpadUsdcEqualsItsBooks() public view {
        _assertSolvent();
    }

    function invariant_hookClaimsAreExactlyWhatItOwes() public view {
        _assertHookClean(toks[0]);
        assertEq(IERC20(toks[1]).balanceOf(address(hook)), 0);
    }

    /// @dev The review's Medium, as an invariant: snipe fees never wait to be locked, and no donation lands.
    function invariant_nothingWaitsAndNobodyDonates() public view {
        assertLe(hook.lockHeld(toks[0]), 2, "snipe fees waiting");
        assertLe(hook.lockHeld(toks[1]), 2, "snipe fees waiting");
        assertEq(handler.donations(), 0, "a donation landed");
    }

    function invariant_lockedPositionsNeverShrinkAndClosedPoolsStayClosed() public view {
        for (uint256 i; i < 2; ++i) {
            uint128 recorded = handler.fullRangeL(i);
            if (recorded == 0) continue;
            bytes32 pos = keccak256(
                abi.encodePacked(address(hook), TickMath.minUsableTick(200), TickMath.maxUsableTick(200), bytes32(0))
            );
            assertEq(
                StateLibrary.getPositionLiquidity(manager, _key(toks[i]).toId(), pos), recorded, "full range fixed"
            );
        }
        assertEq(handler.closedAddSucceeded(), 0, "closed pool refused outside liquidity");
    }
}

contract V14InvariantUsdcLowTest is V14InvariantTest {
    function _usdcAt() internal pure override returns (address) {
        return address(0x0000000000000000000000000000000000001000);
    }
}

contract V14InvariantUsdcHighTest is V14InvariantTest {
    function _usdcAt() internal pure override returns (address) {
        return address(uint160(type(uint160).max - 0xfff));
    }
}
