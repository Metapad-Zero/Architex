// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {TransientStateLibrary} from "@uniswap/v4-core/src/libraries/TransientStateLibrary.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {IArchitexLaunchHook} from "../../src/interfaces/IArchitexLaunchHook.sol";
import {Review8Base} from "../review8/Review8Base.sol";

/// @dev Claude review #9: runs any list of swaps, over any pools, inside ONE PoolManager unlock. Before each swap it
///      reads that pool's tick (the pre-swap tick the hook keeps for the bid that swap places). A step can sell every
///      token the unlock has received so far (`sellAll`). At the end it squares every currency it is told about from
///      the PoolManager's own delta for this contract.
contract MultiFlash is IUnlockCallback {
    using PoolIdLibrary for PoolKey;

    IPoolManager public immutable manager;

    struct Step {
        PoolKey key;
        SwapParams params;
        bool sellAll; // amountSpecified = -(this contract's token credit so far), token = the key's non-USDC currency
        bool usdcIs0;
    }

    constructor(IPoolManager manager_) {
        manager = manager_;
    }

    function run(Step[] memory steps, Currency[] memory currencies) external returns (int24[] memory pre) {
        pre = abi.decode(manager.unlock(abi.encode(steps, currencies)), (int24[]));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager), "only manager");
        (Step[] memory steps, Currency[] memory cs) = abi.decode(data, (Step[], Currency[]));
        int24[] memory pre = new int24[](steps.length);
        for (uint256 i; i < steps.length; ++i) {
            pre[i] = _tick(steps[i].key);
            SwapParams memory p = steps[i].params;
            if (steps[i].sellAll) {
                Currency t = steps[i].usdcIs0 ? steps[i].key.currency1 : steps[i].key.currency0;
                int256 credit = TransientStateLibrary.currencyDelta(manager, address(this), t);
                if (credit <= 0) {
                    pre[i] = type(int24).min; // skipped: nothing to sell
                    continue;
                }
                p.amountSpecified = -credit;
            }
            manager.swap(steps[i].key, p, "");
        }
        for (uint256 j; j < cs.length; ++j) {
            int256 d = TransientStateLibrary.currencyDelta(manager, address(this), cs[j]);
            if (d < 0) {
                manager.sync(cs[j]);
                IERC20(Currency.unwrap(cs[j])).transfer(address(manager), uint256(-d));
                manager.settle();
            } else if (d > 0) {
                manager.take(cs[j], address(this), uint256(d));
            }
        }
        return abi.encode(pre);
    }

    function _tick(PoolKey memory key) internal view returns (int24 tick) {
        bytes32 id = PoolId.unwrap(key.toId());
        bytes32 data = manager.extsload(keccak256(abi.encodePacked(id, bytes32(uint256(6)))));
        assembly ("memory-safe") {
            tick := signextend(2, shr(160, data))
        }
    }
}

