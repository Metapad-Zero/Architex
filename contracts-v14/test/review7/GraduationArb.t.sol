// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {ReviewBase} from "./ReviewBase.sol";

/// @notice Claude review #7 (holds): the pool opens at the curve's final price (to about 1e-9), and buying the curve's last X
///         tokens then dumping them straight into the new pool loses at every size (the pool is shallower than the
///         curve's end, and sells pay the fees), so the sell-out buy cannot be arbitraged against the opening pool.
abstract contract GraduationArbTest is ReviewBase {
    /// @dev USDC per token, 1e18-scaled, from the pool's sqrtPrice.
    function _poolPrice(address token) internal view returns (uint256) {
        (uint160 sqrtP,) = _slot0(token);
        uint256 p = FullMath.mulDiv(uint256(sqrtP), uint256(sqrtP), 1 << 96); // currency1 per currency0, X96
        // spotPrice is USDC(6dp) per whole token scaled 1e18, i.e. usdcUnits * 1e36 / tokenWei.
        return _usdcIs0(token)
            ? FullMath.mulDiv(1 << 96, 1e36, p)  // tokens per USDC -> invert
            : FullMath.mulDiv(p, 1e36, 1 << 96);
    }

    function test_poolOpensAtTheCurvesFinalPrice() public {
        address token = _graduated(0, false);
        uint256 curve = pad.spotPrice(token);
        uint256 pool = _poolPrice(token);
        console2.log("curve final price (1e18)", curve);
        console2.log("pool opening price (1e18)", pool);
        assertApproxEqRel(pool, curve, 1e10, "within 1e-8");
    }

    function test_lastCurveBuyThenPoolDumpNeverPays() public {
        uint256[4] memory sizes = [uint256(1_000_000e18), 20_000_000e18, 100_000_000e18, 400_000_000e18];
        for (uint256 i; i < sizes.length; ++i) {
            uint256 snap = vm.snapshotState();
            address token = _launch(0, creatorWallet, "", false, 0);
            _step(pad.SNIPE_BLOCKS());
            // Everyone else buys the curve up to `sizes[i]` short of the end.
            uint256 cost = _costFor(token, 800_000_000e18 - sizes[i]);
            vm.prank(carol);
            pad.buy(token, cost, 0, carol, MAX);
            uint256 remaining = 800_000_000e18 - pad.curves(token).tokensSold;
            // The arbitrageur takes the rest (graduating) and dumps it into the new pool in the same block.
            uint256 u0 = usdc.balanceOf(dave);
            vm.startPrank(dave);
            (uint256 got,) = pad.buy(token, 1_000_000e6, 0, dave, MAX);
            assertTrue(pad.isGraduated(token));
            router.sell(token, got, 0, dave, MAX);
            vm.stopPrank();
            uint256 u1 = usdc.balanceOf(dave);
            console2.log("tokens bought at the end of the curve (whole)", remaining / 1e18);
            console2.log("  arbitrage loss (6dp)", u0 - u1);
            assertLt(u1, u0, "no profit");
            vm.revertToState(snap);
        }
    }

    /// @dev Gross USDC that buys about `tokens` from a fresh curve (fees included), via the launchpad's own quote.
    function _costFor(address token, uint256 tokens) internal view returns (uint256 usdcIn) {
        uint256 lo = 1e6;
        uint256 hi = 200_000e6;
        for (uint256 k; k < 60; ++k) {
            uint256 mid = (lo + hi) / 2;
            (uint256 out,,,,, bool grads) = pad.quoteBuy(token, mid);
            if (grads || out > tokens) hi = mid;
            else lo = mid;
        }
        usdcIn = lo;
    }
}

contract GraduationArbUsdcLowTest is GraduationArbTest {
    function _usdcAt() internal pure override returns (address) {
        return address(0x0000000000000000000000000000000000001000);
    }
}

contract GraduationArbUsdcHighTest is GraduationArbTest {
    function _usdcAt() internal pure override returns (address) {
        return address(uint160(type(uint160).max - 0xfff));
    }
}
