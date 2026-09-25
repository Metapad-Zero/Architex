// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ILaunchPair} from "../../interfaces/ILaunchPair.sol";
import {IDeepenPoolPlugin} from "../../interfaces/plugins/IDeepenPoolPlugin.sol";
import {DeepenPoolPluginPreFix} from "./DeepenPoolPluginPreFix.sol";
import {Review3Base} from "./Review3Base.sol";

/// @notice previewRun against run and against an independent formula after arbitrary pool states; the curve path
///         against the pre-fix plugin; _capBase and the split at extreme reserves.
contract R3PreviewAndCurveTest is Review3Base {
    DeepenPoolPluginPreFix internal preFix;

    event DeepenRun(
        address indexed token,
        address indexed caller,
        bool graduated,
        uint256 usdcSpent,
        uint256 usdcBurning,
        uint256 usdcAdded,
        uint256 tokensBought,
        uint256 tokensAdded,
        uint256 tokensBurned,
        uint256 liquidity
    );

    function setUp() public override {
        super.setUp();
        preFix = new DeepenPoolPluginPreFix(address(pad));
    }

    /// @dev What the fix says a run offers, computed here from first principles.
    function _expectedOffer(address token) internal view returns (uint256) {
        address pair = pad.pairOf(token);
        (, uint256 rU) = _reserves(token);
        uint256 base = Math.mulDiv(rU, IERC20(pair).balanceOf(DEAD), IERC20(pair).totalSupply());
        uint256 cap = base * 25 / 10_000;
        uint256 last = deepen.lastRunAt(token);
        if (last != 0 && block.timestamp - last < HOUR) cap = cap * (block.timestamp - last) / HOUR;
        uint256 offer = Math.min(deepen.usdcHeld(token), cap);
        return offer < 3 ? 0 : offer;
    }

    /// @dev One seeded random action on the pool by a third party.
    function _act(address token, uint256 r) internal {
        address pair = pad.pairOf(token);
        uint256 kind = r % 9;
        uint256 size = (r >> 8) % 1_000_000;
        if (kind == 0) {
            // outside LP adds up to 4x the pool's USDC side
            (, uint256 rU) = _reserves(token);
            uint256 u = rU * (1 + size % 400) / 100;
            (uint256 rT2, uint256 rU2) = _reserves(token);
            if (u * rT2 / rU2 <= IERC20(token).balanceOf(lp)) _addLiquidity(token, lp, u);
        } else if (kind == 1) {
            if (IERC20(pair).balanceOf(lp) != 0) _removeLiquidity(token, lp);
        } else if (kind == 2) {
            // gift a slice of lp's LP to 0x…dEaD
            uint256 bal = IERC20(pair).balanceOf(lp);
            if (bal != 0) {
                vm.prank(lp);
                IERC20(pair).transfer(DEAD, bal * (1 + size % 100) / 100);
            }
        } else if (kind == 3) {
            vm.prank(griefer);
            usdc.transfer(pair, 1 + size * 1e3);
        } else if (kind == 4) {
            uint256 amount = 1 + size * 1e18;
            if (IERC20(token).balanceOf(lp) >= amount) {
                vm.prank(lp);
                IERC20(token).transfer(pair, amount);
            }
        } else if (kind == 5) {
            ILaunchPair(pair).sync();
        } else if (kind == 6) {
            vm.prank(carol);
            router.buy(token, 1e6 + size * 100, 0, carol, block.timestamp);
        } else if (kind == 7) {
            uint256 bal = IERC20(token).balanceOf(carol);
            if (bal > 1e18) {
                vm.prank(carol);
                router.sell(token, bal / 2, 0, carol, block.timestamp);
            }
        } else {
            _step(1 + size % 5_000);
        }
    }

    function testFuzz_previewRunIsWhatRunOffers(uint256 seed, uint16 c, uint16 burnBps, uint32 potRaw) public {
        c = uint16(bound(c, 0, 1_000));
        burnBps = uint16(bound(burnBps, 0, 10_000));
        address token = _graduatedToken(c, burnBps, bound(potRaw, 3, 3_000_000_000) * 1e3);
        vm.prank(bob);
        IERC20(token).transfer(lp, 500_000_000e18);
        for (uint256 i; i < 12; ++i) {
            _act(token, uint256(keccak256(abi.encode(seed, i))));
            if (i == 5) {
                (uint256 o,,,) = deepen.previewRun(token);
                if (o != 0) deepen.run(token);
            }
        }
        _step(1 + seed % 4_000);
        (uint256 offered, uint256 toBurn, uint256 toDeepen, bool graduated) = deepen.previewRun(token);
        assertTrue(graduated);
        assertEq(offered, _expectedOffer(token), "previewRun = min(held, 0.25% of the locked part, prorated)");
        if (offered == 0) {
            vm.expectRevert(abi.encodeWithSelector(IDeepenPoolPlugin.NothingToBuy.selector, token));
            deepen.run(token);
            return;
        }
        assertEq(toBurn + toDeepen, offered, "the split sums to the offer");
        uint256 held0 = deepen.usdcHeld(token);
        (uint256 spent,,) = deepen.run(token);
        assertEq(held0 - deepen.usdcHeld(token), spent, "books");
        assertLe(spent, offered, "never more than previewRun");
        assertLe(offered - spent, 4, "at most 4 units of the offer stay behind");
        _assertPluginClean(_one(token));
    }

    function _one(address t) internal pure returns (address[] memory a) {
        a = new address[](1);
        a[0] = t;
    }

    // ─── The curve path is the pre-fix plugin's, unit for unit ───────────────

    function testFuzz_curvePathUnchanged(uint64 buyRaw, uint32 potRaw, uint16 elapsedRaw, uint16 c) public {
        c = uint16(bound(c, 0, 1_000));
        uint256 buy = bound(buyRaw, 0, 20_000e6); // short of selling the curve out (~25,000 net)
        uint256 pot = bound(potRaw, 3, 4_000_000_000) * 1e3;
        vm.startPrank(alice);
        address a = pad.createToken("A", "A", "", c, address(deepen), abi.encode(uint16(5_000)), 0, 0, type(uint256).max);
        address b = pad.createToken("B", "B", "", c, address(preFix), abi.encode(uint16(5_000)), 0, 0, type(uint256).max);
        vm.stopPrank();
        if (buy > 3) {
            vm.startPrank(carol);
            pad.buy(a, buy, 0, carol, type(uint256).max);
            pad.buy(b, buy, 0, carol, type(uint256).max);
            vm.stopPrank();
        }
        _topUp(a, pot);
        usdc.mint(funder, pot);
        vm.startPrank(funder);
        usdc.approve(address(preFix), pot);
        preFix.onFees(b, pot);
        vm.stopPrank();
        // a first run on each, then a prorated one
        for (uint256 k; k < 2; ++k) {
            (uint256 oa, uint256 ba, uint256 da, bool ga) = deepen.previewRun(a);
            (uint256 ob, uint256 bb, uint256 db, bool gb) = preFix.previewRun(b);
            assertEq(oa, ob, "same offer on the curve");
            assertEq(ba, bb);
            assertEq(da, db);
            assertEq(ga, gb);
            assertFalse(ga, "still on the curve");
            if (oa == 0) break;
            (uint256 sa, uint256 burnedA,) = deepen.run(a);
            (uint256 sb, uint256 burnedB,) = preFix.run(b);
            assertEq(sa, sb, "same spend");
            assertEq(burnedA, burnedB, "same burn");
            assertEq(sa, oa, "a curve run short of the sell-out spends exactly its offer");
            _step(1 + uint256(elapsedRaw) % 5_000);
        }
    }

    // ─── Extreme reserves: _capBase's mulDiv and the split's square root ─────

    function test_extremeReservesDoNotBreakARun() public {
        address token = _graduatedToken(1_000, 5_000, 0);
        address pair = pad.pairOf(token);
        // A USDC side of 1e30 units (1e24 USDC) and a pot of 1e20 units: far beyond anything real.
        usdc.mint(griefer, 1e30);
        vm.startPrank(griefer);
        usdc.transfer(pair, 1e30);
        ILaunchPair(pair).sync();
        vm.stopPrank();
        _topUp(token, 1e20);
        _step(HOUR);
        (uint256 offered,,,) = deepen.previewRun(token);
        assertEq(offered, 1e20, "the pot binds");
        (uint256 spent,,) = deepen.run(token);
        assertLe(spent, offered);
        // One token wei is now worth ~5,000 USDC units, so the add's rounding can leave more than the documented
        // "at most 4 units" held (it stays in the pot for the next run; nothing is lost). Unreachable in practice:
        // it needs a price ~8e15 times graduation's.
        emit log_named_uint("left held by a run at a 1e30-unit USDC side (units)", offered - spent);
        // An outside LP 1,000x the pool on top: the locked part is unchanged and a run still works.
        _step(HOUR);
        (uint256 rT, uint256 rU) = _reserves(token);
        uint256 lockedBefore = _lockedPart(token);
        usdc.mint(lp, rU * 1_000);
        vm.prank(bob);
        IERC20(token).transfer(lp, rT * 3);
        _addLiquidity(token, lp, rU * 3);
        assertApproxEqAbs(_lockedPart(token), lockedBefore, 2, "an outside add leaves the locked part");
        // The pot's leftover alone (3,289 units) buys less than one token wei here, so the router would revert
        // ZeroAmount: MIN_RUN_USDC's "3 units buy at least a wei" holds only while a wei is worth < 1 unit.
        vm.expectRevert();
        deepen.run(token);
        _topUp(token, 1e20);
        (spent,,) = deepen.run(token);
        assertGt(spent, 0);
    }
}