/// @dev Claude review #9's helpers on top of reviews #7 and #8.
abstract contract Review9Base is Review8Base {
    bytes32 internal constant BID_LOCKED = keccak256("BidLocked(address,uint256,uint128,int24,int24)");
    bytes32 internal constant POOL_TRADE =
        keccak256("PoolTrade(address,address,bool,uint256,uint256,uint256,uint256,uint256)");

    MultiFlash internal mflash;

    struct Bid {
        uint256 usdc;
        uint128 liquidity;
        int24 lower;
        int24 upper;
    }

    function setUp() public virtual override {
        super.setUp();
        mflash = new MultiFlash(manager);
    }

    // ─── The hook's bid range, recomputed ─────────────────────────────────────

    /// @dev The range the hook gives a bid placed from `ref` (V14-SPEC §5), with the hook's clamping.
    function _rangeFrom(bool u0, int24 ref) internal pure returns (int24 lower, int24 upper) {
        if (u0) {
            lower = _ceil200(int256(ref) + 6932 + 1);
            upper = lower + 92_200 > TickMath.maxUsableTick(200) ? TickMath.maxUsableTick(200) : lower + 92_200;
        } else {
            upper = _floor200(int256(ref) - 6932);
            lower = upper - 92_200 < TickMath.minUsableTick(200) ? TickMath.minUsableTick(200) : upper - 92_200;
        }
    }

    /// @dev The cheaper token price of two ticks (with USDC as currency0 a higher tick is a cheaper token), as the hook's
    ///      `_cheaperOf` since Claude review #9's L1 fix.
    function _cheaper(bool u0, int24 a, int24 b) internal pure returns (int24) {
        if (u0) return a > b ? a : b;
        return a < b ? a : b;
    }

    /// @dev The pool's bid reference (`bidRefTick`): the lowest price any window buy has started from, graduation's to
    ///      begin with.
    function _refOf(address token) internal view returns (int24) {
        (, IArchitexLaunchHook.Launch memory l) = hook.launchOf(token);
        return l.bidRefTick;
    }

    /// @dev The range the hook gives the bid of a single window buy made from pool tick `pre`: from the cheaper of `pre`
    ///      and the pool's reference. The same whether read before that buy or after it (the buy leaves the reference at
    ///      exactly that cheaper tick). For several buys in one unlock, track the reference yourself (TransientTick).
    function _expectedRange(address token, int24 pre) internal view returns (int24 lower, int24 upper) {
        bool u0 = _usdcIs0(token);
        (lower, upper) = _rangeFrom(u0, _cheaper(u0, pre, _refOf(token)));
    }

    // ─── Logs ─────────────────────────────────────────────────────────────────

    /// @dev Every BidLocked for `token` in `logs`, in order.
    function _bidsIn(Vm.Log[] memory logs, address token) internal pure returns (Bid[] memory bids) {
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (_is(logs[i], BID_LOCKED, token)) ++n;
        }
        bids = new Bid[](n);
        n = 0;
        for (uint256 i; i < logs.length; ++i) {
            if (_is(logs[i], BID_LOCKED, token)) bids[n++] = _decodeBid(logs[i].data);
        }
    }

    function _decodeBid(bytes memory data) internal pure returns (Bid memory b) {
        (b.usdc, b.liquidity, b.lower, b.upper) = abi.decode(data, (uint256, uint128, int24, int24));
    }

    function _is(Vm.Log memory l, bytes32 sig, address token) internal pure returns (bool) {
        return l.topics.length >= 2 && l.topics[0] == sig && address(uint160(uint256(l.topics[1]))) == token;
    }

    // ─── Valuation ────────────────────────────────────────────────────────────

    /// @dev What a hook bid holds at the pool's current price: its USDC and its tokens (rounded down).
    function _bidHoldings(address token, Bid memory b) internal view returns (uint256 usdcNow, uint256 tokensNow) {
        (uint160 sqrtP,) = _slot0(token);
        uint160 sa = TickMath.getSqrtPriceAtTick(b.lower);
        uint160 sb = TickMath.getSqrtPriceAtTick(b.upper);
        uint256 a0;
        uint256 a1;
        if (sqrtP <= sa) {
            a0 = SqrtPriceMath.getAmount0Delta(sa, sb, b.liquidity, false);
        } else if (sqrtP < sb) {
            a0 = SqrtPriceMath.getAmount0Delta(sqrtP, sb, b.liquidity, false);
            a1 = SqrtPriceMath.getAmount1Delta(sa, sqrtP, b.liquidity, false);
        } else {
            a1 = SqrtPriceMath.getAmount1Delta(sa, sb, b.liquidity, false);
        }
        (usdcNow, tokensNow) = _usdcIs0(token) ? (a0, a1) : (a1, a0);
    }

    /// @dev USDC (6dp) worth of `tokens` at the pool's current price.
    function _valueNow(address token, uint256 tokens) internal view returns (uint256) {
        (uint160 sqrtP,) = _slot0(token);
        uint256 p = FullMath.mulDiv(sqrtP, sqrtP, 1 << 96); // currency1 per currency0, X96
        return _usdcIs0(token) ? FullMath.mulDiv(tokens, 1 << 96, p) : FullMath.mulDiv(tokens, p, 1 << 96);
    }

    /// @dev The pool's price in USDC per whole token, 1e18-scaled, for logs.
    function _priceE18(address token) internal view returns (uint256) {
        return _valueNow(token, 1e18) * 1e12;
    }

    // ─── Swap params ──────────────────────────────────────────────────────────

    function _buyIn(address token, uint256 usdcIn) internal view returns (SwapParams memory) {
        bool z = _usdcIs0(token);
        return SwapParams(z, -int256(usdcIn), z ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1);
    }

    function _sellIn(address token, uint256 tokensIn) internal view returns (SwapParams memory) {
        bool z = !_usdcIs0(token);
        return SwapParams(z, -int256(tokensIn), z ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1);
    }

    function _mstep(address token, SwapParams memory p) internal view returns (MultiFlash.Step memory s) {
        s.key = _key(token);
        s.params = p;
        s.usdcIs0 = _usdcIs0(token);
    }

    function _sellAllStep(address token) internal view returns (MultiFlash.Step memory s) {
        s = _mstep(token, _sellIn(token, 1));
        s.sellAll = true;
    }

    function _currencies(address token) internal view returns (Currency[] memory cs) {
        cs = new Currency[](2);
        cs[0] = Currency.wrap(address(usdc));
        cs[1] = Currency.wrap(token);
    }

    // ─── Fixtures ─────────────────────────────────────────────────────────────

    /// @dev Two tokens launched in one block and graduated in one later block, so both pools' windows run together.
    ///      Returns in the pools' opening block.
    function _twoPoolsOpenTogether(uint16 feeA, uint16 feeB) internal returns (address a, address b) {
        a = _launch(feeA, creatorWallet, "", false, 0);
        vm.prank(alice);
        b = pad.createToken("Other", "OTH", "", feeB, creatorWallet, "", false, 0, 0, MAX);
        _step(pad.SNIPE_BLOCKS());
        vm.startPrank(bob);
        pad.buy(a, 1_000_000e6, 0, bob, MAX);
        pad.buy(b, 1_000_000e6, 0, bob, MAX);
        vm.stopPrank();
        assertTrue(pad.isGraduated(a) && pad.isGraduated(b), "both graduated");
    }
}
