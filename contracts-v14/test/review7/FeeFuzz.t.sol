// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {ReviewBase} from "./ReviewBase.sol";

/// @notice Claude review #7 (holds), on the claims design: every kind of swap, both sort orders, any creator fee, any
///         block of the window, with no USDC in the PoolManager beyond the pool's own. For each swap: only the trader's
///         USDC moves (in on a buy, out on a sell), the fees become exactly that much of the hook's claims, the platform,
///         creator and snipe fees are each at least their rate of the trader's gross USDC (to a unit), sells never pay
///         the surcharge, and after a sync the launchpad's USDC equals its books and the hook's claims what it owes.
abstract contract FeeFuzzTest is ReviewBase {
    struct Snap {
        uint256 traderUsdc;
        uint256 traderTokens;
        uint256 pmUsdc;
        uint256 claims;
        uint256 pf;
        uint256 cf;
        uint256 held;
    }

    function _snap(address token) internal view returns (Snap memory s) {
        s.traderUsdc = usdc.balanceOf(address(raw));
        s.traderTokens = IERC20(token).balanceOf(address(raw));
        s.pmUsdc = usdc.balanceOf(POOL_MANAGER);
        s.claims = _hookClaims();
        s.pf = hook.pendingPlatform(token);
        s.cf = hook.pendingCreator(token);
        s.held = hook.lockHeld(token);
    }

    function testFuzz_everySwapPaysItsFees(uint16 cfee, uint8 kind, uint256 amount, uint8 blocksIn) public {
        cfee = uint16(bound(cfee, 0, 1000));
        kind = uint8(bound(kind, 0, 3));
        address token = _launch(cfee, creatorWallet, "", false, 0);
        _step(pad.SNIPE_BLOCKS());
        vm.prank(bob);
        pad.buy(token, 1_000_000e6, 0, bob, MAX);
        vm.prank(bob);
        IERC20(token).transfer(address(raw), 700_000_000e18);
        vm.roll(block.number + bound(blocksIn, 0, 25));

        bool usdcIs0 = _usdcIs0(token);
        uint256 snipeBps = hook.snipeBpsOf(token);
        SwapParams memory p;
        bool isBuy = kind < 2;
        if (kind == 0) {
            amount = bound(amount, 300, 500_000e6); // exact-in buy: USDC in
            p = SwapParams(
                usdcIs0, -int256(amount), usdcIs0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            );
        } else if (kind == 1) {
            amount = bound(amount, 1e12, 150_000_000e18); // exact-out buy: tokens out
            p = SwapParams(usdcIs0, int256(amount), usdcIs0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1);
        } else if (kind == 2) {
            amount = bound(amount, 1e20, 600_000_000e18); // exact-in sell: tokens in
            p = SwapParams(
                !usdcIs0, -int256(amount), !usdcIs0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            );
        } else {
            amount = bound(amount, 1, 10_000e6); // exact-out sell: USDC out
            p = SwapParams(
                !usdcIs0, int256(amount), !usdcIs0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            );
        }

        Snap memory a = _snap(token);
        raw.swap(_key(token), p);
        Snap memory b = _snap(token);

        uint256 pf = b.pf - a.pf;
        uint256 cf = b.cf - a.cf;
        uint256 sf = b.held - a.held;
        if (isBuy) {
            uint256 paid = a.traderUsdc - b.traderUsdc;
            assertEq(b.pmUsdc - a.pmUsdc, paid, "all the trader paid is in the PoolManager");
            assertEq(b.claims - a.claims, pf + cf + sf, "the fees are the hook's claims");
            assertGt(b.traderTokens, a.traderTokens, "tokens received");
            assertGe(pf * 1e4, paid * 50, "platform fee >= 0.5% of gross");
            assertGe((cf + 1) * 1e4, paid * cfee, "creator fee >= its rate of gross (to a unit)");
            // The total is exact; the split rounds platform and creator up first, so the snipe share is exact to 2 units.
            assertGe(pf + cf + sf, (paid * (50 + cfee + snipeBps) + 9_999) / 1e4, "total fee >= total rate of gross");
            assertGe((sf + 2) * 1e4, paid * snipeBps, "snipe fee >= its rate of gross (to 2 units)");
            if (kind == 1) assertEq(b.traderTokens - a.traderTokens, amount, "exact out");
            else assertEq(paid, amount, "exact in");
        } else {
            uint256 got = b.traderUsdc - a.traderUsdc;
            assertEq(a.pmUsdc - b.pmUsdc, got, "only the trader's USDC left the PoolManager");
            assertEq(b.claims - a.claims, pf + cf, "the fees are the hook's claims");
            uint256 gross = got + pf + cf; // what the pool paid out
            assertEq(sf, 0, "sells pay no surcharge");
            assertGe(pf * 1e4, gross * 50, "platform fee >= 0.5% of gross");
            assertGe((cf + 1) * 1e4, gross * cfee, "creator fee >= its rate of gross (to a unit)");
            if (kind == 3) assertEq(got, amount, "exact out");
            else assertEq(a.traderTokens - b.traderTokens, amount, "exact in");
        }
        _assertHookClean(token);
        _sync(token);
        _assertSolvent();
        _assertHookClean(token);
    }

    /// @dev After the window, no sequence of buys and sells returns more USDC than it paid (fees on both legs).
    function testFuzz_roundTripsNeverProfit(uint256 usdcIn, uint8 split) public {
        address token = _graduated(0, false);
        usdcIn = bound(usdcIn, 10e6, 200_000e6);
        uint256 parts = bound(split, 1, 5);
        uint256 u0 = usdc.balanceOf(carol);
        vm.startPrank(carol);
        uint256 got;
        for (uint256 i; i < parts; ++i) {
            got += router.buy(token, usdcIn / parts, 0, carol, MAX);
        }
        for (uint256 i; i < parts; ++i) {
            router.sell(token, i + 1 == parts ? IERC20(token).balanceOf(carol) : got / parts, 0, carol, MAX);
        }
        vm.stopPrank();
        assertLt(usdc.balanceOf(carol), u0, "a round trip costs");
    }
}

contract FeeFuzzUsdcLowTest is FeeFuzzTest {
    function _usdcAt() internal pure override returns (address) {
        return address(0x0000000000000000000000000000000000001000);
    }
}

contract FeeFuzzUsdcHighTest is FeeFuzzTest {
    function _usdcAt() internal pure override returns (address) {
        return address(uint160(type(uint160).max - 0xfff));
    }
}
