// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";

/// @title IArchitexLaunchHook
/// @notice The Uniswap v4 hook every graduated v1.4 launch token trades behind (V14-SPEC §3). One hook, one pool per
///         token: the launch token against USDC (the ERC-20 at 0x3600…), LP fee 0, tick spacing 200.
///
///         On every swap it takes, in USDC and rounded up, the launchpad's 0.5% platform fee and the token's creator
///         fee, and sends both to the launchpad's books, exactly what v1.3's launch router did. For SNIPE_BLOCKS blocks
///         after a pool opens, buys also pay a surcharge that starts at SNIPE_START_BPS and falls to 0 block by
///         block; it is held here and locked into the pool as USDC-only liquidity, starting at half the price (V14-SPEC
///         §5), so nobody can ever withdraw it.
///
///         Only the launchpad opens pools with this hook (at graduation), and only the hook itself adds liquidity to a
///         closed pool; an open pool (the creator's choice at launch) takes anyone's liquidity. The hook owns every
///         position it adds and has no way to remove one.
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

    error OnlyLaunchpad();
    error PoolCreationRestricted();
    error ClosedPool();
    error UnknownLaunch();
    error AlreadyOpened();
    error FeesExceedAmount();
    error NothingToLock();

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
    /// @notice 9,900: platform, creator and snipe fees together never take more than 99% of a trade.
    function MAX_TOTAL_FEE_BPS() external view returns (uint256);

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

    /// @notice Locks the snipe fees held for `token` into its pool as a bid. Anyone may call it.
    function lock(address token) external returns (uint128 liquidity);

    /// @notice USDC held for `token`, waiting to be locked by `lock`.
    function lockHeld(address token) external view returns (uint256);
    /// @notice The pool key a token graduates into (known before graduation).
    function poolKeyOf(address token) external view returns (PoolKey memory);
    /// @notice The graduated token's pool, and what the hook knows about it. Reverts UnknownLaunch before graduation.
    function launchOf(address token) external view returns (PoolId poolId, Launch memory launch);
    /// @notice The surcharge, in bps, a buy in `token`'s pool pays in the current block (0 outside the window).
    function snipeBpsOf(address token) external view returns (uint256);
}
