// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary, toBeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolState} from "./libraries/PoolState.sol";
import {IArchitexLaunchHook} from "./interfaces/IArchitexLaunchHook.sol";

/// @dev The two launchpad functions the hook calls.
interface ILaunchpadHookSide {
    function accrueTradeFees(address token, uint256 platformFee, uint256 creatorFee) external;
}

interface IBurnable {
    function burn(uint256 amount) external;
}

/// @title ArchitexLaunchHook
/// @notice See IArchitexLaunchHook and V14-SPEC §3.
///
/// Fees, in USDC on both sides of every swap, rounded up (never in the trader's favour), matching v1.3's launch router:
///   - USDC is the side the trader fixed (an exact-in buy, an exact-out sell): the fees are taken in beforeSwap by a
///     specified delta, so the pool swaps what is left of the trader's USDC, or pays out the USDC plus the fees;
///   - otherwise (an exact-in sell, an exact-out buy): in afterSwap by an unspecified delta, on the USDC the pool paid
///     out or needed.
///   Fees on a known gross amount are each ceil(gross * bps / 1e4). On a net amount (the pool's side), gross = net +
///   ceil(net * r / (1e4 - r)) with r the total bps, and the total splits platform first, creator next, the snipe fee
///   last, each rounded up and capped by what is left (v1.3's exact-fill split).
///   afterSwap moves the platform and creator fees to the launchpad and credits them there (accrueTradeFees); the
///   snipe fee stays here, credited to the token, until `lock` puts it in the pool. Nothing is ever pushed to a
///   creator, a plugin or anyone else during a swap.
///
/// A swap the pool cannot fill in full (a price limit) is refused when the fees were fixed on the trader's own amount
/// (PartialFill), so a trader never pays fees on USDC the pool did not take or give.
///
/// Swaps and liquidity changes the hook makes as itself skip its callbacks (v4-core's noSelfCall). The hook only ever
/// initializes pools and adds liquidity as itself; it never swaps.
contract ArchitexLaunchHook is BaseHook, IUnlockCallback, IArchitexLaunchHook {
    using PoolIdLibrary for PoolKey;
    using SafeERC20 for IERC20;
    using SafeCast for uint256;
    using SafeCast for int256;

    /// @inheritdoc IArchitexLaunchHook
    uint24 public constant LP_FEE = 0;
    /// @inheritdoc IArchitexLaunchHook
    int24 public constant TICK_SPACING = 200;
    /// @inheritdoc IArchitexLaunchHook
    uint256 public constant FEE_BPS = 50;
    /// @inheritdoc IArchitexLaunchHook
    uint256 public constant SNIPE_BLOCKS = 20;
    /// @inheritdoc IArchitexLaunchHook
    uint256 public constant SNIPE_START_BPS = 9000;
    /// @inheritdoc IArchitexLaunchHook
    uint256 public constant MAX_TOTAL_FEE_BPS = 9900;
    /// @dev A locked bid starts this many ticks below the reference price, about half of it: a sniper who dumps the
    ///      moment the window closes is not paid back out of his own surcharge (Argus's F-1), and pushing the price
    ///      before a `lock` cannot move the bid anywhere worth selling into.
    int24 public constant BID_DISCOUNT_TICKS = 6932;

    uint256 private constant _BPS = 10_000;
    uint8 private constant _OP_GRADUATE = 1;
    uint8 private constant _OP_LOCK = 2;

    /// @inheritdoc IArchitexLaunchHook
    address public immutable launchpad;
    /// @inheritdoc IArchitexLaunchHook
    address public immutable usdc;

    mapping(PoolId => Launch) private _launches;
    /// @inheritdoc IArchitexLaunchHook
    mapping(address token => uint256) public lockHeld;

    struct Fees {
        uint256 platform;
        uint256 creator;
        uint256 snipe;
    }

    error PartialFill();

    constructor(IPoolManager manager, address launchpad_, address usdc_) BaseHook(manager) {
        launchpad = launchpad_;
        usdc = usdc_;
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: true,
            afterInitialize: false,
            beforeAddLiquidity: true,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: true,
            afterSwapReturnDelta: true,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // ─── Graduation and locking ───────────────────────────────────────────────

    /// @inheritdoc IArchitexLaunchHook
    function graduate(
        address token,
        uint256 tokenAmount,
        uint256 usdcAmount,
        uint256 lockAmount,
        bool open,
        uint16 creatorFeeBps
    ) external returns (PoolId poolId, uint128 liquidity) {
        if (msg.sender != launchpad) revert OnlyLaunchpad();
        poolId = _keyFor(token).toId();
        if (_launches[poolId].token != address(0)) revert AlreadyOpened();
        _launches[poolId] = Launch({
            token: token,
            usdcIs0: usdc < token,
            open: open,
            creatorFeeBps: creatorFeeBps,
            openBlock: uint64(block.number),
            graduationTick: 0
        });
        liquidity = abi.decode(
            poolManager.unlock(abi.encode(_OP_GRADUATE, token, tokenAmount, usdcAmount, lockAmount)), (uint128)
        );
    }

    /// @inheritdoc IArchitexLaunchHook
    function lock(address token) external returns (uint128 liquidity) {
        if (_launches[_keyFor(token).toId()].token == address(0)) revert UnknownLaunch();
        if (lockHeld[token] == 0) revert NothingToLock();
        liquidity = abi.decode(poolManager.unlock(abi.encode(_OP_LOCK, token, 0, 0, 0)), (uint128));
    }

    /// @notice The PoolManager's callback for `graduate` and `lock`, which run inside its unlock.
    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        (uint8 op, address token, uint256 tokenAmount, uint256 usdcAmount, uint256 lockAmount) =
            abi.decode(data, (uint8, address, uint256, uint256, uint256));
        if (op == _OP_GRADUATE) return abi.encode(_openPool(token, tokenAmount, usdcAmount, lockAmount));
        return abi.encode(_lockBid(token));
    }

    /// @dev Initializes the pool at the amounts' own price and adds them as one full-range position owned by the hook.
    function _openPool(address token, uint256 tokenAmount, uint256 usdcAmount, uint256 lockAmount)
        private
        returns (uint128 liquidity)
    {
        PoolKey memory key = _keyFor(token);
        PoolId poolId = key.toId();
        Launch storage l = _launches[poolId];
        (uint256 amount0, uint256 amount1) = l.usdcIs0 ? (usdcAmount, tokenAmount) : (tokenAmount, usdcAmount);

        uint160 sqrtPriceX96 = _sqrtPriceX96(amount0, amount1);
        l.graduationTick = poolManager.initialize(key, sqrtPriceX96);

        int24 lower = TickMath.minUsableTick(TICK_SPACING);
        int24 upper = TickMath.maxUsableTick(TICK_SPACING);
        liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96, TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), amount0, amount1
        );
        (BalanceDelta added,) = poolManager.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: lower, tickUpper: upper, liquidityDelta: int256(uint256(liquidity)), salt: 0}),
            ""
        );
        uint256 used0 = uint256(uint128(-added.amount0()));
        uint256 used1 = uint256(uint128(-added.amount1()));
        _pay(key.currency0, used0);
        _pay(key.currency1, used1);

        (uint256 tokensUsed, uint256 usdcUsed) = l.usdcIs0 ? (used1, used0) : (used0, used1);
        emit PoolOpened(token, poolId, sqrtPriceX96, tokensUsed, usdcUsed, liquidity, l.open);
        if (tokenAmount > tokensUsed) IBurnable(token).burn(tokenAmount - tokensUsed);
        uint256 toLock = lockAmount + (usdcAmount - usdcUsed);
        if (toLock != 0) {
            lockHeld[token] += toLock;
            _lockBid(token);
        }
    }

    /// @dev Adds the USDC held for `token` as a position that holds only USDC, from half the reference price (the lower
    ///      of the current and the graduation price) all the way down. Anything the position cannot take stays held.
    function _lockBid(address token) private returns (uint128 liquidity) {
        uint256 amount = lockHeld[token];
        PoolKey memory key = _keyFor(token);
        Launch memory l = _launches[key.toId()];
        (, int24 tick) = PoolState.getSlot0(poolManager, key.toId());
        (int24 lower, int24 upper, bool ok) = _bidRange(l, tick);
        if (!ok) return 0;
        uint160 sqrtA = TickMath.getSqrtPriceAtTick(lower);
        uint160 sqrtB = TickMath.getSqrtPriceAtTick(upper);
        liquidity = l.usdcIs0
            ? LiquidityAmounts.getLiquidityForAmount0(sqrtA, sqrtB, amount)
            : LiquidityAmounts.getLiquidityForAmount1(sqrtA, sqrtB, amount);
        if (liquidity == 0) return 0;
        (BalanceDelta added,) = poolManager.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: lower, tickUpper: upper, liquidityDelta: int256(uint256(liquidity)), salt: 0}),
            ""
        );
        uint256 used = uint256(uint128(-(l.usdcIs0 ? added.amount0() : added.amount1())));
        _pay(Currency.wrap(usdc), used);
        lockHeld[token] = amount - used;
        emit BidLocked(token, used, liquidity, lower, upper);
    }

    /// @dev The range of a USDC-only bid. With USDC as currency0 a higher tick is a cheaper token, and a position above
    ///      the current tick holds only currency0; with USDC as currency1 it is the other way round.
    function _bidRange(Launch memory l, int24 tick) private pure returns (int24 lower, int24 upper, bool ok) {
        if (l.usdcIs0) {
            int24 ref = tick > l.graduationTick ? tick : l.graduationTick;
            lower = _ceilTick(int256(ref) + BID_DISCOUNT_TICKS + 1);
            upper = TickMath.maxUsableTick(TICK_SPACING);
        } else {
            int24 ref = tick < l.graduationTick ? tick : l.graduationTick;
            lower = TickMath.minUsableTick(TICK_SPACING);
            upper = _floorTick(int256(ref) - BID_DISCOUNT_TICKS);
        }
        ok = lower < upper && lower >= TickMath.minUsableTick(TICK_SPACING) && upper <= TickMath.maxUsableTick(TICK_SPACING);
    }

    // ─── Hook callbacks ───────────────────────────────────────────────────────

    /// @dev Only reached when someone other than the hook initializes a pool naming it: refused.
    function _beforeInitialize(address, PoolKey calldata, uint160) internal pure override returns (bytes4) {
        revert PoolCreationRestricted();
    }

    /// @dev Only reached for liquidity from someone other than the hook.
    function _beforeAddLiquidity(address, PoolKey calldata key, ModifyLiquidityParams calldata, bytes calldata)
        internal
        view
        override
        returns (bytes4)
    {
        Launch storage l = _launches[key.toId()];
        if (l.token == address(0) || !l.open) revert ClosedPool();
        return IHooks.beforeAddLiquidity.selector;
    }

    function _beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        internal
        view
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        Launch memory l = _launch(key);
        bool isBuy = params.zeroForOne == l.usdcIs0;
        bool exactIn = params.amountSpecified < 0;
        if (exactIn != isBuy) return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        Fees memory f = _specifiedFees(l, isBuy, params.amountSpecified);
        int128 total = (f.platform + f.creator + f.snipe).toInt256().toInt128();
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(total, 0), 0);
    }

    function _afterSwap(address sender, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        internal
        override
        returns (bytes4, int128)
    {
        Launch memory l = _launch(key);
        bool isBuy = params.zeroForOne == l.usdcIs0;
        bool exactIn = params.amountSpecified < 0;
        int256 usdcDelta = l.usdcIs0 ? delta.amount0() : delta.amount1();
        int256 tokenDelta = l.usdcIs0 ? delta.amount1() : delta.amount0();

        Fees memory f;
        uint256 gross;
        int128 unspecified;
        if (exactIn == isBuy) {
            // The fees were fixed on the trader's own USDC in beforeSwap; recomputed here, identically.
            f = _specifiedFees(l, isBuy, params.amountSpecified);
            uint256 total = f.platform + f.creator + f.snipe;
            if (isBuy) {
                gross = uint256(-params.amountSpecified);
                if (uint256(-usdcDelta) != gross - total) revert PartialFill();
            } else {
                gross = uint256(params.amountSpecified) + total;
                if (uint256(usdcDelta) != gross) revert PartialFill();
            }
        } else if (isBuy) {
            // Exact-out buy: the pool needed `net` USDC; the trader pays it plus the fees.
            uint256 net = uint256(-usdcDelta);
            f = _feesOnNet(net, l.creatorFeeBps, _snipeBps(l));
            uint256 total = f.platform + f.creator + f.snipe;
            gross = net + total;
            unspecified = total.toInt256().toInt128();
        } else {
            // Exact-in sell: the fees come out of the USDC the pool paid.
            gross = uint256(usdcDelta);
            f = _feesOnGross(gross, l.creatorFeeBps, 0);
            unspecified = (f.platform + f.creator).toInt256().toInt128();
        }

        _collect(l.token, f);
        emit PoolTrade(
            l.token,
            sender,
            isBuy,
            gross,
            tokenDelta < 0 ? uint256(-tokenDelta) : uint256(tokenDelta),
            f.platform,
            f.creator,
            f.snipe
        );
        return (IHooks.afterSwap.selector, unspecified);
    }

    // ─── Fees ─────────────────────────────────────────────────────────────────

    /// @dev Fees when USDC is the side the trader fixed: on the gross USDC in of an exact-in buy, or on the net USDC out
    ///      of an exact-out sell.
    function _specifiedFees(Launch memory l, bool isBuy, int256 amountSpecified) private view returns (Fees memory) {
        if (isBuy) return _feesOnGross(uint256(-amountSpecified), l.creatorFeeBps, _snipeBps(l));
        return _feesOnNet(uint256(amountSpecified), l.creatorFeeBps, 0);
    }

    function _feesOnGross(uint256 gross, uint256 creatorBps, uint256 snipeBps) private pure returns (Fees memory f) {
        f.platform = _divCeil(gross * FEE_BPS, _BPS);
        f.creator = _divCeil(gross * creatorBps, _BPS);
        f.snipe = _divCeil(gross * snipeBps, _BPS);
        if (f.platform + f.creator + f.snipe >= gross) revert FeesExceedAmount();
    }

    function _feesOnNet(uint256 net, uint256 creatorBps, uint256 snipeBps) private pure returns (Fees memory f) {
        if (net == 0) revert FeesExceedAmount();
        uint256 r = FEE_BPS + creatorBps + snipeBps;
        uint256 total = _divCeil(net * r, _BPS - r);
        f.platform = _divCeil(total * FEE_BPS, r);
        f.creator = Math.min(_divCeil(total * creatorBps, r), total - f.platform);
        f.snipe = total - f.platform - f.creator;
    }

    /// @dev The surcharge a buy pays in this block: SNIPE_START_BPS in the pool's opening block, falling linearly to 0
    ///      after SNIPE_BLOCKS, and never more than leaves the total under MAX_TOTAL_FEE_BPS.
    function _snipeBps(Launch memory l) private view returns (uint256 bps) {
        uint256 end = uint256(l.openBlock) + SNIPE_BLOCKS;
        if (block.number >= end) return 0;
        bps = SNIPE_START_BPS * (end - block.number) / SNIPE_BLOCKS;
        uint256 room = MAX_TOTAL_FEE_BPS - FEE_BPS - l.creatorFeeBps;
        if (bps > room) bps = room;
    }

    /// @dev Takes the platform and creator fees to the launchpad and credits them there; keeps the snipe fee here.
    function _collect(address token, Fees memory f) private {
        Currency u = Currency.wrap(usdc);
        uint256 toLaunchpad = f.platform + f.creator;
        if (toLaunchpad != 0) {
            poolManager.take(u, launchpad, toLaunchpad);
            ILaunchpadHookSide(launchpad).accrueTradeFees(token, f.platform, f.creator);
        }
        if (f.snipe != 0) {
            poolManager.take(u, address(this), f.snipe);
            lockHeld[token] += f.snipe;
        }
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    /// @inheritdoc IArchitexLaunchHook
    function poolKeyOf(address token) external view returns (PoolKey memory) {
        return _keyFor(token);
    }

    /// @inheritdoc IArchitexLaunchHook
    function launchOf(address token) external view returns (PoolId poolId, Launch memory launch) {
        poolId = _keyFor(token).toId();
        launch = _launches[poolId];
        if (launch.token == address(0)) revert UnknownLaunch();
    }

    /// @inheritdoc IArchitexLaunchHook
    function snipeBpsOf(address token) external view returns (uint256) {
        Launch memory l = _launches[_keyFor(token).toId()];
        if (l.token == address(0)) revert UnknownLaunch();
        return _snipeBps(l);
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    function _keyFor(address token) private view returns (PoolKey memory) {
        (address c0, address c1) = usdc < token ? (usdc, token) : (token, usdc);
        return PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: LP_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(this))
        });
    }

    function _launch(PoolKey calldata key) private view returns (Launch memory l) {
        l = _launches[key.toId()];
        if (l.token == address(0)) revert UnknownLaunch();
    }

    /// @dev Pays what the hook owes the PoolManager in an ERC-20: sync, transfer, settle (an unsynced settle would be
    ///      read as native USDC on Arc).
    function _pay(Currency currency, uint256 amount) private {
        if (amount == 0) return;
        poolManager.sync(currency);
        IERC20(Currency.unwrap(currency)).safeTransfer(address(poolManager), amount);
        poolManager.settle();
    }

    /// @dev sqrt(amount1 / amount0) in Q64.96: the price at which a full-range position takes both amounts.
    function _sqrtPriceX96(uint256 amount0, uint256 amount1) private pure returns (uint160) {
        uint256 ratioX192 = FullMath.mulDiv(amount1, 1 << 192, amount0);
        return Math.sqrt(ratioX192).toUint160();
    }

    function _floorTick(int256 tick) private pure returns (int24) {
        int256 spacing = TICK_SPACING;
        int256 compressed = tick / spacing;
        if (tick < 0 && tick % spacing != 0) compressed--;
        return int24(compressed * spacing);
    }

    function _ceilTick(int256 tick) private pure returns (int24) {
        int256 spacing = TICK_SPACING;
        int256 compressed = tick / spacing;
        if (tick > 0 && tick % spacing != 0) compressed++;
        return int24(compressed * spacing);
    }

    function _divCeil(uint256 a, uint256 b) private pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }
}
