// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReviewBase} from "./ReviewBase.sol";

/// @notice Claude review #7 L1 and Grok review #7's Medium (fixed). The hook used to pay its fees out of the
///         PoolManager's own USDC in afterSwap (take to the launchpad and to itself) before the trader had paid, since
///         routers settle after the swap. A buy whose fees exceeded the USDC the PoolManager happened to hold reverted,
///         and a USDC blocklist on the launchpad or the hook would have stopped every pool. Now the fees are the hook's
///         ERC-6909 claims (mint): no USDC moves during a swap, whatever the PoolManager holds.
abstract contract FeeFloatTest is ReviewBase {
    function test_bigOpeningBuyLandsThroughARouterThatPaysAfterTheSwap() public {
        address token = _graduateWithCurveSnipe(0, false, dave, 0); // graduation block: the 90% window
        uint256 float = usdc.balanceOf(POOL_MANAGER); // this pool's USDC only, as on a thin PoolManager
        uint256 usdcIn = 30_000e6;
        assertGt(_ceil(usdcIn * 9_050, 1e4), float, "the fees exceed every USDC the PoolManager holds");
        uint256 bids0 = hook.bidCount(token);

        vm.prank(carol);
        uint256 got = router.buy(token, usdcIn, 0, carol, MAX);

        assertGt(got, 0, "filled");
        assertEq(usdc.balanceOf(POOL_MANAGER), float + usdcIn, "the whole buy is in the PoolManager");
        assertEq(hook.bidCount(token), bids0 + 1, "the surcharge, a bid inside the buy");
        assertLe(hook.lockHeld(token), 2, "nothing waits");
        assertEq(hook.pendingPlatform(token), _ceil(usdcIn * 50, 1e4), "the platform fee, held as claims");
        _assertHookClean(token);
        _assertSolvent();
    }

    function test_afterTheWindowABigBuyNeedsNoFloat() public {
        address token = _launch(1000, creatorWallet, "", false, 0); // 10% creator fee
        _step(pad.SNIPE_BLOCKS());
        vm.prank(bob);
        pad.buy(token, 1_000_000e6, 0, bob, MAX);
        _step(hook.SNIPE_BLOCKS());
        uint256 float = usdc.balanceOf(POOL_MANAGER);
        uint256 usdcIn = (float * 1e4) / 1050 + 1_000e6; // 10.5% of it is above the float
        vm.prank(carol);
        router.buy(token, usdcIn, 0, carol, MAX);
        _sync(token);
        _assertHookClean(token);
        _assertSolvent();
    }
}

contract FeeFloatUsdcLowTest is FeeFloatTest {
    function _usdcAt() internal pure override returns (address) {
        return address(0x0000000000000000000000000000000000001000);
    }
}

contract FeeFloatUsdcHighTest is FeeFloatTest {
    function _usdcAt() internal pure override returns (address) {
        return address(uint160(type(uint160).max - 0xfff));
    }
}
