// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "../launchpad/LaunchpadV13Base.sol";

/// @notice Review: an independent shadow model of who earned what. The model never looks at the token's per-share
///         value or corrections: over every interval between actions it splits what the stream pays (the stored rate,
///         the running/paused/ended state mirrored from the spec) across the holders by the balances they held, and
///         compares each holder's claimable + claimed with that, after every step of a random sequence of buys,
///         sells (pulls), transfers, burns, sends to 0x…dEaD, distributes (running and paused), claims and warps.
contract V13ShadowModelReview is Test {
    uint256 constant D = 24 hours;
    uint256 constant MAG = 2 ** 128;
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    BlockableUSDC usdc;
    LaunchToken token;
    address pair = makeAddr("pair");
    address payer = makeAddr("payer");
    address[4] hs;

    // mirror of the stream
    uint256 mLast;
    uint256 mEnd;
    // what each holder earned, magnified
    mapping(address => uint256) earned;
    uint256 accruals;

    function _deployToken() internal virtual returns (LaunchToken) {
        return new LaunchToken("Shadow", "SHD", address(usdc), makeAddr("router"));
    }

    function setUp() public {
        vm.warp(1_700_000_000);
        usdc = new BlockableUSDC();
        token = _deployToken();
        token.initPair(pair);
        usdc.mint(payer, 1e30);
        vm.prank(payer);
        usdc.approve(address(token), type(uint256).max);
        hs = [makeAddr("h0"), makeAddr("h1"), makeAddr("h2"), makeAddr("h3")];
    }

    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    function _rate() internal view returns (uint256) {
        return uint256(vm.load(address(token), bytes32(uint256(10))));
    }

    function _eligible() internal view returns (uint256 e) {
        for (uint256 i; i < 4; ++i) e += token.balanceOf(hs[i]);
    }

    /// @dev The model's accrual up to now, from balances alone.
    function _modelAccrue() internal {
        uint256 t = _now();
        if (mLast < mEnd && mLast != t) {
            uint256 e = _eligible();
            if (e < 1e18) {
                mEnd += t - mLast;
                mLast = t;
            } else {
                uint256 upTo = t < mEnd ? t : mEnd;
                uint256 paid = _rate() * (upTo - mLast);
                for (uint256 i; i < 4; ++i) {
                    earned[hs[i]] += Math.mulDiv(paid, token.balanceOf(hs[i]), e);
                }
                mLast = upTo;
                accruals++;
            }
        }
    }

    function testFuzz_review_shadowModelAttributesEveryIntervalByBalance(uint256 seed) public virtual {
        _runModel(seed);
    }

    /// @dev External entry for try/catch (the mutant check).
    function runModel(uint256 seed) external {
        _runModel(seed);
    }

    function _runModel(uint256 seed) internal {
        for (uint256 step; step < 80; ++step) {
            uint256 r = uint256(keccak256(abi.encode(seed, step)));
            address a = hs[r % 4];
            address b = hs[(r >> 8) % 4];
            uint256 x = r >> 24;
            _modelAccrue(); // before the action, as the token does
            uint256 action = (r >> 16) % 9;
            if (action == 0) {
                token.transfer(a, x % 3e18 == 0 ? 0 : (x % 2 == 0 ? x % 3e18 : x % 1e25)); // buy (from the launchpad)
            } else if (action == 1) {
                uint256 bal = token.balanceOf(a);
                token.pull(a, address(this), bal == 0 ? 0 : x % (bal + 1)); // curve sell
            } else if (action == 2) {
                uint256 bal = token.balanceOf(a);
                vm.prank(a);
                token.transfer(b, bal == 0 ? 0 : x % (bal + 1));
            } else if (action == 3) {
                uint256 bal = token.balanceOf(a);
                vm.prank(a);
                token.burn(bal == 0 ? 0 : x % (bal + 1));
            } else if (action == 4) {
                uint256 bal = token.balanceOf(a);
                vm.prank(a);
                token.transfer(DEAD, bal == 0 ? 0 : x % (bal + 1));
            } else if (action == 5) {
                uint256 amt = 1 + x % 1e12;
                vm.prank(payer);
                token.distribute(amt);
                mLast = _now();
                mEnd = token.streamEnd();
            } else if (action == 6) {
                token.claimFor(a);
            } else {
                vm.warp(_now() + x % D);
            }

            for (uint256 i; i < 4; ++i) {
                address h = hs[i];
                uint256 got = token.claimable(h) + token.claimed(h);
                // After the action the model has not accrued past `now`; claimable accrues to now, so bring the
                // model's view there too without mutating it (a warp is the only action that moves time).
                uint256 exp = earned[h] + _pendingModel(h);
                assertLe(got, exp / MAG + 1, "never more than the time-weighted share (+1 rounding)");
                assertGe(got + 2, exp / MAG, "never short by more than rounding");
            }
            assertEq(uint256(vm.load(address(token), bytes32(uint256(11)))) & type(uint128).max, _eligible(), "eligible");
        }
    }

    /// @dev What the model would add for `h` up to now (view).
    function _pendingModel(address h) internal view returns (uint256) {
        uint256 t = _now();
        if (!(mLast < mEnd && mLast != t)) return 0;
        uint256 e = _eligible();
        if (e < 1e18) return 0;
        uint256 upTo = t < mEnd ? t : mEnd;
        return Math.mulDiv(_rate() * (upTo - mLast), token.balanceOf(h), e);
    }
}
