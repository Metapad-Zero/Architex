// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";
import "../interfaces/ILaunchToken.sol";

/// @title LaunchToken v2 (launchpad v1.3)
/// @notice Fixed-supply ERC-20 minted entirely to the launchpad at construction. No owner, no mint.
///         - Holders can `burn` their own tokens; total supply drops.
///         - USDC dividends, streamed: anyone can `distribute` USDC to holders. It is paid out continuously over
///           DRIP_PERIOD, and each eligible account earns second by second in proportion to what it holds, so a
///           holder earns only for the time it holds: buying, claiming and selling in one transaction earns nothing,
///           however much has been distributed. Holders `claim` (or anyone `claimFor`s them). The launchpad (curve
///           inventory), the launch pair, 0x…dEaD and address(0) never earn.
///         - Transfers into the launch pair revert until graduation, so the launchpad sets the pool's opening price.
///         - `pull` lets the launchpad (curve sells) and the launch router (pool sells) move a seller's tokens
///           without an approval; each only ever passes its own `msg.sender` as the seller.
///
/// Dividend accounting (Synthetix StakingRewards style on top of the magnified-dividend-per-share scheme):
/// - The stream pays `_rate` (USDC × 2^128 per second) to the eligible supply from `lastAccrual` to `streamEnd`.
///   `_accrue` adds `_rate × dt / eligible` to the per-share value over each interval it covers. It runs first in
///   every transfer (before balances change), in `distribute` and in `claim`, and eligible supply changes only in
///   transfers, so it is constant over every interval accrued.
/// - While eligible supply is under MIN_ELIGIBLE_SUPPLY the stream is paused: nothing accrues and its end moves out
///   by the paused time, so no backlog builds for whoever holds next.
/// - `distribute(amount)` accrues, then adds `amount` to what the stream still owes and sets its end to the
///   amount-weighted average of the old end and now + DRIP_PERIOD, rounded down (at least now + 1): a first stream
///   runs exactly DRIP_PERIOD, and dust does not move the end.
/// - Per-account corrections keep what an account has earned fixed through transfers, burns and pulls: an eligible
///   account's correction moves by exactly the per-share value of the tokens it sends or receives. So an account
///   earns only on the per-share growth while it holds. Excluded accounts have no dividend balance: their corrections
///   are never touched and they accrue nothing. The exclusion set is fixed before any token leaves the launchpad (the
///   pair is registered in the launchpad's createToken, before any buy).
/// - Rounding is always down (rate, per-share accrual, each account's claim), so nobody is ever over-credited; the
///   dust stays in the token.
/// - Overflow: with MIN_ELIGIBLE_SUPPLY = 1e18, per-share grows by at most 2^128 / 1e18 per USDC unit distributed,
///   so per-share × balance stays inside int256 (the corrections) for a cumulative 1.7e23 USDC distributed per
///   token, and every rate and remaining amount fits uint256 for amounts below 2^128 units; all USDC in existence
///   is about 1e11.
contract LaunchToken is ERC20, ILaunchToken {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;
    using SafeCast for int256;

    uint256 private constant _TOTAL = 1_000_000_000e18;
    uint256 private constant _MAGNITUDE = 2 ** 128;
    address private constant _DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @inheritdoc ILaunchToken
    /// @dev Below this the stream pauses and eligibleSupply() reports 0, which bounds the per-share growth a
    ///      near-empty eligible supply would otherwise allow (each USDC unit adds at most 2^128 / 1e18 per share).
    uint256 public constant MIN_ELIGIBLE_SUPPLY = 1e18;
    /// @inheritdoc ILaunchTokenExtensions
    uint256 public constant DRIP_PERIOD = 24 hours;

    /// @inheritdoc ILaunchToken
    address public immutable launchpad;
    /// @inheritdoc ILaunchToken
    address public immutable router;
    /// @inheritdoc ILaunchTokenExtensions
    address public immutable usdc;

    /// @inheritdoc ILaunchToken
    address public pair;
    /// @inheritdoc ILaunchToken
    bool public graduated;

    uint256 private _magnifiedDividendPerShare;
    mapping(address => int256) private _corrections;
    /// @inheritdoc ILaunchToken
    mapping(address => uint256) public claimed;
    /// @inheritdoc ILaunchTokenExtensions
    uint256 public totalDistributed;

    /// @dev What the stream pays the eligible supply per second, magnified by 2^128.
    uint256 private _rate;

    /// @dev One slot, read and written together by every accrual. `eligible` is the raw eligible supply (the
    ///      balances outside the excluded set), kept in step by _update; it is at most the 1e27 total supply.
    ///      Whenever the stream runs (lastAccrual < end), end - lastAccrual <= DRIP_PERIOD.
    struct Stream {
        uint128 eligible;
        uint64 lastAccrual;
        uint64 end;
    }

    Stream private _stream;

    constructor(string memory name_, string memory symbol_, address usdc_, address router_) ERC20(name_, symbol_) {
        launchpad = msg.sender;
        usdc = usdc_;
        router = router_;
        _mint(msg.sender, _TOTAL);
    }

    // ─── Launchpad-only state setters ─────────────────────────────────────────

    /// @inheritdoc ILaunchToken
    function initPair(address pair_) external {
        if (msg.sender != launchpad) revert OnlyLaunchpad();
        if (pair != address(0)) revert PairAlreadySet();
        pair = pair_;
    }

    /// @inheritdoc ILaunchToken
    function markGraduated() external {
        if (msg.sender != launchpad) revert OnlyLaunchpad();
        if (graduated) revert AlreadyGraduated();
        graduated = true;
    }

    /// @inheritdoc ILaunchToken
    /// @dev The destination is fixed per caller, so even a caller bug could only ever move tokens into the curve
    ///      inventory or the pool, never to an arbitrary address.
    function pull(address from, address to, uint256 amount) external {
        if (msg.sender == launchpad) {
            if (to != launchpad) revert InvalidPullTarget();
        } else if (msg.sender == router) {
            if (to != pair) revert InvalidPullTarget();
        } else {
            revert OnlyLaunchpadOrRouter();
        }
        _transfer(from, to, amount);
    }

    // ─── Burn ────────────────────────────────────────────────────────────────

    /// @inheritdoc ILaunchTokenExtensions
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }

    // ─── Dividends ───────────────────────────────────────────────────────────

    /// @inheritdoc ILaunchTokenExtensions
    function isExcluded(address account) public view returns (bool) {
        // Before initPair `pair` is zero, which is excluded anyway; nothing moves before initPair.
        return account == launchpad || account == pair || account == _DEAD || account == address(0);
    }

    /// @inheritdoc ILaunchTokenExtensions
    /// @dev The tracked eligible supply, which equals totalSupply() minus the launchpad's, the pair's and 0x…dEaD's
    ///      balances; reported as 0 below MIN_ELIGIBLE_SUPPLY, where the stream is paused.
    function eligibleSupply() public view returns (uint256 supply) {
        supply = _stream.eligible;
        if (supply < MIN_ELIGIBLE_SUPPLY) supply = 0;
    }

    /// @inheritdoc ILaunchTokenExtensions
    /// @dev The new amount joins what the stream still owes; the end moves to the amount-weighted average of the old
    ///      end and now + DRIP_PERIOD, rounded down and at least now + 1, and the rate becomes everything owed over
    ///      the time left, rounded down. State is written before the pull; USDC is the only external call.
    function distribute(uint256 amount) external {
        if (amount == 0) return;
        _accrue();
        Stream memory stream = _stream;
        uint256 end = stream.end;
        // What the running stream will still pay, exactly: its stored rate (the floor of a division, but magnified by
        // 2^128, so the floor is below 1e-34 USDC per second) times the seconds left. Deriving it from the rate keeps
        // it equal to what accrual will actually pay; a separately stored amount would drift from that.
        // slither-disable-next-line divide-before-multiply
        uint256 owed = end > block.timestamp ? _rate * (end - block.timestamp) : 0;
        uint256 added = amount * _MAGNITUDE;
        uint256 newEnd = _weightedEnd(owed, end, added);
        _rate = (owed + added) / (newEnd - block.timestamp);
        stream.lastAccrual = block.timestamp.toUint64();
        stream.end = newEnd.toUint64();
        _stream = stream;
        totalDistributed += amount;
        emit DividendsDistributed(msg.sender, amount);
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @inheritdoc ILaunchTokenExtensions
    function claimable(address holder) public view returns (uint256) {
        return _accumulated(holder, _perShareNow()) - claimed[holder];
    }

    /// @inheritdoc ILaunchTokenExtensions
    function claim() external returns (uint256 amount) {
        return _claim(msg.sender);
    }

    /// @inheritdoc ILaunchTokenExtensions
    function claimFor(address holder) external returns (uint256 amount) {
        return _claim(holder);
    }

    /// @inheritdoc ILaunchTokenExtensions
    /// @dev _rate is left as it was when a stream ends or pauses, so the view reports 0 itself in those states.
    function streamRate() external view returns (uint256) {
        Stream memory stream = _stream;
        if (block.timestamp >= stream.end || _paused(stream)) return 0;
        return _rate / _MAGNITUDE;
    }

    /// @inheritdoc ILaunchTokenExtensions
    /// @dev While paused the stored end moves out only when something accrues, so the view adds the paused time so far,
    ///      exactly as the next _accrue would.
    function streamEnd() external view returns (uint256) {
        Stream memory stream = _stream;
        if (stream.lastAccrual < stream.end && _paused(stream)) {
            return stream.end + (block.timestamp - stream.lastAccrual);
        }
        return stream.end;
    }

    /// @inheritdoc ILaunchTokenExtensions
    function lastAccrual() external view returns (uint256) {
        return _stream.lastAccrual;
    }

    /// @inheritdoc ILaunchTokenExtensions
    function undistributed() external view returns (uint256 owed) {
        Stream memory stream = _stream;
        if (stream.lastAccrual < stream.end) {
            uint256 from = _paused(stream) ? stream.lastAccrual : Math.min(block.timestamp, stream.end);
            owed = (_rate * (stream.end - from)) / _MAGNITUDE;
        }
    }

    function _claim(address holder) private returns (uint256 amount) {
        _accrue();
        amount = _accumulated(holder, _magnifiedDividendPerShare) - claimed[holder];
        if (amount != 0) {
            claimed[holder] += amount;
            emit DividendClaimed(holder, amount);
            IERC20(usdc).safeTransfer(holder, amount);
        }
    }

    /// @dev Brings the per-share value up to now (see the contract notes). Over [lastAccrual, min(now, end)] the
    ///      stream pays _rate to the eligible supply, which has not changed since lastAccrual. Paused (eligible below
    ///      MIN_ELIGIBLE_SUPPLY): nothing accrues and the end moves out by the paused time. No-op when no stream runs
    ///      or nothing has passed.
    function _accrue() private {
        Stream memory stream = _stream;
        uint256 last = stream.lastAccrual;
        uint256 end = stream.end;
        if (last < end && last != block.timestamp) {
            if (_paused(stream)) {
                stream.end = (end + (block.timestamp - last)).toUint64();
                stream.lastAccrual = block.timestamp.toUint64();
            } else {
                uint256 upTo = Math.min(block.timestamp, end);
                _magnifiedDividendPerShare += (_rate * (upTo - last)) / stream.eligible;
                stream.lastAccrual = upTo.toUint64();
            }
            _stream = stream;
        }
    }

    /// @dev What _accrue would bring the per-share value to now, without writing it (the same arithmetic).
    function _perShareNow() private view returns (uint256 perShare) {
        perShare = _magnifiedDividendPerShare;
        Stream memory stream = _stream;
        if (stream.lastAccrual < stream.end && !_paused(stream)) {
            uint256 upTo = Math.min(block.timestamp, stream.end);
            perShare += (_rate * (upTo - stream.lastAccrual)) / stream.eligible;
        }
    }

    /// @dev Under one whole eligible token the stream is paused.
    function _paused(Stream memory stream) private pure returns (bool) {
        return stream.eligible < MIN_ELIGIBLE_SUPPLY;
    }

    /// @dev The amount-weighted average of the stream's end (or now, if it has passed) and now + DRIP_PERIOD, weighted
    ///      by what the stream still owes and the new amount (both magnified), rounded down and at least now + 1:
    ///      from + floor(added * (to - from) / (owed + added)). Never before `from`, never past now + DRIP_PERIOD;
    ///      with nothing owed it is exactly now + DRIP_PERIOD, and a deposit under owed / (to - from - 1) leaves the
    ///      end where it is. `to - from` cannot underflow: a running stream ends at most DRIP_PERIOD after now once
    ///      accrued.
    function _weightedEnd(uint256 owed, uint256 end, uint256 added) private view returns (uint256) {
        uint256 from = Math.max(end, block.timestamp);
        uint256 to = block.timestamp + DRIP_PERIOD;
        return Math.max(from + Math.mulDiv(added, to - from, owed + added), block.timestamp + 1);
    }

    /// @dev Everything `holder` has earned at per-share value `perShare`, claimed or not. Zero for excluded accounts.
    function _accumulated(address holder, uint256 perShare) private view returns (uint256) {
        if (isExcluded(holder)) return 0;
        int256 magnified = (perShare * balanceOf(holder)).toInt256() + _corrections[holder];
        return magnified.toUint256() / _MAGNITUDE;
    }

    // ─── Transfer hook ───────────────────────────────────────────────────────

    /// @dev Reverts any transfer into `pair` before graduation. Then, in this order: accrues the stream up to now
    ///      with the eligible supply that held until this moment; moves the balances; moves the tracked eligible
    ///      supply when tokens cross the excluded boundary (a burn is a send to address(0)); and keeps dividends
    ///      earned so far fixed: an eligible account's correction moves by exactly the per-share value of the tokens
    ///      it sends or receives.
    function _update(address from, address to, uint256 value) internal override {
        address pair_ = pair;
        if (to == pair_ && pair_ != address(0) && !graduated) revert PairLockedUntilGraduation();
        _accrue();
        super._update(from, to, value);

        bool fromEligible = !isExcluded(from);
        bool toEligible = !isExcluded(to);
        if (value != 0 && fromEligible != toEligible) {
            if (toEligible) _stream.eligible += value.toUint128();
            else _stream.eligible -= value.toUint128();
        }
        uint256 perShare = _magnifiedDividendPerShare;
        if (perShare != 0 && value != 0) {
            int256 correction = (perShare * value).toInt256();
            if (fromEligible) _corrections[from] += correction;
            if (toEligible) _corrections[to] -= correction;
        }
    }
}
