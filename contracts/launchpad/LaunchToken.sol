// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";
import "../interfaces/ILaunchToken.sol";

/// @title LaunchToken v2 (launchpad v1.3)
/// @notice Fixed-supply ERC-20 minted entirely to the launchpad at construction. No owner, no mint.
///         - Holders can `burn` their own tokens; total supply drops.
///         - USDC dividends: anyone can `distribute` USDC to holders pro-rata; holders `claim` (or anyone `claimFor`s
///           them). The launchpad (curve inventory), the launch pair, 0x…dEaD and address(0) never earn.
///         - Transfers into the launch pair revert until graduation, so the launchpad sets the pool's opening price.
///         - `pull` lets the launchpad (curve sells) and the launch router (pool sells) move a seller's tokens
///           without an approval; each only ever passes its own `msg.sender` as the seller.
///
/// Dividend accounting is the standard magnified-dividend-per-share scheme with per-account corrections
/// (2^128 magnitude). For an eligible account, magnifiedDividendPerShare * balance + correction equals the sum, over
/// every distribution, of that distribution's per-share increment times the balance held at that moment, so
/// transfers, burns and pulls never move dividends already earned. Excluded accounts have no dividend balance:
/// their corrections are never touched and they accrue nothing. The exclusion set is fixed before any token leaves
/// the launchpad (the pair is registered in the launchpad's createToken, before any buy).
contract LaunchToken is ERC20, ILaunchToken {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;
    using SafeCast for int256;

    uint256 private constant _TOTAL = 1_000_000_000e18;
    uint256 private constant _MAGNITUDE = 2 ** 128;
    address private constant _DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @inheritdoc ILaunchToken
    /// @dev With eligible supply >= 1e18, each distributed USDC unit raises the per-share value by at most 2^128/1e18,
    ///      so magnifiedDividendPerShare * balance stays far inside int256 for any amount of USDC that exists. A
    ///      near-empty eligible supply (one wei, say) would let a sole holder distribute and claim back in a loop until
    ///      that product overflowed, and every later transfer, buy and sell would revert.
    uint256 public constant MIN_ELIGIBLE_SUPPLY = 1e18;

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
    /// @dev Below MIN_ELIGIBLE_SUPPLY this reports 0: dividends are paused until at least one whole token is eligible,
    ///      so "no eligible supply" and "distribute reverts" are the same condition for every caller (a plugin that
    ///      holds fees while this is 0 never hits the revert). address(0) never holds a balance in OpenZeppelin's
    ///      ERC20, so it needs no subtraction.
    function eligibleSupply() public view returns (uint256 supply) {
        supply = totalSupply() - balanceOf(launchpad) - balanceOf(pair) - balanceOf(_DEAD);
        if (supply < MIN_ELIGIBLE_SUPPLY) supply = 0;
    }

    /// @inheritdoc ILaunchTokenExtensions
    /// @dev Reverts NoEligibleSupply when eligibleSupply() is 0 (under one whole token). The division floors: at most
    ///      one unit of the magnified per-share value is lost per distribution, never over-credited.
    function distribute(uint256 amount) external {
        uint256 supply = eligibleSupply();
        if (supply == 0) revert NoEligibleSupply();
        _magnifiedDividendPerShare += amount * _MAGNITUDE / supply;
        totalDistributed += amount;
        emit DividendsDistributed(msg.sender, amount);
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @inheritdoc ILaunchTokenExtensions
    function claimable(address holder) public view returns (uint256) {
        return _accumulated(holder) - claimed[holder];
    }

    /// @inheritdoc ILaunchTokenExtensions
    function claim() external returns (uint256 amount) {
        return _claim(msg.sender);
    }

    /// @inheritdoc ILaunchTokenExtensions
    function claimFor(address holder) external returns (uint256 amount) {
        return _claim(holder);
    }

    function _claim(address holder) private returns (uint256 amount) {
        amount = claimable(holder);
        if (amount == 0) return 0;
        claimed[holder] += amount;
        emit DividendClaimed(holder, amount);
        IERC20(usdc).safeTransfer(holder, amount);
    }

    /// @dev Everything `holder` has earned, claimed or not. Zero for excluded accounts.
    function _accumulated(address holder) private view returns (uint256) {
        if (isExcluded(holder)) return 0;
        int256 magnified = (_magnifiedDividendPerShare * balanceOf(holder)).toInt256() + _corrections[holder];
        return magnified.toUint256() / _MAGNITUDE;
    }

    // ─── Transfer hook ───────────────────────────────────────────────────────

    /// @dev Reverts any transfer into `pair` before graduation, then keeps dividends earned so far fixed: an eligible
    ///      account's correction moves by exactly the per-share value of the tokens it sends or receives.
    function _update(address from, address to, uint256 value) internal override {
        address pair_ = pair;
        if (to == pair_ && pair_ != address(0) && !graduated) revert PairLockedUntilGraduation();
        super._update(from, to, value);

        uint256 perShare = _magnifiedDividendPerShare;
        if (perShare != 0 && value != 0) {
            int256 correction = (perShare * value).toInt256();
            if (!isExcluded(from)) _corrections[from] += correction;
            if (!isExcluded(to)) _corrections[to] -= correction;
        }
    }
}
