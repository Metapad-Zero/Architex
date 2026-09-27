// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {RawSwapper} from "../V14Base.sol";
import {Review9Base, MultiFlash} from "./Review9Base.sol";

/// @notice Claude review #9, I3 (accepted, V14-SPEC §5 and §10): what bids cost in gas, measured in this test with every
///         contract's storage cold as in a fresh transaction (the spec quotes the rehearsal fork's figures, which differ).
///         - A window buy's own bid: +173k to +176k gas over the same buy after the window for the pool's first bid (new
///           ticks), +93k for a later one.
///         - An attacker spreading dust bids over many distinct ticks (sell 2% of the price, buy 0.001 USDC, repeat, all
///           at block 19; under the graduation price, where the L1 cap does not bind) pays about 108k gas per bid, and
///           each bid top adds about 10.6k gas to a later swap that crosses it.
///         - Bid positions are one per window buy, down to a 0.001 USDC buy: 100 of them cost about 10.1M gas and 0.1
///           USDC. Nothing in the hook iterates over them; Deepen pool v1.4 must not either.
///         The assertions are loose bounds (about twice the measured figures), so compiler or fixture changes do not
///         break them.
abstract contract BidGasTest is Review9Base {
    function _cool(address token) internal {
        vm.cool(address(manager));
        vm.cool(address(hook));
        vm.cool(address(usdc));
        vm.cool(token);
        vm.cool(address(router));
        vm.cool(address(pad));
    }

    function _buyGas(address token, address who, uint256 usdcIn) internal returns (uint256 used) {
        _cool(token);
        vm.prank(who);
        uint256 g = gasleft();
        router.buy(token, usdcIn, 0, who, MAX);
        used = g - gasleft();
    }

    function test_gasOfAWindowBuysBid() public {
        address token = _graduateWithCurveSnipe(0, false, dave, 0);
        uint256 snap = vm.snapshotState();
        uint256 first = _buyGas(token, carol, 1_000e6); // opening block: a new position on new ticks
        uint256 second = _buyGas(token, alice, 1_000e6); // same block: a new position, ticks likely shared
        _step(hook.SNIPE_BLOCKS());
        uint256 afterWindow = _buyGas(token, carol, 1_000e6);
        vm.revertToState(snap);
        _step(hook.SNIPE_BLOCKS());
        uint256 afterWindowFresh = _buyGas(token, carol, 1_000e6);
        console2.log("router buy of 1,000 USDC, gas (cold storage):");
        console2.log("  window, first bid (new ticks)", first);
        console2.log("  window, second bid", second);
        console2.log("  after the window (after two window buys)", afterWindow);
        console2.log("  after the window (no window buys before)", afterWindowFresh);
        console2.log("  extra for the first bid", first - afterWindowFresh);
        console2.log("  extra for the second bid", second - afterWindow);
        assertLt(first - afterWindowFresh, 350_000, "the first bid costs under 350k gas");
        assertLt(second - afterWindow, 200_000, "a later bid under 200k");
    }

    /// @dev At block 19, `n` rounds of: sell `step` tokens (about 2% of the price, no surcharge on sells), then a
    ///      0.001 USDC buy whose bid lands from that lower price, all in one unlock. With `bids` false the same rounds run
    ///      after the window (no bids), as the control. Then, after the window, the attacker buys his tokens back, and
    ///      a seller dumps 300M tokens through every one of those bid tops. Returns the attacker's gas and the dump's gas.
    function _spread(bool bids, uint256 n) internal returns (uint256 attackerGas, uint256 dumpGas, uint256 bidsMade) {
        uint256 snap = vm.snapshotState();
        address token = _graduateWithCurveSnipe(0, false, dave, 0);
        _step(bids ? 19 : 20);
        uint256 bids0 = hook.bidCount(token);
        uint256 per = 2_500_000e18;
        vm.prank(bob);
        IERC20(token).transfer(address(mflash), per * n);
        usdc.mint(address(mflash), 1_000_000e6);
        MultiFlash.Step[] memory steps = new MultiFlash.Step[](2 * n);
        for (uint256 i; i < n; ++i) {
            steps[2 * i] = _mstep(token, _sellIn(token, per));
            steps[2 * i + 1] = _mstep(token, _buyIn(token, 1_000)); // 0.001 USDC
        }
        _cool(token);
        uint256 g = gasleft();
        mflash.run(steps, _currencies(token));
        attackerGas = g - gasleft();
        bidsMade = hook.bidCount(token) - bids0;

        _step(bids ? 1 : 0); // out of the window either way
        RawSwapper back = new RawSwapper(manager);
        usdc.mint(address(back), 10_000_000e6);
        uint256 got = usdc.balanceOf(address(mflash));
        back.swap(_key(token), _buyExactOut(token, per * n)); // the attacker buys his tokens back
        got;
        vm.prank(bob);
        IERC20(token).transfer(address(raw), 300_000_000e18);
        _cool(token);
        vm.cool(address(raw));
        g = gasleft();
        raw.swap(_key(token), _sellIn(token, 300_000_000e18));
        dumpGas = g - gasleft();
        _assertHookClean(token);
        vm.revertToState(snap);
    }

    function test_spreadingDustBidsOverDistinctTicks() public {
        uint256 n = 40;
        (uint256 atkWith, uint256 dumpWith, uint256 made) = _spread(true, n);
        (uint256 atkWithout, uint256 dumpWithout,) = _spread(false, n);
        console2.log("40 rounds of sell 2.5M tokens + buy 0.001 USDC at block 19, then a 300M-token dump later:");
        console2.log("  bids made", made);
        console2.log("  attacker's gas with bids / same rounds after the window", atkWith, atkWithout);
        console2.log("  later dump's gas with those bids / without", dumpWith, dumpWithout);
        console2.log("  extra gas per bid for the attacker", (atkWith - atkWithout) / made);
        if (dumpWith > dumpWithout) {
            console2.log("  extra gas per bid crossed by the dump", (dumpWith - dumpWithout) / made);
        }
        assertEq(made, n, "one bid per dust buy");
        assertGt(
            atkWith - atkWithout, 3 * (dumpWith - dumpWithout), "spreading costs the attacker far more than it adds"
        );
        assertLt(dumpWith - dumpWithout, 40_000 * made, "under 40k gas per bid for a swap crossing them all");
    }

    /// @dev Bid positions cost a 0.001 USDC buy each: 100 of them in one transaction at block 19.
    function test_bidPositionsAreCheapToMultiply() public {
        address token = _graduateWithCurveSnipe(0, false, dave, 0);
        _step(19);
        uint256 bids0 = hook.bidCount(token);
        MultiFlash.Step[] memory steps = new MultiFlash.Step[](100);
        for (uint256 i; i < 100; ++i) {
            steps[i] = _mstep(token, _buyIn(token, 1_000));
        }
        usdc.mint(address(mflash), 1e6);
        uint256 u0 = usdc.balanceOf(address(mflash));
        _cool(token);
        uint256 g = gasleft();
        mflash.run(steps, _currencies(token));
        uint256 used = g - gasleft();
        console2.log("100 buys of 0.001 USDC at block 19: bids made, gas, USDC spent (units)");
        console2.log("  ", hook.bidCount(token) - bids0, used, u0 - usdc.balanceOf(address(mflash)));
        assertEq(hook.bidCount(token) - bids0, 100);
        assertLt(used, 25_000_000, "about 100k gas a position");
        assertLe(u0 - usdc.balanceOf(address(mflash)), 100_000, "0.1 USDC in all");
    }
}

contract BidGasUsdcLowTest is BidGasTest {
    function _usdcAt() internal pure override returns (address) {
        return address(0x0000000000000000000000000000000000001000);
    }
}

contract BidGasUsdcHighTest is BidGasTest {
    function _usdcAt() internal pure override returns (address) {
        return address(uint160(type(uint160).max - 0xfff));
    }
}
