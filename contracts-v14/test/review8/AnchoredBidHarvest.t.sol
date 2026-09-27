// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Review8Base} from "./Review8Base.sol";
import {RawSwapper} from "../V14Base.sol";

/// @notice Claude review #8, Medium (fixed). With the bid anchored to the graduation price, opening-window claims
///         waited after a crash, and anyone could push the price just past the bid's top, call lock() to place them
///         above the market, and sell back into them: +1,480 USDC at a quarter of graduation, +5,406 at a tenth (of
///         18,000 waiting), +3,683 for an attacker holding only USDC.
///         Now each snipe fee becomes a bid inside the buy that pays it, so after the window nothing waits to be
///         placed. The review's exact scenarios are rerun here: after the same crash, the same push and sell-back (there
///         is no lock() to call in between) only ever costs the attacker the pool fees.
abstract contract AnchoredBidHarvestTest is Review8Base {
    struct Book {
        uint256 usdc;
        uint256 tokens;
    }

    function _book(address token) internal view returns (Book memory b) {
        b.usdc = usdc.balanceOf(address(raw));
        b.tokens = IERC20(token).balanceOf(address(raw));
    }

    /// @dev USDC (6dp) value of `tokens` at pool price `sqrtP`.
    function _value(address token, uint256 tokens, uint160 sqrtP) internal view returns (uint256) {
        uint256 p = FullMath.mulDiv(sqrtP, sqrtP, 1 << 96); // currency1 per currency0, X96
        return _usdcIs0(token) ? FullMath.mulDiv(tokens, 1 << 96, p) : FullMath.mulDiv(tokens, p, 1 << 96);
    }

    /// @dev The review's round trip: push the price just past the graduation bid's top (an exact-out buy with a price
    ///      limit), then sell back to exactly `sqrtP0`. Returns the seller's result valued at `sqrtP0`.
    function _roundTrip(address token, uint160 sqrtP0) internal returns (int256 pnl) {
        bool u0 = _usdcIs0(token);
        int24 top = _bidTop(token);
        Book memory a = _book(token);
        uint256 bids = hook.bidCount(token);
        raw.swap(
            _key(token),
            SwapParams({
                zeroForOne: u0,
                amountSpecified: int256(800_000_000e18),
                sqrtPriceLimitX96: TickMath.getSqrtPriceAtTick(u0 ? top - 200 : top + 200)
            })
        );
        assertEq(hook.bidCount(token), bids, "a buy after the window places nothing");
        assertLe(hook.lockHeld(token), 2, "and there is nothing waiting to place");
        raw.swap(
            _key(token),
            SwapParams({zeroForOne: !u0, amountSpecified: -int256(800_000_000e18), sqrtPriceLimitX96: sqrtP0})
        );
        (uint160 sqrtP,) = _slot0(token);
        assertEq(sqrtP, sqrtP0, "back to the market price");
        Book memory b = _book(token);
        pnl = int256(b.usdc) - int256(a.usdc) + int256(_value(token, b.tokens, sqrtP0))
            - int256(_value(token, a.tokens, sqrtP0));
    }

    function _run(uint16 creatorFeeBps, uint256 windowBuys, int24 crashTicks) internal {
        address token = _graduateWithCurveSnipe(creatorFeeBps, false, dave, 0); // no graduation bid: pool snipes only
        uint256 bids0 = hook.bidCount(token);
        vm.prank(carol);
        router.buy(token, windowBuys, 0, carol, MAX); // snipers in the opening block: their 90% becomes a bid at once
        assertEq(hook.bidCount(token), bids0 + 1, "placed inside the buy");
        assertLe(hook.lockHeld(token), 2, "nothing waits");
        _step(hook.SNIPE_BLOCKS());

        // The market falls far under half the graduation price (a dump through the bid, which buys on the way down).
        uint256 bobBag = IERC20(token).balanceOf(bob);
        uint256 carolBag = IERC20(token).balanceOf(carol);
        vm.prank(bob);
        IERC20(token).transfer(address(raw), bobBag);
        vm.prank(carol);
        IERC20(token).transfer(address(raw), carolBag);
        int24 top = _bidTop(token);
        _sellTo(token, _usdcIs0(token) ? top + crashTicks : top - crashTicks);
        (uint160 sqrtP0,) = _slot0(token);

        int256 pnl = _roundTrip(token, sqrtP0);
        console2.log("creator fee bps", creatorFeeBps);
        console2.log("  market under the old anchored top by ticks", uint256(int256(crashTicks)));
        console2.log("  the review's round trip, P&L (6dp, negative = cost)");
        console2.logInt(pnl);
        assertLt(pnl, 0, "only the pool fees");
        _assertHookClean(token);
        _assertSolvent();
    }

    /// @dev Market at a quarter of the graduation price, 20,000 USDC of opening-window buys.
    function test_noHarvestAtAQuarterOfGraduation() public {
        _run(0, 20_000e6, 6_932);
    }

    /// @dev Market at a tenth of the graduation price.
    function test_noHarvestAtATenthOfGraduation() public {
        _run(0, 20_000e6, 16_095);
    }

    /// @dev The same with the highest creator fee (10%).
    function test_noHarvestWithATenPercentCreatorFee() public {
        _run(1000, 20_000e6, 16_095);
    }

    /// @dev An attacker holding only USDC buys the push and sells back exactly what he bought: he ends with less.
    function test_noHarvestWithNoTokensToStart() public {
        address token = _graduateWithCurveSnipe(0, false, dave, 0);
        vm.prank(carol);
        router.buy(token, 20_000e6, 0, carol, MAX);
        _step(hook.SNIPE_BLOCKS());
        uint256 bobBag = IERC20(token).balanceOf(bob);
        vm.prank(bob);
        IERC20(token).transfer(address(raw), bobBag);
        int24 top = _bidTop(token);
        bool u0 = _usdcIs0(token);
        _sellTo(token, u0 ? top + 16_095 : top - 16_095); // the market falls to a tenth of the graduation price

        RawSwapper attacker = new RawSwapper(manager);
        usdc.mint(address(attacker), 20_000e6);
        uint256 u0Bal = usdc.balanceOf(address(attacker));
        attacker.swap(
            _key(token),
            SwapParams({
                zeroForOne: u0,
                amountSpecified: int256(800_000_000e18),
                sqrtPriceLimitX96: TickMath.getSqrtPriceAtTick(u0 ? top - 200 : top + 200)
            })
        );
        uint256 bag = IERC20(token).balanceOf(address(attacker));
        attacker.swap(
            _key(token),
            SwapParams({
                zeroForOne: !u0,
                amountSpecified: -int256(bag),
                sqrtPriceLimitX96: !u0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            })
        );
        assertEq(IERC20(token).balanceOf(address(attacker)), 0, "no tokens kept");
        int256 pnl = int256(usdc.balanceOf(address(attacker))) - int256(u0Bal);
        console2.log("USDC-only attacker, round trip (6dp)");
        console2.logInt(pnl);
        assertLt(pnl, 0, "a loss");
        _assertHookClean(token);
        _assertSolvent();
    }

    /// @dev Inside the window the harvest would need the attacker's own buys, which pay the surcharge: pump with one
    ///      buy, buy again so a bid lands from the pumped price, dump everything. He loses most of what he put in.
    function test_aPumpInsideTheWindowCostsTheSurcharge() public {
        address token = _graduateWithCurveSnipe(0, false, dave, 0); // the opening block: 90%
        RawSwapper attacker = new RawSwapper(manager);
        usdc.mint(address(attacker), 100_000e6);
        uint256 u0Bal = usdc.balanceOf(address(attacker));
        bool u0 = _usdcIs0(token);
        SwapParams memory buy = SwapParams({
            zeroForOne: u0,
            amountSpecified: -int256(40_000e6),
            sqrtPriceLimitX96: u0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
        });
        attacker.swap(_key(token), buy); // the pump
        buy.amountSpecified = -int256(10_000e6);
        attacker.swap(_key(token), buy); // its bid lands from the pumped price
        uint256 bag = IERC20(token).balanceOf(address(attacker));
        attacker.swap(
            _key(token),
            SwapParams({
                zeroForOne: !u0,
                amountSpecified: -int256(bag),
                sqrtPriceLimitX96: !u0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            })
        );
        uint256 back = usdc.balanceOf(address(attacker)) - (u0Bal - 50_000e6);
        console2.log("put in 50,000 USDC inside the window, got back (whole USDC)", back / 1e6);
        assertLt(back, 25_000e6, "the surcharge is lost");
        _assertHookClean(token);
        _assertSolvent();
    }
}

contract AnchoredBidHarvestUsdcLowTest is AnchoredBidHarvestTest {
    function _usdcAt() internal pure override returns (address) {
        return address(0x0000000000000000000000000000000000001000);
    }
}

contract AnchoredBidHarvestUsdcHighTest is AnchoredBidHarvestTest {
    function _usdcAt() internal pure override returns (address) {
        return address(uint160(type(uint160).max - 0xfff));
    }
}
