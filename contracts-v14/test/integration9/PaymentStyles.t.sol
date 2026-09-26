// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IV4Router} from "@uniswap/v4-periphery/src/interfaces/IV4Router.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {ActionConstants} from "@uniswap/v4-periphery/src/libraries/ActionConstants.sol";
import {Integration9Base} from "./Integration9Base.sol";

/// @notice Integration review #9, check 3 (regression tests since 39a78b4): the ways routers pay and get paid, around a
///         window buy whose afterSwap mints fee claims, adds a position and burns claims. Settling before the swap
///         (V4Router SETTLE, then an OPEN_DELTA swap), after it, from the router's own balance, taking before settling,
///         a sync made before the swap with the settle after it, and ERC-6909 claims used as a swap's input and output.
///         Each fill must match the V4Quoter's quote in the same block, and the hook's books must hold.
abstract contract PaymentStylesTest is Integration9Base {
    uint256 internal constant BUY = 3_000e6;

    function _buyParams(address token, uint256 amountIn)
        internal
        view
        returns (IV4Router.ExactInputSingleParams memory)
    {
        return IV4Router.ExactInputSingleParams({
            poolKey: _key(token),
            zeroForOne: _usdcIs0(token),
            amountIn: uint128(amountIn),
            amountOutMinimum: 0,
            hookData: ""
        });
    }

    function _run(address trader, address token, uint256[] memory actions, bytes[] memory params)
        internal
        returns (uint256 paid, uint256 got)
    {
        uint256 bids0 = hook.bidCount(token);
        (paid, got) = _exec(trader, _plan(actions, params), _c(address(usdc)), _c(token));
        assertEq(hook.bidCount(token), bids0 + 1, "the window buy placed its bid");
        assertLe(hook.lockHeld(token), 2, "nothing waits");
    }

    /// @dev SETTLE (payer is the user) first, then the swap spends the open credit (amountIn = OPEN_DELTA), then
    ///      TAKE_ALL.
    function test_settleBeforeTheSwap() public {
        address token = _graduatedInWindow(200, false, 1_000e6);
        (uint256 q,) = _quoteBuyIn(token, BUY);
        uint256[] memory actions = new uint256[](3);
        bytes[] memory params = new bytes[](3);
        (actions[0], params[0]) = (Actions.SETTLE, abi.encode(_c(address(usdc)), BUY, true));
        (actions[1], params[1]) =
        (Actions.SWAP_EXACT_IN_SINGLE, abi.encode(_buyParams(token, ActionConstants.OPEN_DELTA)));
        (actions[2], params[2]) = (Actions.TAKE_ALL, abi.encode(_c(token), q));
        (uint256 paid, uint256 got) = _run(carol, token, actions, params);
        assertEq(paid, BUY);
        assertEq(got, q, "settle-first fill == quote");
        _assertHookClean(token);
        _assertSolvent();
    }

    /// @dev Exact out, paid up front: SETTLE the maximum first, swap exact out, TAKE_ALL the tokens, then TAKE_ALL the
    ///      USDC credit left over (the refund). The hook mints and burns USDC claims while the router holds an open
    ///      USDC credit.
    function test_prepayTheMaximumThenRefundTheExcessExactOut() public {
        address token = _graduatedInWindow(200, false, 1_000e6);
        uint256 want = 2_000_000e18;
        (uint256 qIn,) = _quoteBuyOut(token, want);
        uint256 maxIn = qIn * 2;
        uint256[] memory actions = new uint256[](4);
        bytes[] memory params = new bytes[](4);
        (actions[0], params[0]) = (Actions.SETTLE, abi.encode(_c(address(usdc)), maxIn, true));
        (actions[1], params[1]) =
        (
            Actions.SWAP_EXACT_OUT_SINGLE,
            abi.encode(
                IV4Router.ExactOutputSingleParams({
                    poolKey: _key(token),
                    zeroForOne: _usdcIs0(token),
                    amountOut: uint128(want),
                    amountInMaximum: uint128(maxIn),
                    hookData: ""
                })
            )
        );
        (actions[2], params[2]) = (Actions.TAKE_ALL, abi.encode(_c(token), want));
        (actions[3], params[3]) = (Actions.TAKE_ALL, abi.encode(_c(address(usdc)), 0));
        (uint256 paid, uint256 got) = _run(carol, token, actions, params);
        assertEq(got, want);
        assertEq(paid, qIn, "net of the refund, paid exactly the quote");
        _assertHookClean(token);
        _assertSolvent();
    }

    /// @dev The output is taken before the input is paid (flash accounting allows either order).
    function test_takeBeforeSettle() public {
        address token = _graduatedInWindow(200, false, 1_000e6);
        (uint256 q,) = _quoteBuyIn(token, BUY);
        uint256[] memory actions = new uint256[](3);
        bytes[] memory params = new bytes[](3);
        (actions[0], params[0]) = (Actions.SWAP_EXACT_IN_SINGLE, abi.encode(_buyParams(token, BUY)));
        (actions[1], params[1]) = (Actions.TAKE_ALL, abi.encode(_c(token), q));
        (actions[2], params[2]) = (Actions.SETTLE_ALL, abi.encode(_c(address(usdc)), BUY));
        (uint256 paid, uint256 got) = _run(carol, token, actions, params);
        assertEq(paid, BUY);
        assertEq(got, q, "take-first fill == quote");
        _assertHookClean(token);
    }

    /// @dev The router pays from its own balance (payerIsUser false, CONTRACT_BALANCE), as the Universal Router does
    ///      after another protocol's hop left the input with it.
    function test_routerPaysFromItsOwnBalance() public {
        address token = _graduatedInWindow(200, false, 1_000e6);
        (uint256 q,) = _quoteBuyIn(token, BUY);
        vm.prank(carol);
        usdc.transfer(address(v4r), BUY);
        uint256[] memory actions = new uint256[](3);
        bytes[] memory params = new bytes[](3);
        (actions[0], params[0]) =
        (Actions.SETTLE, abi.encode(_c(address(usdc)), ActionConstants.CONTRACT_BALANCE, false));
        (actions[1], params[1]) =
        (Actions.SWAP_EXACT_IN_SINGLE, abi.encode(_buyParams(token, ActionConstants.OPEN_DELTA)));
        (actions[2], params[2]) = (Actions.TAKE, abi.encode(_c(token), carol, ActionConstants.OPEN_DELTA));
        uint256 before = IERC20(token).balanceOf(carol);
        vm.prank(carol);
        v4r.executeActions(_plan(actions, params));
        assertEq(IERC20(token).balanceOf(carol) - before, q, "router-balance fill == quote");
        assertEq(usdc.balanceOf(address(v4r)), 0, "all of it spent");
        _assertHookClean(token);
    }

    /// @dev sync(USDC) before the swap and settle after it: the hook's mid-swap mint, liquidity add and burn move no
    ///      USDC, so the settle credits exactly what the trader transferred.
    function test_syncBeforeTheSwapAndSettleAfterIt() public {
        address token = _graduatedInWindow(200, false, 1_000e6);
        (uint256 q,) = _quoteBuyIn(token, BUY);
        bool u0 = _usdcIs0(token);
        uint256 usdc0 = usdc.balanceOf(erin);
        uint256 tok0 = IERC20(token).balanceOf(erin);
        uint256 bids0 = hook.bidCount(token);
        PoolKey memory key = _key(token); // before the prank: an external call would consume it
        vm.prank(erin);
        claimsRouter.syncEarlySwap(
            key, SwapParams(u0, -int256(BUY), u0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1)
        );
        assertEq(usdc0 - usdc.balanceOf(erin), BUY, "paid exactly the USDC in");
        assertEq(IERC20(token).balanceOf(erin) - tok0, q, "sync-early fill == quote");
        assertEq(hook.bidCount(token), bids0 + 1);
        _assertHookClean(token);
        _assertSolvent();
    }

    /// @dev ERC-6909 claims as input and output: the router deposits USDC as claims, then inside the window buys by
    ///      burning USDC claims and receives the tokens as claims (exact in, then exact out), sells token claims back
    ///      for USDC claims, and finally withdraws everything. The hook mints and burns claims of the same USDC id in
    ///      the same swaps.
    function test_claimsAsInputAndOutput() public {
        address token = _graduatedInWindow(200, false, 1_000e6);
        bool u0 = _usdcIs0(token);
        Currency cu = _c(address(usdc));
        Currency ct = _c(token);
        vm.prank(erin);
        claimsRouter.deposit(cu, 20_000e6);
        assertEq(claimsRouter.claims(cu), 20_000e6);

        // Exact-in buy, paid with claims, tokens received as claims.
        (uint256 q,) = _quoteBuyIn(token, BUY);
        uint256 bids0 = hook.bidCount(token);
        claimsRouter.swapWithClaims(
            _key(token), SwapParams(u0, -int256(BUY), u0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1)
        );
        assertEq(claimsRouter.claims(cu), 20_000e6 - BUY, "USDC claims burned for the input");
        assertEq(claimsRouter.claims(ct), q, "token claims == quote");
        assertEq(hook.bidCount(token), bids0 + 1, "bid placed");

        // Exact-out buy, paid with claims.
        (uint256 qIn,) = _quoteBuyOut(token, 1_000_000e18);
        claimsRouter.swapWithClaims(
            _key(token),
            SwapParams(u0, int256(1_000_000e18), u0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1)
        );
        assertEq(claimsRouter.claims(cu), 20_000e6 - BUY - qIn, "exact-out input burned from claims == quote");
        assertEq(claimsRouter.claims(ct), q + 1_000_000e18);
        assertEq(hook.bidCount(token), bids0 + 2, "bid placed");

        // Sell half the token claims for USDC claims.
        uint256 half = (q + 1_000_000e18) / 2;
        (uint256 qs,) = _quoteSellIn(token, half);
        claimsRouter.swapWithClaims(
            _key(token), SwapParams(!u0, -int256(half), !u0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1)
        );
        assertEq(claimsRouter.claims(cu), 20_000e6 - BUY - qIn + qs, "sale credited as USDC claims == quote");

        // Out again, as ERC-20s.
        uint256 cuLeft = claimsRouter.claims(cu);
        uint256 ctLeft = claimsRouter.claims(ct);
        claimsRouter.withdraw(cu, cuLeft, erin);
        claimsRouter.withdraw(ct, ctLeft, erin);
        assertEq(IERC20(token).balanceOf(erin), ctLeft);
        _assertHookClean(token);
        _assertSolvent();
    }
}

contract PaymentStylesUsdcLowTest is PaymentStylesTest {
    function _usdcAt() internal pure override returns (address) {
        return address(0x0000000000000000000000000000000000001000);
    }
}

contract PaymentStylesUsdcHighTest is PaymentStylesTest {
    function _usdcAt() internal pure override returns (address) {
        return address(uint160(type(uint160).max - 0xfff));
    }
}
