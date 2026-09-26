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
import {
    BeforeSwapDelta,
    BeforeSwapDeltaLibrary,
    toBeforeSwapDelta
} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolState} from "./libraries/PoolState.sol";
import {IArchitexLaunchHook} from "./interfaces/IArchitexLaunchHook.sol";

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
///   afterSwap keeps every fee in the PoolManager as the hook's ERC-6909 USDC claims (mint), credited to the token:
///   platform and creator fees until the launchpad releases them (`release`). A buy's snipe fee does not wait: the same
///   afterSwap turns it into a bid (below). A swap never moves USDC and never calls anything but the PoolManager, so it
///   works whatever the PoolManager's USDC float, whenever the buyer's router settles, and whatever happens to the
///   launchpad's address.
///
/// Bids: snipe fees become USDC-only liquidity below the price the moment they are collected, bids nobody can ever
/// withdraw. The curve's, at graduation, from half the graduation price down; a pool buy's, inside that buy, from half
/// the lowest price any window buy has started from (the graduation price to begin with; `bidRefTick`), down. That
/// reference only ever moves down, and a buy only moves the price up, so a bid is always wholly below the market when
/// it is placed and no sequence of buys (split, front-run or spread over blocks) can lift a later bid above where its
/// own dump ends; after a crash, bids follow the price down. Nothing is held for later but a unit or two of rounding,
/// which joins the next bid.
///
/// Positions: the graduation position is full range (salt 0); every bid gets a fresh salt, so a later bid never
/// touches an older position. Nobody may donate (a donation accrues fees to in-range positions, and a position that
/// has accrued fees folds them into its owner's next modifyLiquidity).
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
    /// @dev A bid starts this many ticks below the price it is placed from (the graduation price, or for a window buy the
    ///      lowest price any window buy has started from), about half of it: a sniper who dumps the moment the window
    ///      closes is not paid back out of his own surcharge (Argus's F-1), and no bid can be planted above the market.
    int24 public constant BID_DISCOUNT_TICKS = 6932;
    /// @dev A bid runs from its top down about 10,000 times (a multiple of the tick spacing), not to the extreme tick:
    ///      the extreme tick is shared with the full-range position, and an outside LP in an open pool could fill its
    ///      liquidity cap there cheaply enough to hold bids off. Almost all of a USDC-only range's USDC sits near its top
    ///      anyway.
    int24 public constant BID_SPAN_TICKS = 92_200;

    uint256 private constant _BPS = 10_000;
    uint8 private constant _OP_GRADUATE = 1;
    uint8 private constant _OP_RELEASE = 2;

    /// @inheritdoc IArchitexLaunchHook
    address public immutable launchpad;
    /// @inheritdoc IArchitexLaunchHook
    address public immutable usdc;

    mapping(PoolId => Launch) private _launches;
    /// @inheritdoc IArchitexLaunchHook
    mapping(address token => uint256) public lockHeld;
    /// @inheritdoc IArchitexLaunchHook
    mapping(address token => uint256) public pendingPlatform;
    /// @inheritdoc IArchitexLaunchHook
    mapping(address token => uint256) public pendingCreator;
    /// @inheritdoc IArchitexLaunchHook
    mapping(address token => uint256) public bidCount;
    /// @dev The pool's tick before the swap in progress, when that swap is a buy inside the snipe window: set in
    ///      beforeSwap, read in afterSwap, where the buy's snipe fee becomes a bid placed from this price.
    int24 private transient _tickBeforeBuy;

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
            beforeDonate: true,
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
            graduationTick: 0,
            bidRefTick: 0
        });
        liquidity = abi.decode(
            poolManager.unlock(abi.encode(_OP_GRADUATE, token, tokenAmount, usdcAmount, lockAmount)), (uint128)
        );
    }

    /// @inheritdoc IArchitexLaunchHook
    function release(address token) external returns (uint256 platformFee, uint256 creatorFee) {
        if (msg.sender != launchpad) revert OnlyLaunchpad();
        platformFee = pendingPlatform[token];
        creatorFee = pendingCreator[token];
        if (platformFee + creatorFee == 0) return (0, 0);
        pendingPlatform[token] = 0;
        pendingCreator[token] = 0;
        emit FeesReleased(token, platformFee, creatorFee);
        poolManager.unlock(abi.encode(_OP_RELEASE, token, platformFee + creatorFee, 0, 0));
    }

    /// @notice The PoolManager's callback for `graduate` and `release`, which run inside its unlock.
    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        (uint8 op, address token, uint256 a, uint256 b, uint256 c) =
            abi.decode(data, (uint8, address, uint256, uint256, uint256));
        if (op == _OP_GRADUATE) return abi.encode(_openPool(token, a, b, c));
        // Release: turn `a` of the hook's claims back into USDC, paid to the launchpad.
        poolManager.burn(address(this), _usdcId(), a);
        poolManager.take(Currency.wrap(usdc), launchpad, a);
        return "";
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
        l.bidRefTick = l.graduationTick;

        int24 lower = TickMath.minUsableTick(TICK_SPACING);
        int24 upper = TickMath.maxUsableTick(TICK_SPACING);
        liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96, TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), amount0, amount1
        );
        (BalanceDelta added,) = poolManager.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: lower, tickUpper: upper, liquidityDelta: int256(uint256(liquidity)), salt: 0
            }),
            ""
        );
        uint256 used0 = uint256(uint128(-added.amount0()));
        uint256 used1 = uint256(uint128(-added.amount1()));
        _pay(key.currency0, used0);
        _pay(key.currency1, used1);

        (uint256 tokensUsed, uint256 usdcUsed) = l.usdcIs0 ? (used1, used0) : (used0, used1);
        emit PoolOpened(token, poolId, sqrtPriceX96, tokensUsed, usdcUsed, liquidity, l.open);
        if (tokenAmount > tokensUsed) IBurnable(token).burn(tokenAmount - tokensUsed);
        // Everything else becomes claims, then the first bid, from half the graduation price down: the curve's snipe
        // fees and whatever USDC the position left.
        uint256 toLock = lockAmount + (usdcAmount - usdcUsed);
        if (toLock != 0) {
            _pay(Currency.wrap(usdc), toLock);
            poolManager.mint(address(this), _usdcId(), toLock);
            _placeBid(_launches[poolId], key, l.graduationTick, toLock);
        }
    }

    /// @dev Adds all the USDC claims held for `l.token` as a fresh position (its own salt) holding only USDC, from half the
    ///      price at `refTick` down BID_SPAN_TICKS, paid by burning claims. Called with the graduation price (at
    ///      graduation) and with a price no higher than the one just before a buy (inside that buy, which has since moved
    ///      the price up), so the range is always wholly on the USDC side of the current price.
    ///      What the position cannot take (a unit or two of rounding) stays held and joins the next bid.
    ///      `extra` is the new USDC (claims already minted) joining what is held; `lockHeld` is written only when what is
    ///      left over changes, so a bid that takes everything costs no storage write (a write and a refund would still
    ///      raise the gas a buy has to be sent with).
    function _placeBid(Launch memory l, PoolKey memory key, int24 refTick, uint256 extra) private {
        address token = l.token;
        uint256 held = lockHeld[token];
        uint256 amount = held + extra;
        (int24 lower, int24 upper) = _bidRange(l.usdcIs0, refTick);
        uint128 liquidity;
        // The range is empty only for a reference within a discount of the extreme tick, which no curve's pool reaches.
        if (lower < upper) {
            liquidity = l.usdcIs0
                ? LiquidityAmounts.getLiquidityForAmount0(
                    TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), amount
                )
                : LiquidityAmounts.getLiquidityForAmount1(
                    TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), amount
                );
        }
        if (liquidity == 0) {
            if (extra != 0) lockHeld[token] = amount;
            return;
        }
        uint256 salt = ++bidCount[token];
        (BalanceDelta added,) = poolManager.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: lower, tickUpper: upper, liquidityDelta: int256(uint256(liquidity)), salt: bytes32(salt)
            }),
            ""
        );
        // A fresh position has no fees, and a range wholly on the USDC side of the price takes USDC and nothing else.
        if ((l.usdcIs0 ? added.amount1() : added.amount0()) != 0) revert BidNotOneSided();
        uint256 used = uint256(uint128(-(l.usdcIs0 ? added.amount0() : added.amount1())));
        poolManager.burn(address(this), _usdcId(), used);
        if (amount - used != held) lockHeld[token] = amount - used;
        emit BidLocked(token, used, liquidity, lower, upper);
    }

    /// @dev The cheaper token price of two ticks: with USDC as currency0 a higher tick is a cheaper token.
    function _cheaperOf(bool usdcIs0, int24 a, int24 b) private pure returns (int24) {
        if (usdcIs0) return a > b ? a : b;
        return a < b ? a : b;
    }

    /// @dev A bid's range: its top about half the price at `refTick` (BID_DISCOUNT_TICKS past it, rounded away from the
    ///      price onto the tick spacing), its bottom BID_SPAN_TICKS further, clamped to the usable ticks. With USDC as
    ///      currency0 a higher tick is a cheaper token and a range above the current tick holds only currency0; with
    ///      USDC as currency1 it is the other way round.
    function _bidRange(bool usdcIs0, int24 refTick) private pure returns (int24 lower, int24 upper) {
        if (usdcIs0) {
            int24 maxTick = TickMath.maxUsableTick(TICK_SPACING);
            lower = _ceilTick(int256(refTick) + BID_DISCOUNT_TICKS + 1);
            upper = lower + BID_SPAN_TICKS > maxTick ? maxTick : lower + BID_SPAN_TICKS;
        } else {
            int24 minTick = TickMath.minUsableTick(TICK_SPACING);
            upper = _floorTick(int256(refTick) - BID_DISCOUNT_TICKS);
            lower = upper - BID_SPAN_TICKS < minTick ? minTick : upper - BID_SPAN_TICKS;
        }
    }

    // ─── Hook callbacks ───────────────────────────────────────────────────────

    /// @dev Only reached when someone other than the hook initializes a pool naming it: refused.
    function _beforeInitialize(address, PoolKey calldata, uint160) internal pure override returns (bytes4) {
        revert PoolCreationRestricted();
    }

    /// @dev Nobody donates: a donation accrues fees to in-range positions, and fees an owner has not asked for would
    ///      fold into its next modifyLiquidity.
    function _beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        internal
        pure
        override
        returns (bytes4)
    {
        revert DonationsRefused();
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
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        Launch memory l = _launch(key);
        bool isBuy = params.zeroForOne == l.usdcIs0;
        // A buy inside the window pays a snipe fee that afterSwap turns into a bid from the price before this buy.
        if (isBuy && _snipeBps(l) != 0) {
            (, int24 tick) = PoolState.getSlot0(poolManager, key.toId());
            _tickBeforeBuy = tick;
        }
        bool exactIn = params.amountSpecified < 0;
        if (exactIn != isBuy) return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        Fees memory f = _specifiedFees(l, isBuy, params.amountSpecified);
        int128 total = (f.platform + f.creator + f.snipe).toInt256().toInt128();
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(total, 0), 0);
    }

    function _afterSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) internal override returns (bytes4, int128) {
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
        // Only a buy inside the window pays a snipe fee, and its beforeSwap kept the price before it. Its bid starts from
        // the lowest price any window buy has started from, this one included (the graduation price to begin with): the
        // reference only moves down, so buys that lift the price cannot stack bids above where their dump will end
        // (Claude review #9, L1, and its residual after a crash), and after a crash bids follow the price down.
        if (f.snipe != 0) {
            int24 ref = _cheaperOf(l.usdcIs0, _tickBeforeBuy, l.bidRefTick);
            if (ref != l.bidRefTick) _launches[key.toId()].bidRefTick = ref;
            _placeBid(l, key, ref, f.snipe);
        }
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

    /// @dev Keeps every fee in the PoolManager as the hook's claims (which settles the hook's side of the swap without
    ///      moving any USDC) and credits them to the token.
    function _collect(address token, Fees memory f) private {
        poolManager.mint(address(this), _usdcId(), f.platform + f.creator + f.snipe);
        pendingPlatform[token] += f.platform;
        pendingCreator[token] += f.creator;
        // The snipe fee's claims are placed as a bid by the caller, in the same call (_placeBid books any rounding).
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

    function _usdcId() private view returns (uint256) {
        return uint256(uint160(usdc));
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
