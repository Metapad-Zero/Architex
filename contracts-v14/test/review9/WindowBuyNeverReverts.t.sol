// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Review9Base} from "./Review9Base.sol";

/// @notice Claude review #9 (holds): the bid a window buy places can never make that buy revert, and its books hold.
///         Fuzzed on the real PoolManager over every creator fee, every block of the window, a prior dump of up to
///         700M tokens (the pool's price down about 20 times) and a prior buy of up to 2M USDC by someone else, then a
///         window buy of any size, exact in (from 0.001 USDC to 5M USDC) or exact out (any number of tokens, up to
///         95% of what the pool holds, and with a price limit that stops it part way). Every such buy succeeds and, if its
///         snipe fee is not 0, places exactly one bid, from the cheaper of its pre-swap tick and the graduation tick
///         (review #9's L1 fix), wholly on the USDC side of the price it leaves and never above half the graduation
///         price; the hook's claims stay exactly its books and nothing but a unit or two waits. (Unlike the invariant
///         handlers, nothing here swallows a revert.)
abstract contract WindowBuyNeverRevertsTest is Review9Base {
    struct In {
        uint16 cfee;
        uint256 blocksIn;
        uint256 preSell;
        uint256 preBuy;
        uint8 kind;
        uint256 amount;
        uint256 limitTicks;
    }

    function _run(In memory x) internal {
        x.cfee = uint16(bound(x.cfee, 0, 1000));
        address token = _graduateWithCurveSnipe(x.cfee, false, dave, 0);
        usdc.mint(address(raw), 1e9 * 1e6); // enough for any exact-out buy below
        _step(bound(x.blocksIn, 0, 19));
        bool u0 = _usdcIs0(token);

        x.preSell = bound(x.preSell, 0, 700_000_000e18);
        if (x.preSell >= 1e18) {
            vm.prank(bob);
            IERC20(token).transfer(address(raw), x.preSell);
            raw.swap(_key(token), _sellIn(token, x.preSell));
        }
        x.preBuy = bound(x.preBuy, 0, 2_000_000e6);
        if (x.preBuy >= 1_000) raw.swap(_key(token), _buyIn(token, x.preBuy));

        (, int24 pre) = _slot0(token);
        uint256 bids = hook.bidCount(token);
        vm.recordLogs();
        x.kind = x.kind % 3;
        if (x.kind == 0) {
            raw.swap(_key(token), _buyIn(token, bound(x.amount, 1_000, 5_000_000e6)));
        } else {
            uint256 poolTokens = IERC20(token).balanceOf(POOL_MANAGER);
            uint256 out = bound(x.amount, 1e12, poolTokens * 95 / 100);
            uint160 limit = u0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
            if (x.kind == 2) {
                int24 lt = u0
                    ? pre - int24(uint24(bound(x.limitTicks, 1, 50_000)))
                    : pre + int24(uint24(bound(x.limitTicks, 1, 50_000)));
                limit = TickMath.getSqrtPriceAtTick(lt);
            }
            raw.swap(_key(token), SwapParams(u0, int256(out), limit));
        }
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 snipe;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(hook) && logs[i].topics[0] == POOL_TRADE) {
                (,,,,, snipe) = abi.decode(logs[i].data, (bool, uint256, uint256, uint256, uint256, uint256));
            }
        }
        Bid[] memory placed = _bidsIn(logs, token);
        if (snipe == 0) {
            assertEq(placed.length, 0);
        } else {
            assertEq(placed.length, 1, "one bid");
            assertEq(hook.bidCount(token), bids + 1);
            (int24 lo, int24 hi) = _expectedRange(token, pre);
            assertEq(placed[0].lower, lo, "from the cheaper of the pre-swap and graduation ticks");
            assertEq(placed[0].upper, hi);
            (int24 gLo, int24 gHi) = _rangeFrom(u0, _gradTick(token));
            assertTrue(u0 ? lo >= gLo : hi <= gHi, "never above half the graduation price");
            (, int24 tickNow) = _slot0(token);
            assertTrue(u0 ? tickNow < lo : tickNow >= hi, "wholly on the USDC side");
        }
        assertLe(hook.lockHeld(token), 2, "nothing waits");
        _assertHookClean(token);
        _assertSolvent();
    }

    /// @dev CI runs the profile's default (256 runs per sort order). The review ran it deeper:
    ///      FOUNDRY_PROFILE=v14 FOUNDRY_FUZZ_RUNS=10000 forge test --match-contract WindowBuyNeverReverts
    function testFuzz_aWindowBuyNeverRevertsBecauseOfItsBid(
        uint16 cfee,
        uint256 blocksIn,
        uint256 preSell,
        uint256 preBuy,
        uint8 kind,
        uint256 amount,
        uint256 limitTicks
    ) public {
        _run(In(cfee, blocksIn, preSell, preBuy, kind, amount, limitTicks));
    }
}

contract WindowBuyNeverRevertsUsdcLowTest is WindowBuyNeverRevertsTest {
    function _usdcAt() internal pure override returns (address) {
        return address(0x0000000000000000000000000000000000001000);
    }
}

contract WindowBuyNeverRevertsUsdcHighTest is WindowBuyNeverRevertsTest {
    function _usdcAt() internal pure override returns (address) {
        return address(uint160(type(uint160).max - 0xfff));
    }
}
