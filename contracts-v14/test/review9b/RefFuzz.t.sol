// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {RawSwapper} from "../V14Base.sol";
import {Review9bBase} from "./Review9bBase.sol";

/// @notice Claude review #9b, attack 1 (holds): with the running-low reference, no window bid can land above where a dump
///         by its own buyer, or by a sandwicher, ends.
///         Why it holds: a bid starts from half the lowest price any window buy that paid a snipe fee has started from,
///         and a trader who holds only what he bought (with nobody else trading in between) can never push the price
///         under the price his first buy started from, because his sells return at most the tokens his buys took out.
///         A sandwicher's first buy starts at the market before the attack, so the victim's bid starts at most from
///         there; the back-run returns the pool to that market plus the victim's tokens, above it. Dust buys whose snipe
///         fee rounds to 0 do not move the reference, but they cannot move the price either.
///         Fuzzed on the real PoolManager, any sort order: a dump of up to 600M tokens first (a crash, which moves no
///         reference), then random sequences of exact-in, exact-out, price-limited (partial) and dust buys, partial
///         sells and block steps inside the window, over one or two pools; then everything sold. No bid placed during the
///         sequence ever gives up USDC. Run deeper with FOUNDRY_FUZZ_RUNS=5000.
abstract contract RefFuzzTest is Review9bBase {
    /// @dev No dump, or one of 1 to 600M tokens (a dust sale would itself be refused: FeesExceedAmount).
    function _crashSize(uint256 x) internal pure returns (uint256) {
        x = bound(x, 0, 600_000_000e18);
        return x < 1e18 ? 0 : x;
    }

    /// @dev Own buys, own sells, own dump: none of the trader's own bids is ever reached.
    function testFuzz_ownDumpNeverReachesOwnBids(
        uint256 crash,
        uint256 startBlock,
        uint256 seed,
        uint8 nActions,
        bool twoPools
    ) public {
        _ownDump(crash, startBlock, seed, nActions, twoPools);
    }

    /// @dev The fuzz is not vacuous: fixed draws place and check bids, after a crash and without one.
    function test_theOwnDumpSequencesPlaceBids() public {
        uint256 total;
        for (uint256 i; i < 6; ++i) {
            uint256 snap = vm.snapshotState();
            total += _ownDump(
                i % 2 == 0 ? 0 : 300_000_000e18, i * 3, uint256(keccak256(abi.encode("seed", i))), 12, i % 3 == 0
            );
            vm.revertToState(snap);
        }
        emit log_named_uint("bids placed and checked over 6 fixed sequences", total);
        assertGt(total, 12, "bids were placed and checked");
    }

    function _ownDump(uint256 crash, uint256 startBlock, uint256 seed, uint8 nActions, bool twoPools)
        internal
        returns (uint256 checked)
    {
        (address a, address b) = _twoPoolsOpenTogether(0, 300);
        uint256 openBlk = block.number;
        _crash(a, _crashSize(crash));
        startBlock = bound(startBlock, 0, 19);
        if (startBlock != 0) _step(startBlock);
        RawSwapper atk = new RawSwapper(manager);
        usdc.mint(address(atk), 1e9 * 1e6);
        vm.recordLogs();
        uint256 n = bound(nActions, 1, 12);
        for (uint256 i; i < n; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            _act(atk, twoPools && r & 1 == 1 ? b : a, r >> 1, openBlk, true);
        }
        if (block.number < openBlk + 20) _step(openBlk + 20 - block.number); // dump after the window closes
        _sellAllOf(atk, a);
        _sellAllOf(atk, b);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        checked = _assertUntouched(logs, a) + _assertUntouched(logs, b);
        _assertHookClean(a);
        _assertSolvent();
    }

    /// @dev Front-run (1 to 5 random buys, maybe across blocks), the victim's buy (router exact in with no minimum, or
    ///      exact out), the back-run selling everything the attacker bought: neither the victim's bid nor the attacker's
    ///      own is ever reached.
    function testFuzz_aSandwichNeverReachesTheVictimsBid(
        uint256 crash,
        uint256 startBlock,
        uint256 seed,
        uint8 nFront,
        bool victimExactOut,
        uint256 victimAmount
    ) public {
        _sandwichRun(crash, startBlock, seed, nFront, victimExactOut, victimAmount);
    }

    /// @dev The fuzz is not vacuous: fixed draws place and check bids.
    function test_theSandwichSequencesPlaceBids() public {
        uint256 total;
        for (uint256 i; i < 6; ++i) {
            uint256 snap = vm.snapshotState();
            total += _sandwichRun(
                i % 2 == 0 ? 0 : 300_000_000e18, i * 3, uint256(keccak256(abi.encode("sw", i))), 5, i % 2 == 1, 50_000e6
            );
            vm.revertToState(snap);
        }
        emit log_named_uint("bids placed and checked over 6 fixed sandwiches", total);
        assertGt(total, 6, "bids were placed and checked");
    }

    function _sandwichRun(
        uint256 crash,
        uint256 startBlock,
        uint256 seed,
        uint8 nFront,
        bool victimExactOut,
        uint256 victimAmount
    ) internal returns (uint256 checked) {
        address t = _open(_crashSize(crash), 0);
        uint256 openBlk = block.number;
        startBlock = bound(startBlock, 0, 19);
        if (startBlock != 0) _step(startBlock);
        RawSwapper atk = new RawSwapper(manager);
        RawSwapper vic = new RawSwapper(manager);
        usdc.mint(address(atk), 1e9 * 1e6);
        usdc.mint(address(vic), 1e9 * 1e6);
        vm.recordLogs();
        uint256 n = bound(nFront, 1, 5);
        for (uint256 i; i < n; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            // buys and steps only (kinds 0, 1, 2, 3, 5): a front-run
            uint256 kind = r % 6 == 4 ? 0 : r % 6;
            _act(atk, t, (r >> 8 << 8) | kind, openBlk, true);
        }
        if (victimExactOut) {
            try vic.swap(_key(t), _buyExactOut(t, bound(victimAmount, 1e18, 50_000_000e18))) {} catch {}
        } else {
            vm.prank(carol);
            try router.buy(t, bound(victimAmount, 1e6, 200_000e6), 0, carol, MAX) {} catch {}
        }
        _sellAllOf(atk, t);
        checked = _assertUntouched(vm.getRecordedLogs(), t);
        _assertHookClean(t);
        _assertSolvent();
    }
}

contract RefFuzzUsdcLowTest is RefFuzzTest {
    function _usdcAt() internal pure override returns (address) {
        return address(0x0000000000000000000000000000000000001000);
    }
}

contract RefFuzzUsdcHighTest is RefFuzzTest {
    function _usdcAt() internal pure override returns (address) {
        return address(uint160(type(uint160).max - 0xfff));
    }
}
