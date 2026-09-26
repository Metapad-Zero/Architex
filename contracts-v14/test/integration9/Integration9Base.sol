// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {V4Quoter} from "@uniswap/v4-periphery/src/lens/V4Quoter.sol";
import {IV4Quoter} from "@uniswap/v4-periphery/src/interfaces/IV4Quoter.sol";
import {IV4Router} from "@uniswap/v4-periphery/src/interfaces/IV4Router.sol";
import {PathKey} from "@uniswap/v4-periphery/src/libraries/PathKey.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {ReentrancyLock} from "@uniswap/v4-periphery/src/base/ReentrancyLock.sol";
import {IArchitexLaunchHook} from "../../src/interfaces/IArchitexLaunchHook.sol";
import {PeripheryV4Router} from "./PeripheryV4Router.sol";
import {Review8Base} from "../review8/Review8Base.sol";

/// @dev Uniswap's V4Router (v4-periphery 1.0.3) made concrete the way its own MockV4Router is: the payer pays by
///      transferFrom, msgSender is the transient locker. The Universal Router's V4_SWAP runs the same V4Router code
///      (it only swaps Permit2 in for transferFrom).
contract TestV4Router is PeripheryV4Router, ReentrancyLock {
    using SafeERC20 for IERC20;

    constructor(IPoolManager manager_) PeripheryV4Router(manager_) {}

    function executeActions(bytes calldata params) external payable isNotLocked {
        _executeActions(params);
    }

    function _pay(Currency token, address payer, uint256 amount) internal override {
        if (payer == address(this)) IERC20(Currency.unwrap(token)).safeTransfer(address(poolManager), amount);
        else IERC20(Currency.unwrap(token)).safeTransferFrom(payer, address(poolManager), amount);
    }

    function msgSender() public view override returns (address) {
        return _getLocker();
    }
}

/// @dev The installed forge (1.8.1) returns the five-field Gas struct; this forge-std declares six, so it is read
///      through this local view of the same cheatcode.
interface VmGas5 {
    struct Gas5 {
        uint64 gasLimit;
        uint64 gasTotalUsed;
        uint64 gasMemoryUsed;
        int64 gasRefunded;
        uint64 gasRemaining;
    }

    function lastCallGas() external view returns (Gas5 memory);
}

/// @dev An 18-decimal ERC-20 for the unhooked pool that routes go through ("OTHER", think WETH).
contract MockToken18 is ERC20 {
    constructor() ERC20("Other", "OTHER") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Payment styles V4Router does not have: ERC-6909 claims as a swap's input or output, and a `sync` made before
///      the swap (so the hook's mid-swap liquidity add and claim mint/burn run between sync and settle).
contract ClaimsRouter is IUnlockCallback {
    using SafeERC20 for IERC20;

    IPoolManager public immutable manager;

    uint8 private constant _DEPOSIT = 0;
    uint8 private constant _WITHDRAW = 1;
    uint8 private constant _SWAP_CLAIMS = 2;
    uint8 private constant _SYNC_EARLY = 3;

    constructor(IPoolManager manager_) {
        manager = manager_;
    }

    /// @notice Pays `amount` of `currency` from the caller into the PoolManager and keeps it as this contract's claims.
    function deposit(Currency currency, uint256 amount) external {
        manager.unlock(abi.encode(_DEPOSIT, msg.sender, abi.encode(currency, amount)));
    }

    /// @notice Burns `amount` of this contract's claims and takes the currency to `to`.
    function withdraw(Currency currency, uint256 amount, address to) external {
        manager.unlock(abi.encode(_WITHDRAW, msg.sender, abi.encode(currency, amount, to)));
    }

    /// @notice Swaps, paying the input by burning this contract's claims and receiving the output as new claims.
    function swapWithClaims(PoolKey memory key, SwapParams memory params) external returns (BalanceDelta delta) {
        delta =
            abi.decode(manager.unlock(abi.encode(_SWAP_CLAIMS, msg.sender, abi.encode(key, params))), (BalanceDelta));
    }

    /// @notice sync(input) first, then swap, then transfer the input from the caller and settle, then take the output.
    function syncEarlySwap(PoolKey memory key, SwapParams memory params) external returns (BalanceDelta delta) {
        delta = abi.decode(manager.unlock(abi.encode(_SYNC_EARLY, msg.sender, abi.encode(key, params))), (BalanceDelta));
    }

    function claims(Currency currency) external view returns (uint256) {
        return manager.balanceOf(address(this), currency.toId());
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager), "only manager");
        (uint8 op, address payer, bytes memory inner) = abi.decode(data, (uint8, address, bytes));
        if (op == _DEPOSIT) {
            (Currency c, uint256 amount) = abi.decode(inner, (Currency, uint256));
            manager.sync(c);
            IERC20(Currency.unwrap(c)).safeTransferFrom(payer, address(manager), amount);
            manager.settle();
            manager.mint(address(this), c.toId(), amount);
            return "";
        }
        if (op == _WITHDRAW) {
            (Currency c, uint256 amount, address to) = abi.decode(inner, (Currency, uint256, address));
            manager.burn(address(this), c.toId(), amount);
            manager.take(c, to, amount);
            return "";
        }
        (PoolKey memory key, SwapParams memory params) = abi.decode(inner, (PoolKey, SwapParams));
        Currency input = params.zeroForOne ? key.currency0 : key.currency1;
        Currency output = params.zeroForOne ? key.currency1 : key.currency0;
        if (op == _SYNC_EARLY) manager.sync(input);
        BalanceDelta d = manager.swap(key, params, "");
        int128 inDelta = params.zeroForOne ? d.amount0() : d.amount1();
        int128 outDelta = params.zeroForOne ? d.amount1() : d.amount0();
        if (op == _SWAP_CLAIMS) {
            if (inDelta < 0) manager.burn(address(this), input.toId(), uint128(-inDelta));
            if (outDelta > 0) manager.mint(address(this), output.toId(), uint128(outDelta));
        } else {
            if (inDelta < 0) {
                IERC20(Currency.unwrap(input)).safeTransferFrom(payer, address(manager), uint128(-inDelta));
                manager.settle();
            }
            if (outDelta > 0) manager.take(output, payer, uint128(outDelta));
        }
        return abi.encode(d);
    }
}

