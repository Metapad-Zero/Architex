// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {RawSwapper} from "../V14Base.sol";
import {Scenarios} from "../review9/Scenarios.sol";

/// @dev Claude review #9b (the running-low bid reference at 39a78b4): helpers on top of review #9's scenarios.
abstract contract Review9bBase is Scenarios {
    using PoolIdLibrary for PoolKey;

    // ─── A trader who holds only what he buys ─────────────────────────────────

    /// @dev One random action by `who` on `t`, never reverting the test (a refused action is skipped): an exact-in buy,
    ///      an exact-out buy, an exact-out buy stopped part way by a price limit, a dust exact-out buy (its snipe fee can
    ///      round to 0), a sale of part of what `who` holds, or (when `canStep`) a step of 1 to 3 blocks that stays
    ///      inside the window that opened at `openBlk`.
    function _act(RawSwapper who, address t, uint256 r, uint256 openBlk, bool canStep) internal {
        uint256 kind = r % 6;
        r >>= 8;
        bool u0 = _usdcIs0(t);
        PoolKey memory key = _key(t);
        if (kind == 0) {
            try who.swap(key, _buyIn(t, bound(r, 1e6, 200_000e6))) {} catch {}
        } else if (kind == 1) {
            try who.swap(key, _buyExactOut(t, bound(r, 1e18, 30_000_000e18))) {} catch {}
        } else if (kind == 2) {
            (, int24 tick) = _slot0(t);
            int24 d = int24(uint24(bound(r, 200, 20_000)));
            SwapParams memory p =
                SwapParams(u0, int256(50_000_000e18), TickMath.getSqrtPriceAtTick(u0 ? tick - d : tick + d));
            try who.swap(key, p) {} catch {}
        } else if (kind == 3) {
            try who.swap(key, _buyExactOut(t, 1e14)) {} catch {}
        } else if (kind == 4) {
            uint256 amt = IERC20(t).balanceOf(address(who)) * bound(r, 1, 100) / 100;
            if (amt != 0) {
                try who.swap(key, _sellIn(t, amt)) {} catch {}
            }
        } else if (canStep) {
            uint256 k = bound(r, 1, 3);
            if (block.number + k <= openBlk + 19) _step(k);
        }
    }

    /// @dev `who` sells everything it holds of `t`. Only a dust bag (under one token, left by dust buys) may be refused
    ///      (its sale would yield no USDC: FeesExceedAmount).
    function _sellAllOf(RawSwapper who, address t) internal {
        uint256 bag = IERC20(t).balanceOf(address(who));
        if (bag == 0) return;
        try who.swap(_key(t), _sellIn(t, bag)) {}
        catch {
            assertLt(bag, 1e18, "only dust is refused");
        }
    }

    /// @dev Every bid for `t` in `logs` still holds all the USDC it was placed with (2 units of rounding slack): no sale
    ///      reached it. Returns how many bids were checked.
    function _assertUntouched(Vm.Log[] memory logs, address t) internal view returns (uint256 n) {
        Bid[] memory bids = _bidsIn(logs, t);
        for (uint256 i; i < bids.length; ++i) {
            (uint256 usdcNow,) = _bidHoldings(t, bids[i]);
            assertGe(usdcNow + 2, bids[i].usdc, "a sale reached a bid placed during the sequence");
        }
        n = bids.length;
    }

    // ─── State the tests force (synthetic) ────────────────────────────────────

    /// @dev Puts `t`'s pool at `tick` (price and tick in slot0; liquidity untouched: only the full-range position is in
    ///      range anywhere, so the pool stays consistent as long as no bid range is crossed).
    function _forcePrice(address t, int24 tick) internal {
        bytes32 slot = keccak256(abi.encodePacked(PoolId.unwrap(_key(t).toId()), bytes32(uint256(6))));
        uint256 word = uint256(manager.extsload(slot));
        uint256 high = word >> 184 << 184; // protocolFee and lpFee
        uint256 sqrtP = TickMath.getSqrtPriceAtTick(tick);
        uint256 packedTick = uint256(uint24(tick)) << 160;
        vm.store(address(manager), slot, bytes32(high | packedTick | sqrtP));
        (, int24 now_) = _slot0(t);
        require(now_ == tick, "forced tick");
    }

    /// @dev Sets `t`'s bid reference in the hook's storage (`_launches` is its slot 0; bidRefTick sits after graduationTick
    ///      in the struct's second slot).
    function _forceBidRef(address t, int24 ref) internal {
        bytes32 base = keccak256(abi.encode(_key(t).toId(), uint256(0)));
        bytes32 slot = bytes32(uint256(base) + 1);
        uint256 word = uint256(vm.load(address(hook), slot));
        word = (word & ~(uint256(0xffffff) << 24)) | (uint256(uint24(ref)) << 24);
        vm.store(address(hook), slot, bytes32(word));
        require(_refOf(t) == ref, "forced reference");
    }
}
