// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {IV4Router} from "@uniswap/v4-periphery/src/interfaces/IV4Router.sol";
import {Integration9Base} from "./Integration9Base.sol";

/// @notice Integration review #9, check 6 (regression tests since 39a78b4): can an indexer rebuild every trade from
///         logs alone? For each swap it pairs the PoolManager's Swap (pool side, before the hook's fees) with the
///         hook's PoolTrade that follows it, and the window buy's ModifyLiquidity (sender = hook) and BidLocked in
///         between, then checks the rebuilt trader amounts, pool amounts, fees and bid against the real balance
///         changes.
abstract contract EventReconstructionTest is Integration9Base {
    bytes32 internal constant ERC6909_TRANSFER_SIG = keccak256("Transfer(address,address,address,uint256,uint256)");

    struct Rebuilt {
        bool isBuy;
        uint256 traderUsdc; // paid on a buy, received on a sell
        uint256 traderTokens; // received on a buy, paid on a sell
        uint256 poolUsdc; // what the pool itself took (buy) or paid (sell): the Swap event's USDC side
        uint256 fees; // platform + creator + snipe
        uint256 bidUsdc; // BidLocked, if any
        uint24 swapFeeField; // the Swap event's own `fee`
    }

    /// @dev Walks `logs` for `token`'s pool in order: Swap, then (window buys) ModifyLiquidity by the hook and
    ///      BidLocked, then PoolTrade, which closes the trade. Fails if they come in any other order.
    function _rebuild(Vm.Log[] memory logs, address token) internal view returns (Rebuilt[] memory out) {
        bytes32 pid = _pid(token);
        bool u0 = _usdcIs0(token);
        out = new Rebuilt[](_trades(logs, token).length);
        uint256 n;
        bool open;
        bool sawModify;
        for (uint256 i; i < logs.length; ++i) {
            bytes32 sig = logs[i].topics[0];
            if (sig == SWAP_SIG && logs[i].topics[1] == pid) {
                assertFalse(open, "a Swap is closed by its PoolTrade before the next Swap");
                (int128 a0, int128 a1,,,, uint24 fee) =
                    abi.decode(logs[i].data, (int128, int128, uint160, uint128, int24, uint24));
                int128 usdcSide = u0 ? a0 : a1;
                out[n].poolUsdc = uint128(usdcSide < 0 ? -usdcSide : usdcSide);
                out[n].swapFeeField = fee;
                open = true;
                sawModify = false;
            } else if (sig == MODIFY_SIG && logs[i].topics[1] == pid) {
                assertTrue(open, "the hook adds liquidity only inside a swap");
                assertEq(address(uint160(uint256(logs[i].topics[2]))), address(hook), "sender = hook");
                sawModify = true;
            } else if (sig == BID_SIG && address(uint160(uint256(logs[i].topics[1]))) == token) {
                assertTrue(open && sawModify, "BidLocked follows the hook's ModifyLiquidity inside the swap");
                (out[n].bidUsdc,,,) = abi.decode(logs[i].data, (uint256, uint128, int24, int24));
            } else if (sig == TRADE_SIG && address(uint160(uint256(logs[i].topics[1]))) == token) {
                assertTrue(open, "PoolTrade closes a Swap");
                (bool isBuy, uint256 usdcAmount, uint256 tokenAmount, uint256 pf, uint256 cf, uint256 sf) =
                    abi.decode(logs[i].data, (bool, uint256, uint256, uint256, uint256, uint256));
                out[n].isBuy = isBuy;
                out[n].traderTokens = tokenAmount;
                out[n].fees = pf + cf + sf;
                // The rule an indexer applies: buys pay the gross; sells receive the gross less the fees.
                out[n].traderUsdc = isBuy ? usdcAmount : usdcAmount - pf - cf;
                // and the pool's own side, which the Swap event already gave:
                assertEq(out[n].poolUsdc, isBuy ? usdcAmount - pf - cf - sf : usdcAmount, "Swap = PoolTrade less fees");
                n++;
                open = false;
            }
        }
        assertFalse(open, "every Swap closed");
    }

    function _check(address trader, address token, bytes memory data, bool isBuy, bool window) internal {
        uint256 u0 = usdc.balanceOf(trader);
        uint256 t0 = IERC20(token).balanceOf(trader);
        uint256 pf0 = hook.pendingPlatform(token) + hook.pendingCreator(token);
        vm.recordLogs();
        vm.prank(trader);
        v4r.executeActions(data);
        Rebuilt[] memory r = _rebuild(vm.getRecordedLogs(), token);
        assertEq(r.length, 1);
        assertEq(r[0].isBuy, isBuy);
        assertEq(r[0].swapFeeField, 0, "the Swap event's fee field says 0: the hook's fees are invisible to it");
        if (isBuy) {
            assertEq(u0 - usdc.balanceOf(trader), r[0].traderUsdc, "rebuilt USDC paid");
            assertEq(IERC20(token).balanceOf(trader) - t0, r[0].traderTokens, "rebuilt tokens received");
        } else {
            assertEq(usdc.balanceOf(trader) - u0, r[0].traderUsdc, "rebuilt USDC received");
            assertEq(t0 - IERC20(token).balanceOf(trader), r[0].traderTokens, "rebuilt tokens paid");
        }
        uint256 booked = hook.pendingPlatform(token) + hook.pendingCreator(token) - pf0;
        assertLe(booked, r[0].fees, "platform + creator booked");
        if (window && isBuy) {
            assertGt(r[0].bidUsdc, 0, "a bid");
            assertApproxEqAbs(r[0].bidUsdc, r[0].fees - booked, 2, "bid = snipe fee, to the rounding carried");
        } else {
            assertEq(r[0].bidUsdc, 0);
            assertEq(r[0].fees, booked);
        }
    }

    function _allKinds(address token, bool window) internal {
        bool u0 = _usdcIs0(token);
        _check(carol, token, _exactInSinglePlan(_key(token), u0, 2_000e6, 0), true, window);
        _check(carol, token, _exactInSinglePlan(_key(token), !u0, 3_000_000e18, 0), false, window);
        _check(carol, token, _exactOutSinglePlan(_key(token), u0, 1_000_000e18, type(uint128).max), true, window);
        _check(carol, token, _exactOutSinglePlan(_key(token), !u0, 100e6, type(uint128).max), false, window);
    }

    function test_everyKindRebuildsFromLogsInsideAndAfterTheWindow() public {
        address token = _graduatedInWindow(300, false, 1_000e6);
        _fund(token, carol, 50_000_000e18);
        _allKinds(token, true);
        _step(hook.SNIPE_BLOCKS());
        _allKinds(token, false);
    }

    /// @dev Several swaps in one transaction (two pools of ours, window buys in both): each Swap still pairs with the
    ///      next PoolTrade for the same token, with the bid between them.
    function test_multiSwapTransactionsPairInOrder() public {
        (address a, address b) = _twoInWindow(100, 200);
        uint256[] memory acts = new uint256[](6);
        bytes[] memory ps = new bytes[](6);
        acts[0] = Actions.SWAP_EXACT_IN_SINGLE;
        ps[0] = abi.encode(IV4Router.ExactInputSingleParams(_key(a), _usdcIs0(a), uint128(5_000e6), 0, bytes("")));
        acts[1] = Actions.SWAP_EXACT_IN_SINGLE;
        ps[1] = abi.encode(IV4Router.ExactInputSingleParams(_key(b), _usdcIs0(b), uint128(6_000e6), 0, bytes("")));
        acts[2] = Actions.SWAP_EXACT_IN_SINGLE;
        ps[2] = abi.encode(IV4Router.ExactInputSingleParams(_key(a), _usdcIs0(a), uint128(7_000e6), 0, bytes("")));
        (acts[3], ps[3]) = (Actions.SETTLE_ALL, abi.encode(_c(address(usdc)), type(uint256).max));
        (acts[4], ps[4]) = (Actions.TAKE_ALL, abi.encode(_c(a), 0));
        (acts[5], ps[5]) = (Actions.TAKE_ALL, abi.encode(_c(b), 0));
        vm.recordLogs();
        vm.prank(carol);
        v4r.executeActions(_plan(acts, ps));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        Rebuilt[] memory ra = _rebuild(logs, a);
        Rebuilt[] memory rb = _rebuild(logs, b);
        assertEq(ra.length, 2);
        assertEq(rb.length, 1);
        assertEq(ra[0].traderUsdc + ra[1].traderUsdc + rb[0].traderUsdc, 18_000e6, "the three gross amounts");
        assertEq(IERC20(a).balanceOf(carol), ra[0].traderTokens + ra[1].traderTokens);
        assertEq(IERC20(b).balanceOf(carol), rb[0].traderTokens);
        assertGt(ra[1].bidUsdc, 0);
        assertGt(rb[0].bidUsdc, 0);
    }

    /// @dev The hook's own ERC-6909 movements (fees minted as claims, a bid's USDC burned from them) are the
    ///      PoolManager's five-field Transfer event, which an ERC-20 indexer (three-field Transfer) never confuses with
    ///      USDC moving.
    function test_theHooksClaimMovementsAreErc6909EventsNotErc20() public {
        address token = _graduatedInWindow(0, false, 1_000e6);
        vm.recordLogs();
        _buyIn(carol, token, 1_000e6, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 mints;
        uint256 burns;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != POOL_MANAGER || logs[i].topics[0] != ERC6909_TRANSFER_SIG) continue;
            address from = address(uint160(uint256(logs[i].topics[1])));
            address to = address(uint160(uint256(logs[i].topics[2])));
            assertEq(uint256(logs[i].topics[3]), _usdcId(), "USDC id");
            if (from == address(0) && to == address(hook)) mints++;
            if (from == address(hook) && to == address(0)) burns++;
        }
        assertEq(mints, 1, "fees minted as claims");
        assertEq(burns, 1, "the bid paid by burning claims");
    }
}

contract EventReconstructionUsdcLowTest is EventReconstructionTest {
    function _usdcAt() internal pure override returns (address) {
        return address(0x0000000000000000000000000000000000001000);
    }
}

contract EventReconstructionUsdcHighTest is EventReconstructionTest {
    function _usdcAt() internal pure override returns (address) {
        return address(uint160(type(uint160).max - 0xfff));
    }
}
