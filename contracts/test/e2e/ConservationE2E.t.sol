// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./E2EBase.sol";

/// @notice Theme 8: whole-system USDC conservation after long mixed scenarios. _assertSystem() checks that every USDC
///         unit ever minted sits with a tracked actor or contract, and that each contract's balance is exactly its own
///         accounting: the launchpad (pendingFees + Σ pendingCreatorFees + Σ live curve floats), each launch pool (its
///         USDC reserve), Split / Buyback / Holders (Σ of their per-token balances), the Combo and the router (zero),
///         each token's dividend pool (distributed - claimed, covering every claimable to rounding dust).
contract ConservationE2ETest is E2EBase {
    MisbehavingPlugin internal broken;

    function setUp() public override {
        super.setUp();
        broken = new MisbehavingPlugin(IERC20(address(usdc)));
        _trackUsdc(address(broken));
    }

    function _actor(uint256 i) internal view returns (address) {
        address[6] memory actors = [alice, bob, carol, dave, erin, frank];
        return actors[i % actors.length];
    }

    /// @dev Everything a keeper would do for one token: collect (unless its plugin is the broken one; for a Holders
    ///      token that feeds the token's dividend stream), run its buyback, release its split.
    function _service(address token) internal {
        if (pad.pluginOf(token) == address(broken)) {
            if (pad.pendingCreatorFees(token) != 0) {
                vm.expectRevert(bytes("plugin broken"));
                pad.collectCreatorFees(token);
            }
            return;
        }
        _collect(token);
        if (buyback.isConfigured(token)) {
            (uint256 offer,) = buyback.previewRun(token);
            if (offer != 0) _run(token);
        }
        if (split.isConfigured(token)) _releaseAll(token);
    }

    function test_conservation_longMixedScenario() public {
        address[] memory t = new address[](9);
        t[0] = _launch(Kind.Eoa, 0, 1_000e6);
        t[1] = _launch(Kind.Plain, 1000, 0);
        t[2] = _launch(Kind.SafeLike, 300, 250e6);
        t[3] = _launch(Kind.Split, 500, 2_000e6);
        t[4] = _launch(Kind.Buyback, 700, 1_500e6);
        t[5] = _launch(Kind.Holder, 400, 3_000e6);
        t[6] = _launch(Kind.Combo, 900, 1_000e6);
        t[7] = _launchWith(
            bob, 1000, address(combo), abi.encode(_addrs(address(buyback), address(holder)), _u16s(5000, 5000), _datas("", "")), 800e6
        );
        t[8] = _launchWith(carol, 250, address(broken), "", 500e6);
        broken.setMode(MisbehavingPlugin.Mode.Revert);

        for (uint256 day; day < 3; ++day) {
            for (uint256 round; round < 3; ++round) {
                for (uint256 i; i < t.length; ++i) {
                    address who = _actor(day * 7 + round * 3 + i);
                    _buy(who, t[i], 700e6 + (i * 97e6) + round * 13_000_001);
                    uint256 bal = IERC20(t[i]).balanceOf(_actor(i + round));
                    if (bal > 1e21) _sell(_actor(i + round), t[i], bal / 3);
                }
                _nextBlock();
                for (uint256 i; i < t.length; ++i) {
                    _service(t[i]);
                }
                if (round == 1) {
                    // a few holders claim on the token, one through claimFor by someone else
                    _claim(t[5], alice);
                    uint256 owed = ILaunchToken(t[7]).claimable(bob);
                    vm.prank(mallory);
                    assertEq(ILaunchToken(t[7]).claimFor(bob), owed);
                }
                _warp(8 hours);
            }
            // Graduations spread over the days, including the broken plugin's token.
            if (day == 0) {
                _graduateVia(frank, t[1]);
                _graduateVia(erin, t[4]);
            } else if (day == 1) {
                _graduateVia(frank, t[3]);
                _graduateVia(dave, t[6]);
                _graduateVia(erin, t[8]);
            } else {
                _graduateVia(frank, t[5]);
                _graduateVia(dave, t[7]);
            }
            _collectFees();
            _assertSystem();
        }

        // A last round of pool trades and service, then past every stream's end.
        for (uint256 i; i < t.length; ++i) {
            if (pad.isGraduated(t[i])) _poolBuy(carol, t[i], 2_345e6);
        }
        _warp(PERIOD);
        for (uint256 i; i < t.length; ++i) {
            _service(t[i]);
        }
        for (uint256 i; i < t.length; ++i) {
            if (holder.isConfigured(t[i])) _finishStream(t[i]);
        }
        _collectFees();
        _assertSystem();

        // The totals, stated once more: every unit minted is somewhere, and the broken token's fees are still waiting.
        assertGt(pad.pendingCreatorFees(t[8]), 0, "stranded, not lost");
        uint256 minted = FUNDS * 7; // _fund for seven actors; nothing else was minted
        assertEq(usdc.totalSupply(), minted);
    }

    /// @dev Random operations across graduation on three tokens with random plugins and creator fees. Every operation
    ///      is checked by its helper; the whole system is checked at the end.
    /// forge-config: default.fuzz.runs = 64
    function testFuzz_conservation_randomOpsAcrossGraduation(uint256 seed) public {
        address[3] memory t;
        for (uint256 i; i < 3; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, "launch", i)));
            Kind kind = Kind(r % 7);
            uint16 bps = uint16((r >> 8) % 1001);
            uint256 first = (r >> 24) % 3_000e6;
            t[i] = _launch(kind, bps, first < 3 ? 0 : first);
        }
        for (uint256 step; step < 40; ++step) {
            uint256 r = uint256(keccak256(abi.encode(seed, step)));
            address token = t[r % 3];
            address who = _actor(r >> 8);
            uint256 op = (r >> 16) % 10;
            if (op <= 2) {
                _buy(who, token, bound(r >> 32, 5e6, 9_000e6));
            } else if (op == 3) {
                uint256 bal = IERC20(token).balanceOf(who);
                if (bal > 1e21) _sell(who, token, bound(r >> 64, bal / 10, bal));
            } else if (op == 4) {
                if (!pad.isGraduated(token)) _graduateVia(who, token);
            } else if (op == 5) {
                _service(token);
            } else if (op == 6) {
                if (ILaunchToken(token).claimable(who) != 0) _claim(token, who);
            } else if (op == 7) {
                uint256 owed = ILaunchToken(token).claimable(who);
                vm.prank(mallory);
                assertEq(ILaunchToken(token).claimFor(who), owed, "claimFor pays the holder its claimable");
            } else if (op == 8) {
                _collectFees();
            } else {
                _warp(bound(r >> 96, 1, 12 hours));
            }
        }
        for (uint256 i; i < 3; ++i) {
            _service(t[i]);
        }
        _collectFees();
        _assertSystem();
    }
}
