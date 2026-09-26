// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {ArchitexLaunchpadV14} from "../src/ArchitexLaunchpadV14.sol";
import {ArchitexLaunchHook} from "../src/ArchitexLaunchHook.sol";
import {ArchitexV4Router} from "../src/ArchitexV4Router.sol";
import {IArchitexLaunchHook} from "../src/interfaces/IArchitexLaunchHook.sol";
import {MockUSDC} from "./utils/MockUSDC.sol";
import {RawSwapper, V14Base} from "./V14Base.sol";

/// @dev Drives random launches, curve and pool trades (exact in through the router, exact out through a raw swapper),
///      graduations, donation attempts, syncs and collections across a few tokens, in blocks inside and after both
///      snipe windows, and checks every bid a buy or a graduation places against the pool's price right after.
contract V14Handler is Test {
    using PoolIdLibrary for PoolKey;

    IPoolManager internal constant MANAGER = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);

    ArchitexLaunchpadV14 internal immutable pad;
    ArchitexLaunchHook internal immutable hook;
    ArchitexV4Router internal immutable router;
    RawSwapper internal immutable raw;
    MockUSDC internal immutable usdc;
    address[] public tokens;
    uint256 public donations;
    /// @dev Bids placed anywhere but wholly under the market (checked on every buy's BidLocked).
    uint256 public bidsAboveMarket;
    /// @dev Bids whose top is above half the graduation price.
    uint256 public bidsAboveHalfGraduation;
    /// @dev Bids not placed from the pool's reference (bidRefTick) as it stands after the call.
    uint256 public bidsOffReference;
    /// @dev Times a pool's reference moved to a pricier tick.
    uint256 public referenceRose;
    mapping(address => int24) internal _lastRef;
    mapping(address => bool) internal _refSeen;
    uint256 public bidsPlaced;

    constructor(
        ArchitexLaunchpadV14 pad_,
        ArchitexLaunchHook hook_,
        ArchitexV4Router router_,
        RawSwapper raw_,
        MockUSDC usdc_
    ) {
        (pad, hook, router, raw, usdc) = (pad_, hook_, router_, raw_, usdc_);
        usdc.mint(address(this), 1e18);
        usdc.approve(address(pad), type(uint256).max);
        usdc.approve(address(router), type(uint256).max);
    }

    function tokensLength() external view returns (uint256) {
        return tokens.length;
    }

    function launch(uint16 fee, bool open, uint256 firstBuy) external {
        if (tokens.length >= 3) return;
        fee = uint16(bound(fee, 0, 1000));
        firstBuy = bound(firstBuy, 0, 5_000e6);
        tokens.push(pad.createToken("Fuzz", "FZ", "", fee, address(0xBEEF), "", open, firstBuy, 0, type(uint256).max));
    }

    function step(uint256 blocks) external {
        blocks = bound(blocks, 1, 30);
        vm.roll(block.number + blocks);
        vm.warp(block.timestamp + blocks / 2 + 1);
    }

    function curveBuy(uint256 i, uint256 amount) external {
        if (tokens.length == 0) return;
        address t = tokens[i % tokens.length];
        if (pad.isGraduated(t)) return;
        amount = bound(amount, 1e6, 40_000e6);
        pad.buy(t, amount, 0, address(this), type(uint256).max);
    }

    function curveSell(uint256 i, uint256 frac) external {
        if (tokens.length == 0) return;
        address t = tokens[i % tokens.length];
        uint256 bal = IERC20(t).balanceOf(address(this));
        if (pad.isGraduated(t) || bal == 0) return;
        uint256 amount = bal * bound(frac, 1, 100) / 100;
        try pad.sell(t, amount, 0, address(this), type(uint256).max) {} catch {}
    }

    function poolBuy(uint256 i, uint256 amount) external {
        if (tokens.length == 0) return;
        address t = tokens[i % tokens.length];
        if (!pad.isGraduated(t)) return;
        amount = bound(amount, 1e6, 50_000e6);
        vm.recordLogs();
        router.buy(t, amount, 0, address(this), type(uint256).max);
        _checkBids(t);
    }

    function poolSell(uint256 i, uint256 frac) external {
        if (tokens.length == 0) return;
        address t = tokens[i % tokens.length];
        uint256 bal = IERC20(t).balanceOf(address(this));
        if (!pad.isGraduated(t) || bal == 0) return;
        uint256 amount = bal * bound(frac, 1, 100) / 100;
        try router.sell(t, amount, 0, address(this), type(uint256).max) {} catch {}
    }

    /// @dev Exact out, either way, through a router the hook has never heard of.
    function rawExactOut(uint256 i, uint256 amount, bool buyTokens) external {
        if (tokens.length == 0) return;
        address t = tokens[i % tokens.length];
        if (!pad.isGraduated(t)) return;
        PoolKey memory key = hook.poolKeyOf(t);
        bool usdcIs0 = address(usdc) < t;
        usdc.mint(address(raw), 100_000e6);
        uint256 bal = IERC20(t).balanceOf(address(this));
        if (!buyTokens) {
            if (bal == 0) return;
            IERC20(t).transfer(address(raw), bal);
        }
        bool zeroForOne = buyTokens == usdcIs0;
        int256 specified = buyTokens ? int256(bound(amount, 1e18, 1_000_000e18)) : int256(bound(amount, 1e6, 1_000e6));
        vm.recordLogs();
        try raw.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: specified,
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            })
        ) {
            _checkBids(t);
        } catch {}
    }

    function graduate(uint256 i) external {
        if (tokens.length == 0) return;
        address t = tokens[i % tokens.length];
        if (pad.isGraduated(t)) return;
        vm.recordLogs();
        pad.buy(t, 1_000_000e6, 0, address(this), type(uint256).max);
        _checkBids(t);
    }

    /// @dev Every BidLocked in the last call must sit wholly on the USDC side of the pool's price now.
    function _checkBids(address t) internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("BidLocked(address,uint256,uint128,int24,int24)");
        for (uint256 j; j < logs.length; ++j) {
            if (logs[j].topics[0] != sig || address(uint160(uint256(logs[j].topics[1]))) != t) continue;
            (,, int24 lower, int24 upper) = abi.decode(logs[j].data, (uint256, uint128, int24, int24));
            bytes32 slot0 = MANAGER.extsload(
                keccak256(abi.encodePacked(PoolId.unwrap(hook.poolKeyOf(t).toId()), bytes32(uint256(6))))
            );
            int24 tick;
            assembly ("memory-safe") {
                tick := signextend(2, shr(160, slot0))
            }
            ++bidsPlaced;
            bool u0 = address(usdc) < t;
            if (u0 ? tick >= lower : tick < upper) ++bidsAboveMarket;
            (, IArchitexLaunchHook.Launch memory l) = hook.launchOf(t);
            if (u0 ? lower < l.graduationTick + 6932 : upper > l.graduationTick - 6932) ++bidsAboveHalfGraduation;
            (int24 lo, int24 hi) = _rangeFrom(u0, l.bidRefTick);
            if (lo != lower || hi != upper) ++bidsOffReference;
        }
        if (pad.isGraduated(t)) {
            (, IArchitexLaunchHook.Launch memory l) = hook.launchOf(t);
            if (_refSeen[t] && (address(usdc) < t ? l.bidRefTick < _lastRef[t] : l.bidRefTick > _lastRef[t])) {
                ++referenceRose;
            }
            (_lastRef[t], _refSeen[t]) = (l.bidRefTick, true);
        }
    }

    /// @dev The hook's bid range from `ref`, recomputed (V14-SPEC §5; no clamping at the prices these runs reach).
    function _rangeFrom(bool u0, int24 ref) internal pure returns (int24 lower, int24 upper) {
        if (u0) {
            int256 t = int256(ref) + 6932 + 1;
            int256 c = t / 200;
            if (t > 0 && t % 200 != 0) c++;
            lower = int24(c * 200);
            upper = lower + 92_200;
        } else {
            int256 t = int256(ref) - 6932;
            int256 c = t / 200;
            if (t < 0 && t % 200 != 0) c--;
            upper = int24(c * 200);
            lower = upper - 92_200;
        }
    }

    /// @dev Always refused; counted if one ever lands.
    function donate(uint256 i, uint256 amount, bool usdcSide) external {
        if (tokens.length == 0) return;
        address t = tokens[i % tokens.length];
        if (!pad.isGraduated(t)) return;
        bool usdcIs0 = address(usdc) < t;
        if (usdcSide) {
            amount = bound(amount, 1, 1_000e6);
            usdc.mint(address(raw), amount);
        } else {
            uint256 bal = IERC20(t).balanceOf(address(this));
            if (bal == 0) return;
            amount = bound(amount, 1, bal);
            IERC20(t).transfer(address(raw), amount);
        }
        bool zero = usdcSide == usdcIs0;
        try raw.donate(hook.poolKeyOf(t), zero ? amount : 0, zero ? 0 : amount) {
            ++donations;
        } catch {}
    }

    function sync(uint256 i) external {
        if (tokens.length == 0) return;
        pad.syncPoolFees(tokens[i % tokens.length]);
    }

    function collect(uint256 i) external {
        pad.collectFees();
        if (tokens.length == 0) return;
        pad.collectCreatorFees(tokens[i % tokens.length]);
    }
}

