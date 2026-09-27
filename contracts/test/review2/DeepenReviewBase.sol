// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ILaunchPair} from "../../interfaces/ILaunchPair.sol";
import {ILaunchTokenExtensions} from "../../interfaces/ILaunchTokenExtensions.sol";
import {IDeepenPoolPlugin} from "../../interfaces/plugins/IDeepenPoolPlugin.sol";
import {DeepenPoolPlugin} from "../../plugins/launch/DeepenPoolPlugin.sol";
import {BuybackBurnPlugin} from "../../plugins/launch/BuybackBurnPlugin.sol";
import {ComboPlugin} from "../../plugins/launch/ComboPlugin.sol";
import {LaunchpadV13Base} from "../launchpad/LaunchpadV13Base.sol";

/// @notice Round-5 adversarial review of DeepenPoolPlugin. Shared fixture only; the probes live in the *.t.sol files.
abstract contract DeepenReviewBase is LaunchpadV13Base {
    uint256 internal constant HOUR = 3600;
    uint256 internal constant START = 1_700_000_000;

    DeepenPoolPlugin internal deepen;
    BuybackBurnPlugin internal buyback;
    ComboPlugin internal combo;

    address internal keeper = makeAddr("keeper");
    address internal funder = makeAddr("funder");
    address internal griefer = makeAddr("griefer");
    address internal lp = makeAddr("lp");

    function setUp() public virtual override {
        super.setUp();
        deepen = new DeepenPoolPlugin(address(pad));
        buyback = new BuybackBurnPlugin(address(pad));
        combo = new ComboPlugin(address(pad));
        _fund(keeper);
        _fund(funder);
        _fund(griefer);
        _fund(lp);
        vm.warp(START);
        vm.roll(1_000);
    }

    // ─── Fixture ──────────────────────────────────────────────────────────────

    function _launch(uint16 creatorFeeBps, uint16 burnBps) internal returns (address token) {
        vm.prank(alice);
        token = pad.createToken(
            "Deepen", "DPN", "", creatorFeeBps, address(deepen), abi.encode(burnBps), 0, 0, type(uint256).max
        );
    }

    /// @dev A graduated token with `waiting` USDC already credited to its Deepen pot.
    function _graduatedToken(uint16 creatorFeeBps, uint16 burnBps, uint256 waiting) internal returns (address token) {
        token = _launch(creatorFeeBps, burnBps);
        _graduate(token);
        _topUp(token, waiting);
    }

    function _topUp(address token, uint256 amount) internal {
        if (amount == 0) return;
        usdc.mint(funder, amount);
        vm.startPrank(funder);
        usdc.approve(address(deepen), amount);
        deepen.onFees(token, amount);
        vm.stopPrank();
    }

    function _topUpBuyback(address token, uint256 amount) internal {
        if (amount == 0) return;
        usdc.mint(funder, amount);
        vm.startPrank(funder);
        usdc.approve(address(buyback), amount);
        buyback.onFees(token, amount);
        vm.stopPrank();
    }

    // ─── Pool helpers ─────────────────────────────────────────────────────────

    function _reserves(address token) internal view returns (uint256 rToken, uint256 rUsdc) {
        (uint112 t, uint112 u,) = ILaunchPair(pad.pairOf(token)).getReserves();
        return (uint256(t), uint256(u));
    }

    function _lpSupply(address token) internal view returns (uint256) {
        return IERC20(pad.pairOf(token)).totalSupply();
    }

    /// @dev `who` adds liquidity proportional to the pool: `usdcSide` USDC and the matching tokens.
    function _addLiquidity(address token, address who, uint256 usdcSide) internal returns (uint256 minted) {
        address pair = pad.pairOf(token);
        (uint256 rT, uint256 rU) = _reserves(token);
        uint256 tokenSide = usdcSide * rT / rU;
        // `who` must own the tokens already.
        vm.startPrank(who);
        IERC20(token).transfer(pair, tokenSide);
        usdc.transfer(pair, usdcSide);
        minted = ILaunchPair(pair).mint(who);
        vm.stopPrank();
    }

    function _removeLiquidity(address token, address who) internal returns (uint256 outToken, uint256 outUsdc) {
        address pair = pad.pairOf(token);
        uint256 bal = IERC20(pair).balanceOf(who);
        vm.startPrank(who);
        IERC20(pair).transfer(pair, bal);
        (outToken, outUsdc) = ILaunchPair(pair).burn(who);
        vm.stopPrank();
    }

    /// @dev Advance one block and `secs` seconds (via-IR: read the cheatcode values back).
    function _step(uint256 secs) internal {
        vm.roll(vm.getBlockNumber() + 1);
        vm.warp(vm.getBlockTimestamp() + secs);
    }

    /// @dev Every solvency/containment property the plugin promises, checked after any sequence.
    function _assertPluginClean(address[] memory tokens) internal view {
        uint256 sumHeld;
        for (uint256 i; i < tokens.length; ++i) {
            sumHeld += deepen.usdcHeld(tokens[i]);
            assertEq(IERC20(tokens[i]).balanceOf(address(deepen)), 0, "plugin keeps no token");
            address pair = pad.pairOf(tokens[i]);
            if (pair != address(0)) {
                assertEq(IERC20(pair).balanceOf(address(deepen)), 0, "plugin keeps no LP");
            }
        }
        assertGe(usdc.balanceOf(address(deepen)), sumHeld, "USDC backs every token's books");
    }
}
