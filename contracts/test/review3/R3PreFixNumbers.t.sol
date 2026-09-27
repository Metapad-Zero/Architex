// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {DeepenPoolPluginPreFix} from "./DeepenPoolPluginPreFix.sol";
import {Review3Base, Op, Ledger} from "./Review3Base.sol";

/// @notice Checks the H1 numbers the docs quote against code: the pre-fix plugin (commit 7da9b3b, compiled here as a
///         test-only copy) and the fixed one (25dcb73) under the same one-transaction program.
contract R3PreFixNumbersTest is Review3Base {
    DeepenPoolPluginPreFix internal preFix;

    function setUp() public override {
        super.setUp();
        preFix = new DeepenPoolPluginPreFix(address(pad));
    }

    function _tokenFor(address plugin, uint16 c) internal returns (address token) {
        vm.prank(alice);
        token = pad.createToken("Target", "TGT", "", c, plugin, abi.encode(uint16(5_000)), 0, 0, type(uint256).max);
        _graduate(token);
    }

    function _potFor(address plugin, address token, uint256 amount) internal {
        usdc.mint(funder, amount);
        vm.startPrank(funder);
        usdc.approve(plugin, amount);
        (bool ok,) = plugin.call(abi.encodeWithSignature("onFees(address,uint256)", token, amount));
        require(ok, "onFees");
        vm.stopPrank();
    }

    /// @dev review2's _pushFor: the push that lets one inflated (whole-reserve) cap cover `pot` after a full park.
    function _pushFor(address token, uint256 pot, uint16 c) internal view returns (uint256) {
        (, uint256 r) = _reserves(token);
        uint256 root = Math.sqrt(400 * pot * r);
        return (root - r) * 10_000 / (10_000 - 50 - uint256(c)) + 2;
    }

    function _headline(address plugin) internal returns (int256 pnl, Ledger memory l) {
        address token = _tokenFor(plugin, 100);
        _potFor(plugin, token, 200_000e6);
        _step(HOUR);
        atk = _newAttacker();
        _pushParkProgram(token, plugin, _pushFor(token, 200_000e6, 100), true, false);
        (pnl, l) = _try();
    }

    /// @dev SECURITY.md §3c and V13-SPEC §2.3 quote +153,179 USDC for the pre-fix Deepen pool and -38,543 for the fix.
    function test_H1_numbersQuotedInTheDocs() public {
        (int256 before_, Ledger memory lb) = _headline(address(preFix));
        (int256 after_, Ledger memory la) = _headline(address(deepen));
        _logLedger("PRE-FIX Deepen pool (7da9b3b): push, park, run, unpark, sell", lb, before_);
        _logLedger("FIXED Deepen pool (25dcb73): the same program", la, after_);
        assertGt(before_, 153_000e6, "pre-fix: about +153,179 USDC");
        assertLt(after_, -38_000e6, "fixed: about -38,543 USDC");
    }
}
