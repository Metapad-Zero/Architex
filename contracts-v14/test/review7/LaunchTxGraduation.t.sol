// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReviewBase} from "./ReviewBase.sol";

/// @notice Claude review #7 (informational): the creator's exempt first buy has no size limit, so a creator (or a bot that
///         launches) can take the whole curve in the launch transaction with no surcharge at all, graduating the token
///         there and then; only buyers after him pay the 90% window. This is V14-SPEC §5's [proposed] exemption working
///         as written; recorded so the owner decides it knowingly. Also checks graduation inside createToken works in both
///         sort orders.
abstract contract LaunchTxGraduationTest is ReviewBase {
    function test_creatorTakesTheWholeCurveSurchargeFree() public {
        vm.prank(alice);
        address token = pad.createToken("Whole", "WHL", "", 0, creatorWallet, "", false, 1_000_000e6, 0, MAX);
        assertTrue(pad.isGraduated(token), "graduated in the launch transaction");
        assertEq(pad.pendingSnipe(token), 0, "no surcharge paid");
        uint256 spent = 100_000_000e6 - usdc.balanceOf(alice) - 1e6; // less the 1 USDC launch fee
        console2.log("creator paid for 800M tokens (6dp)", spent);
        assertEq(IERC20(token).balanceOf(alice), 800_000_000e18);
        assertEq(hook.snipeBpsOf(token), 9000, "everyone after him pays 90% in this block");
        _assertSolvent();
        _assertHookClean(token);
    }
}

contract LaunchTxGraduationUsdcLowTest is LaunchTxGraduationTest {
    function _usdcAt() internal pure override returns (address) {
        return address(0x0000000000000000000000000000000000001000);
    }
}

contract LaunchTxGraduationUsdcHighTest is LaunchTxGraduationTest {
    function _usdcAt() internal pure override returns (address) {
        return address(uint160(type(uint160).max - 0xfff));
    }
}