/// @notice The v1.4 integration fixture (integration review #9, 2026-09-25; regression tests since 39a78b4): Uniswap's
///         own V4Quoter and V4Router (the code the Universal Router runs) against the etched Arc PoolManager, an
///         unhooked OTHER/USDC pool for multi-hop routes, and helpers that quote, execute and read the logs the way a
///         wallet, an aggregator or an indexer would. Window bids follow the hook's rule since 39a78b4: from half of
///         the cheaper of the buy's starting price and the pool's `bidRefTick`, which then moves there (only ever
///         down).
abstract contract Integration9Base is Review8Base {
    using PoolIdLibrary for PoolKey;

    bytes32 internal constant SWAP_SIG = keccak256("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");
    bytes32 internal constant MODIFY_SIG = keccak256("ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)");
    bytes32 internal constant TRADE_SIG =
        keccak256("PoolTrade(address,address,bool,uint256,uint256,uint256,uint256,uint256)");
    bytes32 internal constant BID_SIG = keccak256("BidLocked(address,uint256,uint128,int24,int24)");

    V4Quoter internal quoter;
    TestV4Router internal v4r;
    ClaimsRouter internal claimsRouter;
    MockToken18 internal other;
    PoolKey internal otherKey; // OTHER/USDC, 0.3%, spacing 60, no hook

    address internal erin = makeAddr("erin");

    struct Bid {
        uint256 usdc;
        uint128 liquidity;
        int24 lower;
        int24 upper;
    }

    struct Trade {
        address token;
        address sender;
        bool isBuy;
        uint256 usdcAmount;
        uint256 tokenAmount;
        uint256 platformFee;
        uint256 creatorFee;
        uint256 snipeFee;
    }

    struct SwapLog {
        bytes32 poolId;
        address sender;
        int128 amount0;
        int128 amount1;
        uint160 sqrtPriceX96;
        uint128 liquidity;
        int24 tick;
        uint24 fee;
    }

    function setUp() public virtual override {
        super.setUp();
        quoter = new V4Quoter(manager);
        v4r = new TestV4Router(manager);
        claimsRouter = new ClaimsRouter(manager);
        other = new MockToken18();

        address[6] memory actors = [alice, bob, carol, dave, erin, address(raw)];
        for (uint256 i; i < actors.length; ++i) {
            other.mint(actors[i], 1_000_000e18);
            if (actors[i] == erin) usdc.mint(erin, 100_000_000e6);
            vm.startPrank(actors[i]);
            usdc.approve(address(v4r), MAX);
            other.approve(address(v4r), MAX);
            usdc.approve(address(claimsRouter), MAX);
            other.approve(address(claimsRouter), MAX);
            usdc.approve(address(router), MAX);
            vm.stopPrank();
        }

        // OTHER/USDC at 2,000 USDC per OTHER, 5,000 OTHER and 10M USDC full range: a deep unhooked pool.
        bool usdcIs0 = address(usdc) < address(other);
        otherKey = PoolKey({
            currency0: Currency.wrap(usdcIs0 ? address(usdc) : address(other)),
            currency1: Currency.wrap(usdcIs0 ? address(other) : address(usdc)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
        (uint256 a0, uint256 a1) =
            usdcIs0 ? (uint256(10_000_000e6), uint256(5_000e18)) : (uint256(5_000e18), uint256(10_000_000e6));
        uint160 sqrtP = uint160(Math.sqrt(FullMath.mulDiv(a1, 1 << 192, a0)));
        manager.initialize(otherKey, sqrtP);
        int24 lo = TickMath.minUsableTick(60);
        int24 hi = TickMath.maxUsableTick(60);
        uint128 liq = LiquidityAmounts.getLiquidityForAmounts(
            sqrtP, TickMath.getSqrtPriceAtTick(lo), TickMath.getSqrtPriceAtTick(hi), a0 * 999 / 1000, a1 * 999 / 1000
        );
        raw.addLiquidity(otherKey, ModifyLiquidityParams(lo, hi, int256(uint256(liq)), 0));
    }

    // ─── Fixture ──────────────────────────────────────────────────────────────

    /// @dev A graduated token, returned in its graduation block (the pool's snipe window open at 90%). With
    ///      `curveSnipe` > 0, dave buys that much on the curve in its opening block, so a graduation bid exists.
    function _graduatedInWindow(uint16 creatorFeeBps, bool openPool, uint256 curveSnipe)
        internal
        returns (address token)
    {
        token = _graduateWithCurveSnipe(creatorFeeBps, openPool, dave, curveSnipe);
        _approveToken(token);
        uint256 room = hook.MAX_TOTAL_FEE_BPS() - hook.FEE_BPS() - creatorFeeBps;
        assertEq(hook.snipeBpsOf(token), room < 9000 ? room : 9000, "graduation block");
    }

    /// @dev A graduated token past the pool's window.
    function _graduatedAfterWindow(uint16 creatorFeeBps, bool openPool) internal returns (address token) {
        token = _graduated(creatorFeeBps, openPool);
        _approveToken(token);
        assertEq(hook.snipeBpsOf(token), 0, "window over");
    }

    function _approveToken(address token) internal {
        address[6] memory actors = [alice, bob, carol, dave, erin, address(raw)];
        for (uint256 i; i < actors.length; ++i) {
            vm.prank(actors[i]);
            IERC20(token).approve(address(v4r), MAX);
            vm.prank(actors[i]);
            IERC20(token).approve(address(claimsRouter), MAX);
        }
    }

    /// @dev Tokens for `who` from bob, who bought the curve out.
    function _fund(address token, address who, uint256 amount) internal {
        vm.prank(bob);
        IERC20(token).transfer(who, amount);
    }

    function _c(address a) internal pure returns (Currency) {
        return Currency.wrap(a);
    }

    // ─── Quoting (V4Quoter) ───────────────────────────────────────────────────

    function _single(PoolKey memory key, bool zeroForOne, uint256 amount)
        internal
        pure
        returns (IV4Quoter.QuoteExactSingleParams memory)
    {
        return IV4Quoter.QuoteExactSingleParams({
            poolKey: key, zeroForOne: zeroForOne, exactAmount: uint128(amount), hookData: ""
        });
    }

    function _quoteBuyIn(address token, uint256 usdcIn) internal returns (uint256 out, uint256 gasEst) {
        (out, gasEst) = quoter.quoteExactInputSingle(_single(_key(token), _usdcIs0(token), usdcIn));
    }

    function _quoteSellIn(address token, uint256 tokensIn) internal returns (uint256 out, uint256 gasEst) {
        (out, gasEst) = quoter.quoteExactInputSingle(_single(_key(token), !_usdcIs0(token), tokensIn));
    }

    function _quoteBuyOut(address token, uint256 tokensOut) internal returns (uint256 usdcIn, uint256 gasEst) {
        (usdcIn, gasEst) = quoter.quoteExactOutputSingle(_single(_key(token), _usdcIs0(token), tokensOut));
    }

    function _quoteSellOut(address token, uint256 usdcOut) internal returns (uint256 tokensIn, uint256 gasEst) {
        (tokensIn, gasEst) = quoter.quoteExactOutputSingle(_single(_key(token), !_usdcIs0(token), usdcOut));
    }

    // ─── Executing (V4Router: swap, then SETTLE_ALL and TAKE_ALL, the Universal Router's usual plan) ──────────

    function _plan3(uint256 a0, bytes memory p0, uint256 a1, bytes memory p1, uint256 a2, bytes memory p2)
        internal
        pure
        returns (bytes memory)
    {
        bytes memory actions = abi.encodePacked(uint8(a0), uint8(a1), uint8(a2));
        bytes[] memory params = new bytes[](3);
        (params[0], params[1], params[2]) = (p0, p1, p2);
        return abi.encode(actions, params);
    }

    function _exactInSinglePlan(PoolKey memory key, bool zeroForOne, uint256 amountIn, uint256 minOut)
        internal
        pure
        returns (bytes memory)
    {
        IV4Router.ExactInputSingleParams memory p = IV4Router.ExactInputSingleParams({
            poolKey: key,
            zeroForOne: zeroForOne,
            amountIn: uint128(amountIn),
            amountOutMinimum: uint128(minOut),
            hookData: ""
        });
        (Currency cin, Currency cout) = zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        return _plan3(
            Actions.SWAP_EXACT_IN_SINGLE,
            abi.encode(p),
            Actions.SETTLE_ALL,
            abi.encode(cin, amountIn),
            Actions.TAKE_ALL,
            abi.encode(cout, minOut)
        );
    }

    function _exactOutSinglePlan(PoolKey memory key, bool zeroForOne, uint256 amountOut, uint256 maxIn)
        internal
        pure
        returns (bytes memory)
    {
        IV4Router.ExactOutputSingleParams memory p = IV4Router.ExactOutputSingleParams({
            poolKey: key,
            zeroForOne: zeroForOne,
            amountOut: uint128(amountOut),
            amountInMaximum: uint128(maxIn),
            hookData: ""
        });
        (Currency cin, Currency cout) = zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        return _plan3(
            Actions.SWAP_EXACT_OUT_SINGLE,
            abi.encode(p),
            Actions.SETTLE_ALL,
            abi.encode(cin, maxIn),
            Actions.TAKE_ALL,
            abi.encode(cout, amountOut)
        );
    }

    /// @dev Runs `data` through V4Router as `trader`; returns what `trader` paid of `cin` and received of `cout`.
    function _exec(address trader, bytes memory data, Currency cin, Currency cout)
        internal
        returns (uint256 paid, uint256 got)
    {
        uint256 in0 = IERC20(Currency.unwrap(cin)).balanceOf(trader);
        uint256 out0 = IERC20(Currency.unwrap(cout)).balanceOf(trader);
        vm.prank(trader);
        v4r.executeActions(data);
        paid = in0 - IERC20(Currency.unwrap(cin)).balanceOf(trader);
        got = IERC20(Currency.unwrap(cout)).balanceOf(trader) - out0;
    }

    function _buyIn(address trader, address token, uint256 usdcIn, uint256 minOut) internal returns (uint256 got) {
        uint256 paid;
        (paid, got) = _exec(
            trader, _exactInSinglePlan(_key(token), _usdcIs0(token), usdcIn, minOut), _c(address(usdc)), _c(token)
        );
        assertEq(paid, usdcIn, "paid exactly the USDC in");
    }

    function _sellIn(address trader, address token, uint256 tokensIn, uint256 minOut) internal returns (uint256 got) {
        uint256 paid;
        (paid, got) = _exec(
            trader, _exactInSinglePlan(_key(token), !_usdcIs0(token), tokensIn, minOut), _c(token), _c(address(usdc))
        );
        assertEq(paid, tokensIn, "paid exactly the tokens in");
    }

    function _buyOut(address trader, address token, uint256 tokensOut, uint256 maxIn) internal returns (uint256 paid) {
        uint256 got;
        (paid, got) = _exec(
            trader, _exactOutSinglePlan(_key(token), _usdcIs0(token), tokensOut, maxIn), _c(address(usdc)), _c(token)
        );
        assertEq(got, tokensOut, "got exactly the tokens out");
    }

    function _sellOut(address trader, address token, uint256 usdcOut, uint256 maxIn) internal returns (uint256 paid) {
        uint256 got;
        (paid, got) = _exec(
            trader, _exactOutSinglePlan(_key(token), !_usdcIs0(token), usdcOut, maxIn), _c(token), _c(address(usdc))
        );
        assertEq(got, usdcOut, "got exactly the USDC out");
    }

    // ─── Paths (multi-hop) ────────────────────────────────────────────────────

    function _hopOther() internal pure returns (PathKey memory) {
        return PathKey({
            intermediateCurrency: Currency.wrap(address(0)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0)),
            hookData: ""
        });
    }

    /// @dev A PathKey into `to` through one of our pools (the other side is USDC or the token).
    function _hopOurs(address to) internal view returns (PathKey memory) {
        return PathKey({
            intermediateCurrency: Currency.wrap(to),
            fee: 0,
            tickSpacing: 200,
            hooks: IHooks(address(hook)),
            hookData: ""
        });
    }

    function _hopOtherTo(address to) internal pure returns (PathKey memory p) {
        p = _hopOther();
        p.intermediateCurrency = Currency.wrap(to);
    }

    function _path2(PathKey memory a, PathKey memory b) internal pure returns (PathKey[] memory p) {
        p = new PathKey[](2);
        (p[0], p[1]) = (a, b);
    }

    function _plan(uint256[] memory actions, bytes[] memory params) internal pure returns (bytes memory) {
        bytes memory a = new bytes(actions.length);
        for (uint256 i; i < actions.length; ++i) {
            a[i] = bytes1(uint8(actions[i]));
        }
        return abi.encode(a, params);
    }

    function _exactInPathPlan(Currency cin, PathKey[] memory path, uint256 amountIn, uint256 minOut, Currency cout)
        internal
        pure
        returns (bytes memory)
    {
        IV4Router.ExactInputParams memory p = IV4Router.ExactInputParams({
            currencyIn: cin, path: path, amountIn: uint128(amountIn), amountOutMinimum: uint128(minOut)
        });
        return _plan3(
            Actions.SWAP_EXACT_IN,
            abi.encode(p),
            Actions.SETTLE_ALL,
            abi.encode(cin, amountIn),
            Actions.TAKE_ALL,
            abi.encode(cout, minOut)
        );
    }

    function _exactOutPathPlan(Currency cout, PathKey[] memory path, uint256 amountOut, uint256 maxIn, Currency cin)
        internal
        pure
        returns (bytes memory)
    {
        IV4Router.ExactOutputParams memory p = IV4Router.ExactOutputParams({
            currencyOut: cout, path: path, amountOut: uint128(amountOut), amountInMaximum: uint128(maxIn)
        });
        return _plan3(
            Actions.SWAP_EXACT_OUT,
            abi.encode(p),
            Actions.SETTLE_ALL,
            abi.encode(cin, maxIn),
            Actions.TAKE_ALL,
            abi.encode(cout, amountOut)
        );
    }

    /// @dev Two tokens whose pools open in the same block (both windows at 90% when this returns).
    function _twoInWindow(uint16 feeA, uint16 feeB) internal returns (address a, address b) {
        a = _launch(feeA, creatorWallet, "", false, 0);
        vm.prank(alice);
        b = pad.createToken("Vfive", "VFV", "", feeB, creatorWallet, "", false, 0, 0, MAX);
        vm.prank(dave);
        pad.buy(a, 1_000e6, 0, dave, MAX); // curve snipe on A only: A gets a graduation bid
        _step(pad.SNIPE_BLOCKS());
        vm.startPrank(bob);
        pad.buy(a, 1_000_000e6, 0, bob, MAX);
        pad.buy(b, 1_000_000e6, 0, bob, MAX);
        vm.stopPrank();
        assertTrue(pad.isGraduated(a) && pad.isGraduated(b), "both graduated");
        _approveToken(a);
        _approveToken(b);
        assertEq(hook.snipeBpsOf(a), 9000);
        assertEq(hook.snipeBpsOf(b), 9000);
    }

    /// @dev Replays `logs` for `token`'s pool in order and checks every window buy's bid against the hook's rule (since
    ///      39a78b4): the bid starts from half of `ref = cheaper(tick before the buy, the pool's reference)`, and the
    ///      reference becomes `ref`, so it only ever moves down. `startTick` and `startRef` are the pool's tick and
    ///      `bidRefTick` before the logs; later ticks come from each Swap event (a bid never moves the price). Checks
    ///      the hook's stored reference against the replayed one at the end. Returns how many bids were checked and how
    ///      many of those buys started at a new low (moved the reference).
    function _checkBidsFollowReference(Vm.Log[] memory logs, address token, int24 startTick, int24 startRef)
        internal
        view
        returns (uint256 checked, uint256 newLows)
    {
        bytes32 pid = _pid(token);
        bool u0 = _usdcIs0(token);
        int24 tick = startTick;
        int24 ref = startRef;
        bool pending;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == SWAP_SIG && logs[i].topics[1] == pid) {
                assertFalse(pending, "a buy's bid comes before the next swap");
                (int128 a0, int128 a1,,, int24 tickAfter,) =
                    abi.decode(logs[i].data, (int128, int128, uint160, uint128, int24, uint24));
                int128 usdcDelta = u0 ? a0 : a1;
                // A buy (USDC in: negative for the swapper) inside the window places a bid.
                if (usdcDelta < 0 && hook.snipeBpsOf(token) != 0) {
                    int24 next = _cheaperTick(u0, tick, ref);
                    if (next != ref) newLows++;
                    ref = next;
                    pending = true;
                }
                tick = tickAfter;
            } else if (logs[i].topics[0] == BID_SIG && address(uint160(uint256(logs[i].topics[1]))) == token) {
                assertTrue(pending, "a bid only right after a buy");
                (,, int24 lo, int24 hi) = abi.decode(logs[i].data, (uint256, uint128, int24, int24));
                (int24 elo, int24 ehi) = _expectedBid(u0, ref);
                assertEq(lo, elo, "bid lower from the cheaper of this buy's start and the pool's reference");
                assertEq(hi, ehi, "bid upper from the cheaper of this buy's start and the pool's reference");
                pending = false;
                checked++;
            }
        }
        assertFalse(pending, "every window buy placed its bid");
        assertEq(_refTick(token), ref, "the hook's stored reference is the replayed one");
    }

    /// @dev The pool's bid reference (`bidRefTick`, the last of Launch's seven fields): the lowest price any window buy
    ///      has started from, the graduation price to begin with.
    function _refTick(address token) internal view returns (int24) {
        (, IArchitexLaunchHook.Launch memory l) = hook.launchOf(token);
        return l.bidRefTick;
    }

    /// @dev A tick's gross liquidity in `token`'s pool (0: the tick is not initialized).
    function _tickGross(address token, int24 t) internal view returns (uint128 gross) {
        (gross,) = StateLibrary.getTickLiquidity(manager, _key(token).toId(), t);
    }

    /// @dev The cheaper token price of two ticks: with USDC as currency0 a higher tick is a cheaper token.
    function _cheaperTick(bool usdcIs0, int24 a, int24 b) internal pure returns (int24) {
        if (usdcIs0) return a > b ? a : b;
        return a < b ? a : b;
    }

    // ─── Logs ─────────────────────────────────────────────────────────────────

    function _bids(Vm.Log[] memory logs, address token) internal pure returns (Bid[] memory out) {
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == BID_SIG && address(uint160(uint256(logs[i].topics[1]))) == token) n++;
        }
        out = new Bid[](n);
        n = 0;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != BID_SIG || address(uint160(uint256(logs[i].topics[1]))) != token) continue;
            (out[n].usdc, out[n].liquidity, out[n].lower, out[n].upper) =
                abi.decode(logs[i].data, (uint256, uint128, int24, int24));
            n++;
        }
    }

    function _trades(Vm.Log[] memory logs, address token) internal pure returns (Trade[] memory out) {
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == TRADE_SIG && address(uint160(uint256(logs[i].topics[1]))) == token) n++;
        }
        out = new Trade[](n);
        n = 0;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != TRADE_SIG || address(uint160(uint256(logs[i].topics[1]))) != token) continue;
            out[n].token = token;
            out[n].sender = address(uint160(uint256(logs[i].topics[2])));
            (
                out[n].isBuy,
                out[n].usdcAmount,
                out[n].tokenAmount,
                out[n].platformFee,
                out[n].creatorFee,
                out[n].snipeFee
            ) = abi.decode(logs[i].data, (bool, uint256, uint256, uint256, uint256, uint256));
            n++;
        }
    }

    function _swaps(Vm.Log[] memory logs, bytes32 poolId) internal pure returns (SwapLog[] memory out) {
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == SWAP_SIG && logs[i].topics[1] == poolId) n++;
        }
        out = new SwapLog[](n);
        n = 0;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != SWAP_SIG || logs[i].topics[1] != poolId) continue;
            out[n].poolId = poolId;
            out[n].sender = address(uint160(uint256(logs[i].topics[2])));
            (out[n].amount0, out[n].amount1, out[n].sqrtPriceX96, out[n].liquidity, out[n].tick, out[n].fee) =
                abi.decode(logs[i].data, (int128, int128, uint160, uint128, int24, uint24));
            n++;
        }
    }

    function _pid(address token) internal view returns (bytes32) {
        return PoolId.unwrap(_key(token).toId());
    }

    /// @dev A bid's range from `ref` (V14-SPEC §5), recomputed independently of the hook.
    function _expectedBid(bool usdcIs0, int24 ref) internal view returns (int24 lower, int24 upper) {
        int24 d = hook.BID_DISCOUNT_TICKS();
        int24 span = hook.BID_SPAN_TICKS();
        if (usdcIs0) {
            lower = _ceil200(int256(ref) + d + 1);
            upper = lower + span;
        } else {
            upper = _floor200(int256(ref) - d);
            lower = upper - span;
        }
    }

    /// @dev Everything the hook holds for `token` that a quote must not touch (the bid reference included).
    function _hookState(address token) internal view returns (bytes32) {
        (, int24 tick) = _slot0(token);
        return keccak256(
            abi.encode(
                _refTick(token),
                hook.bidCount(token),
                hook.lockHeld(token),
                hook.pendingPlatform(token),
                hook.pendingCreator(token),
                _hookClaims(),
                tick,
                usdc.balanceOf(POOL_MANAGER)
            )
        );
    }

    // ─── Gas limits ───────────────────────────────────────────────────────────

    /// @dev Whether `trader`'s V4Router call succeeds from the current state with a transaction gas limit of `limit`
    ///      (state restored). Under forge 1.8.1's default isolation a top-level `call{gas: g}` runs as a transaction
    ///      whose limit is g + 21,000 (measured: a bare storage bump needs exactly its receipt gasUsed minus 21,000).
    function _succeedsWithin(address trader, address token, bytes memory data, uint256 limit)
        internal
        returns (bool ok)
    {
        bytes memory call = abi.encodeCall(TestV4Router.executeActions, (data));
        uint256 snap = vm.snapshotState();
        _cool(token);
        vm.prank(trader, trader);
        (ok,) = address(v4r).call{gas: limit - 21_000}(call);
        vm.revertToStateAndDelete(snap);
    }

    /// @dev The smallest transaction gas limit that lets `trader`'s V4Router call succeed from the current state: what
    ///      eth_estimateGas searches for.
    function _txLimit(address trader, address token, bytes memory data) internal returns (uint256) {
        uint256 lo = 51_000;
        uint256 hi = 3_021_000;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (_succeedsWithin(trader, token, data, mid)) hi = mid;
            else lo = mid + 1;
        }
        return lo;
    }

    /// @dev Whether top-level calls run as isolated transactions (forge 1.8.1's default): an approve that changes
    ///      nothing costs a few thousand gas as a frame, and over 21,000 as a transaction (intrinsic gas included).
    function _isolated() internal returns (bool) {
        other.approve(address(1), 1);
        other.approve(address(1), 1);
        return VmGas5(address(vm)).lastCallGas().gasTotalUsed >= 21_000;
    }

    /// @dev Every account a swap touches made cold, as at the start of a fresh transaction.
    function _cool(address token) internal {
        vm.cool(POOL_MANAGER);
        vm.cool(address(hook));
        vm.cool(address(usdc));
        vm.cool(token);
        vm.cool(address(v4r));
        vm.cool(address(quoter));
        vm.cool(address(other));
        vm.cool(address(pad));
    }
}
