// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../../interfaces/IFeeDistributor.sol";

/// @title WeightedSplitDistributor
/// @notice Splits any ERC-20 balance this contract holds among a fixed set of payees, in fixed
///         proportions, decided once at deploy and immutable after. Works as `feeTo` on either
///         `ArchitexFactory` (which pays in LP tokens) or `ArchitexLaunchpad` (which pays in
///         USDC) — the token being split is whatever `release` is called with, not something
///         fixed at construction, so the same instance can serve both if you want it to.
/// @dev Pull-based, following OpenZeppelin's PaymentSplitter accounting: a payee's releasable
///      amount is their share of everything this contract has ever held of that token, minus
///      what they've already withdrawn. No admin, no pause, no way to change payees or shares
///      after deploy — the whole point is that nobody, including the deployer, can redirect
///      funds after the fact.
contract WeightedSplitDistributor is IFeeDistributor {
    using SafeERC20 for IERC20;

    error NoPayees();
    error PayeesSharesLengthMismatch();
    error ZeroAddress();
    error ZeroShares();
    error DuplicatePayee();
    error NothingToRelease();

    uint256 public immutable totalShares;

    address[] private _payees;
    mapping(address => uint256) public sharesOf;

    mapping(address => uint256) public totalReleased; // token => total ever released
    mapping(address => mapping(address => uint256)) public released; // token => payee => released

    constructor(address[] memory payees_, uint256[] memory shares_) {
        if (payees_.length == 0) revert NoPayees();
        if (payees_.length != shares_.length) revert PayeesSharesLengthMismatch();

        uint256 sum;
        for (uint256 i; i < payees_.length; ++i) {
            address payee = payees_[i];
            uint256 share = shares_[i];
            if (payee == address(0)) revert ZeroAddress();
            if (share == 0) revert ZeroShares();
            if (sharesOf[payee] != 0) revert DuplicatePayee();

            sharesOf[payee] = share;
            _payees.push(payee);
            sum += share;
        }
        totalShares = sum;
    }

    /// @inheritdoc IFeeDistributor
    function payees() external view returns (address[] memory) {
        return _payees;
    }

    /// @inheritdoc IFeeDistributor
    function releasable(address token, address payee) public view returns (uint256) {
        uint256 share = sharesOf[payee];
        if (share == 0) return 0;

        uint256 totalReceived = IERC20(token).balanceOf(address(this)) + totalReleased[token];
        uint256 owed = (totalReceived * share) / totalShares;
        uint256 already = released[token][payee];
        return owed > already ? owed - already : 0;
    }

    /// @inheritdoc IFeeDistributor
    function release(address token, address payee) external {
        uint256 amount = releasable(token, payee);
        if (amount == 0) revert NothingToRelease();

        totalReleased[token] += amount;
        released[token][payee] += amount;

        IERC20(token).safeTransfer(payee, amount);
        emit Released(token, payee, amount);
    }
}