/// @notice V14-SPEC §11 invariants, under random sequences.
contract LaunchpadV14InvariantTest is V14Base {
    V14Handler internal handler;

    function _usdcAt() internal pure override returns (address) {
        return 0x3600000000000000000000000000000000000000;
    }

    function setUp() public override {
        super.setUp();
        handler = new V14Handler(pad, hook, router, raw, usdc);
        targetContract(address(handler));
    }

    /// @dev Coverage: the bid check only means something if bids were placed.
    function afterInvariant() public {
        emit log_named_uint("run: bids placed and checked against the market", handler.bidsPlaced());
    }

    /// @dev The launchpad's USDC is exactly its books: platform and creator fees, curve snipe fees, live curve floats.
    function invariant_launchpadUsdcIsItsBooks() public view {
        _assertSolvent();
    }

    /// @dev The hook keeps no launch token and no USDC; its claims are exactly what it owes: pool fees not yet released
    ///      and the rounding the last bid left.
    function invariant_hookHoldsOnlyWhatItOwes() public view {
        uint256 n = handler.tokensLength();
        uint256 owed;
        for (uint256 i; i < n; ++i) {
            address t = handler.tokens(i);
            assertEq(IERC20(t).balanceOf(address(hook)), 0, "hook keeps no token");
            owed += hook.pendingPlatform(t) + hook.pendingCreator(t) + hook.lockHeld(t);
        }
        assertEq(usdc.balanceOf(address(hook)), 0, "hook keeps no USDC");
        assertEq(_hookClaims(), owed, "hook claims == what it owes");
    }

    /// @dev Snipe fees never wait (each becomes a bid in the buy, or the graduation, that collects it), every bid lands
    ///      wholly under the market, and no donation ever lands.
    function invariant_nothingWaitsBidsSitUnderTheMarketNobodyDonates() public view {
        uint256 n = handler.tokensLength();
        for (uint256 i; i < n; ++i) {
            assertLe(hook.lockHeld(handler.tokens(i)), 2, "snipe fees waiting");
        }
        assertEq(handler.bidsAboveMarket(), 0, "a bid placed above the market");
        assertEq(handler.bidsAboveHalfGraduation(), 0, "a bid starting above half the graduation price");
        assertEq(handler.bidsOffReference(), 0, "a bid not placed from the pool's reference");
        assertEq(handler.referenceRose(), 0, "the reference moved back up");
        assertEq(handler.donations(), 0, "a donation landed");
    }

    /// @dev A graduated token's curve inventory is gone and its supply never grows.
    function invariant_supplyNeverGrows() public view {
        uint256 n = handler.tokensLength();
        for (uint256 i; i < n; ++i) {
            address t = handler.tokens(i);
            assertLe(IERC20(t).totalSupply(), 1_000_000_000e18);
            if (pad.isGraduated(t)) assertEq(IERC20(t).balanceOf(address(pad)), 0, "curve inventory gone");
        }
    }
}
