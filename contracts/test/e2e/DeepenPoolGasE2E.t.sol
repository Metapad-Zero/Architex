// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./DeepenE2EBase.sol";

/// @notice Gas of every Deepen pool call a user or a keeper makes, logged and asserted under 15,000,000 (Arc's
///         per-transaction limit is ~30M; this keeps a 2x margin). Each figure is the call's execution gas with every
///         account it touches cooled first (vm.cool, as at the start of a real transaction), plus the 21,000 intrinsic
///         gas and 16 gas per calldata byte (an upper bound).
contract DeepenPoolGasE2ETest is DeepenE2EBase {
    uint256 internal constant LIMIT = 15_000_000;

    function _cool(address token) internal {
        vm.cool(address(pad));
        vm.cool(address(router));
        vm.cool(address(pairFactory));
        vm.cool(address(usdc));
        vm.cool(address(deepen));
        vm.cool(address(combo));
        vm.cool(address(buyback));
        if (token != address(0)) {
            vm.cool(token);
            vm.cool(pad.pairOf(token));
        }
    }

    function _report(string memory label, uint256 executionGas, uint256 calldataBytes)
        internal
        pure
        returns (uint256 total)
    {
        total = executionGas + 21_000 + 16 * calldataBytes;
        console2.log(string.concat(label, ": "), total);
        assertLt(total, LIMIT, label);
    }

    function _gasRun(string memory label, address token) internal returns (uint256 used) {
        _cool(token);
        vm.prank(keeper);
        uint256 g = gasleft();
        deepen.run(token);
        used = _report(label, g - gasleft(), 36);
    }

    function test_gas_deepenRuns() public {
        // createToken with Deepen pool as the plugin.
        _cool(address(0));
        bytes memory cd = abi.encodeCall(
            IArchitexLaunchpad.createToken,
            ("Gas Token", "GAS", "ipfs://gas", 1000, address(deepen), "", 0, 0, LAUNCH_FEE)
        );
        vm.prank(alice);
        uint256 g = gasleft();
        address token =
            pad.createToken("Gas Token", "GAS", "ipfs://gas", 1000, address(deepen), "", 0, 0, LAUNCH_FEE);
        _report("createToken, Deepen pool", g - gasleft(), cd.length);
        _register(token);
        _trackDeepenToken(token);

        // A collection into the plugin.
        _curveBuy(bob, token, 5_000e6);
        assertGt(pad.pendingCreatorFees(token), 0);
        _cool(token);
        g = gasleft();
        pad.collectCreatorFees(token);
        _report("collect -> Deepen.onFees", g - gasleft(), 36);
        ghostDeepenCredited[token] = deepen.usdcHeld(token);

        _gasRun("Deepen.run (curve, first run)", token);
        _warp(RUN_INTERVAL);
        _gasRun("Deepen.run (curve, later run)", token);

        // A run that sells the curve out: the exact-fill buy, the pool seeding and the graduation LP mint.
        address x = _launchDeepen(500);
        (,,, uint256 fullCost,) = _expCurveBuy(x, 1e15);
        _curveBuy(bob, x, fullCost - 40e6);
        _collectDeepen(x);
        _gasRun("Deepen.run that graduates the token", x);
        assertTrue(pad.isGraduated(x));

        // Pool runs: the first one for this token, then a later one (warm-ish slots, a fresh LP mint each time).
        _collectDeepen(x);
        _warp(RUN_INTERVAL);
        _gasRun("Deepen.run (pool, default burn share: two buys + add + LP to dead)", x);
        _collectDeepen(x);
        _warp(RUN_INTERVAL);
        _gasRun("Deepen.run (pool, later run)", x);

        // The two ends of the burn share: a pure buyback (one buy, no add) and pure deepening (one buy, an add).
        address pureBurn = _launchDeepenBurning(1000, 10_000);
        _curveBuy(bob, pureBurn, 1_000_000e6);
        _collectDeepen(pureBurn);
        _gasRun("Deepen.run (pool, burnBps 10,000: buy and burn)", pureBurn);
        address pureDeepen = _launchDeepenBurning(1000, 0);
        _curveBuy(bob, pureDeepen, 1_000_000e6);
        _collectDeepen(pureDeepen);
        _gasRun("Deepen.run (pool, burnBps 0: buy and add)", pureDeepen);

        // A pool run with tokens and LP sent to the plugin: the add, a burn and the stray LP forwarded.
        _poolBuy(dave, x, 2_000e6);
        vm.prank(dave);
        IERC20(x).transfer(address(deepen), 1_000e18);
        _collectDeepen(x);
        _warp(RUN_INTERVAL);
        _gasRun("Deepen.run (pool, with stray tokens to burn)", x);
        // The fee ghosts are not kept here (the gas calls go straight to the launchpad), so check the books that do
        // not depend on them.
        _assertDeepenBooks();
        _assertSolvent();
        _assertUsdcConserved();
    }
}
