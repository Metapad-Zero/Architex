// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/console2.sol";
import {Scenarios} from "./Scenarios.sol";

/// @notice Claude review #9, I2 (accepted, V14-SPEC §5 and §10 now say so): the surcharge deters griefing only early in
///         the window. The spec had said "Pushing the price down before someone's buy has to be undone with a buy that
///         pays the surcharge (about 86,000 USDC to undo, against 8,300 after the window)". The 86,000 is the opening
///         block's. At block 19 the same push undone inside the window cost 8,599, and undone one block later (the window
///         closed) 7,835: no surcharge at all, less than the after-window 8,307 (carol's surcharged buy put less into the
///         pool). Either way her bid lands at 44% of where it would have. The L1 cap changes none of this (a push down
///         only makes a bid cheaper; the cap binds above the graduation price). What griefing really costs at any block
///         is the round trip against the victim's own buy, about what the victim gains. Assertions are kept loose.
abstract contract GriefAcrossWindowEndTest is Scenarios {
    function test_undoingAPushLateInTheWindowNeedNotPayTheSurcharge() public {
        (uint256 c0,) = _grief(0, 0);
        (uint256 c19, uint256 top19) = _grief(19, 0);
        (uint256 c19x, uint256 top19x) = _grief(19, 1);
        (uint256 cAfter,) = _grief(20, 0);
        console2.log("100M-token push before a 5,000 USDC buy, then bought back (cost, whole USDC):");
        console2.log("  opening block, undone in it", c0 / 1e6);
        console2.log("  block 19, undone in it", c19 / 1e6);
        console2.log("  block 19, undone the next block (window closed)", c19x / 1e6);
        console2.log("  after the window (no bid at all)", cAfter / 1e6);
        console2.log("  carol's bid top vs. unpushed, bps (undone in the window / the next block)", top19, top19x);
        assertGt(c0, 5 * cAfter, "the opening block's surcharge makes the undo expensive");
        assertLt(c19, cAfter * 12 / 10, "at block 19 the surcharge adds little");
        assertLt(c19x, cAfter * 11 / 10, "and undone after the window it costs about what it costs after the window");
        assertLt(top19x, 5_000, "while carol's bid lands at under half its place");
    }
}

contract GriefAcrossWindowEndUsdcLowTest is GriefAcrossWindowEndTest {
    function _usdcAt() internal pure override returns (address) {
        return address(0x0000000000000000000000000000000000001000);
    }
}

contract GriefAcrossWindowEndUsdcHighTest is GriefAcrossWindowEndTest {
    function _usdcAt() internal pure override returns (address) {
        return address(uint160(type(uint160).max - 0xfff));
    }
}
