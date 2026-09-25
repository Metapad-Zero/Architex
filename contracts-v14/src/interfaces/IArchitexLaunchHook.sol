// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";

/// @title IArchitexLaunchHook
/// @notice The Uniswap v4 hook every graduated v1.4 launch token trades behind (V14-SPEC §3). One hook, one pool per
///         token: the launch token against USDC (the ERC-20 at 0x3600…), LP fee 0, tick spacing 200.
///
///         On every swap it takes, in USDC and rounded up, the launchpad's 0.5% platform fee and the token's creator
///         fee, as v1.3's launch router did, but it never moves USDC during a swap: the fees stay in the PoolManager as
///         the hook's ERC-6909 claims until the launchpad releases them (`release`, from its `syncPoolFees` or a
///         collection). For SNIPE_BLOCKS blocks after a pool opens, buys also pay a surcharge that starts at
///         SNIPE_START_BPS and falls to 0 block by block; it is held as claims and locked into the pool as USDC-only
///         liquidity below half the graduation price (V14-SPEC §5), so nobody can ever withdraw it.
///
///         Only the launchpad opens pools with this hook (at graduation), and only the hook itself adds liquidity to a
///         closed pool; an open pool (the creator's choice at launch) takes anyone's liquidity. Nobody may donate to a
///         pool. The hook owns every position it adds, gives every bid a position of its own, and has no way to remove
///         one.
interface IArchitexLaunchHook {
    /// @notice A launch token's pool and what the hook needs for its swaps.
    struct Launch {
        address token;
        bool usdcIs0; // USDC sorts below the token: it is currency0
        bool open; // anyone may add liquidity
        uint16 creatorFeeBps;
        uint64 openBlock; // the graduation block; the snipe window counts from here
        int24 graduationTick; // the pool's tick at graduation, the reference for locked bids
    }

    /// @notice The pool opened at graduation, with the locked full-range position.
    event PoolOpened(
        address indexed token,
        PoolId indexed poolId,
        uint160 sqrtPriceX96,
        uint256 tokensAdded,
        uint256 usdcAdded,
        uint128 liquidity,
        bool open
    );
    /// @notice One swap in a launch pool, with the fees it paid. `usdcAmount` is gross: what the pool received on a buy
    ///         (fees on top, paid by the trader) or paid out on a sell (fees taken from it). `sender` is whoever called
    ///         the PoolManager (a router), not necessarily the trader.
    event PoolTrade(
        address indexed token,
        address indexed sender,
        bool isBuy,
        uint256 usdcAmount,
        uint256 tokenAmount,
        uint256 platformFee,
        uint256 creatorFee,
        uint256 snipeFee
    );
    /// @notice USDC locked into a pool as a bid that nobody can withdraw.
    event BidLocked(address indexed token, uint256 usdc, uint128 liquidity, int24 tickLower, int24 tickUpper);
    /// @notice Pool fees paid out of the hook's claims to the launchpad, which books them.
    event FeesReleased(address indexed token, uint256 platformFee, uint256 creatorFee);

    error OnlyLaunchpad();
    error PoolCreationRestricted();
    error ClosedPool();
    error UnknownLaunch();
    error AlreadyOpened();
    error FeesExceedAmount();
    error NothingToLock();
    error DonationsRefused();
    error BidNotOneSided();

    /// @notice 0: pools charge no LP fee; the platform and creator fees are the hook's.
    function LP_FEE() external view returns (uint24);
    /// @notice 200.
    function TICK_SPACING() external view returns (int24);
    /// @notice 50 (0.5%), the launchpad's platform fee.
    function FEE_BPS() external view returns (uint256);
    /// @notice 20 blocks (about 10 seconds on Arc).
    function SNIPE_BLOCKS() external view returns (uint256);
    /// @notice 9,000 (90%): the surcharge on a buy in the pool's opening block.
    function SNIPE_START_BPS() external view returns (uint256);
    /// @notice 9,900: platform, creator and snipe fees together take at most 99% of a trade.
    function MAX_TOTAL_FEE_BPS() external view returns (uint256);
    /// @notice 6,932 ticks, about half the price: a bid's top sits this far below the graduation price.
    function BID_DISCOUNT_TICKS() external view returns (int24);
    /// @notice 92,200 ticks, about 10,000 times: how far down a bid runs from its top.
    function BID_SPAN_TICKS() external view returns (int24);

    function launchpad() external view returns (address);
    function usdc() external view returns (address);

    /// @notice Opens `token`'s pool at the price of the amounts given and locks them in one full-range position, then
    ///         locks `lockAmount` (the curve's snipe fees) as a bid. Launchpad only, inside the sell-out buy, after it
    ///         has sent the hook `tokenAmount` tokens and `usdcAmount + lockAmount` USDC. Tokens the position cannot
    ///         take are burned; USDC it cannot take joins the bid.
    function graduate(
        address token,
        uint256 tokenAmount,
        uint256 usdcAmount,
        uint256 lockAmount,
        bool open,
        uint16 creatorFeeBps
    ) external returns (PoolId poolId, uint128 liquidity);

    /// @notice Locks the snipe fees held for `token` into its pool as a bid. Anyone may call it. Does nothing (returns 0)
    ///         while the price is below the bid's top: the USDC waits for the price to come back.
    function lock(address token) external returns (uint128 liquidity);

    /// @notice Launchpad only: pays `token`'s pool fees out of the hook's claims to the launchpad and returns them.
    function release(address token) external returns (uint256 platformFee, uint256 creatorFee);

    /// @notice USDC claims held for `token`, waiting to be locked by `lock`.
    function lockHeld(address token) external view returns (uint256);
    /// @notice Platform fees from `token`'s pool, held as claims until the launchpad releases them.
    function pendingPlatform(address token) external view returns (uint256);
    /// @notice Creator fees from `token`'s pool, held as claims until the launchpad releases them.
    function pendingCreator(address token) external view returns (uint256);
    /// @notice How many bids `token`'s pool has; each is its own position (salt = its number).
    function bidCount(address token) external view returns (uint256);
    /// @notice The pool key a token graduates into (known before graduation).
    function poolKeyOf(address token) external view returns (PoolKey memory);
    /// @notice The graduated token's pool, and what the hook knows about it. Reverts UnknownLaunch before graduation.
    function launchOf(address token) external view returns (PoolId poolId, Launch memory launch);
    /// @notice The surcharge, in bps, a buy in `token`'s pool pays in the current block (0 outside the window).
    function snipeBpsOf(address token) external view returns (uint256);
}
