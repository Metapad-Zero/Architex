// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IUniswapV3PoolKey {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
}
interface IUniswapV3FactoryLookup {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

/// One launch effect executes at most once, whoever submits it and however often.
///
/// Every EQUILIBRIUM step is one `execute(operation, ...)`. The operation id is bound before any
/// call runs, so a stale worker, a restarted worker or a replayed transaction cannot repeat an
/// issuance, a bridge debit, a credit or a pool deposit: the second submission reverts with
/// `OperationDone` and costs only its own gas. The idempotency anchor is this contract, not a
/// transaction nonce or a worker database.
contract EquilibriumExecutor {
    struct Call {
        /// address(0) deploys `data` as init code with CREATE2, salt keccak256(operation, index).
        address target;
        uint256 value;
        bytes data;
    }

    address public immutable owner;
    /// Uniswap v3 factory on this chain, or address(0). Only its pools may draw a mint callback.
    address public immutable v3Factory;
    /// operation => digest of the prepared bytes it executed. Zero until executed.
    mapping(bytes32 => bytes32) public digestOf;
    bool private executing;

    event Executed(bytes32 indexed operation, bytes32 indexed digest);
    event Created(bytes32 indexed operation, uint256 indexed index, address created);

    error NotOwner();
    error OperationDone(bytes32 operation, bytes32 digest);
    error CallFailed(uint256 index, bytes reason);
    error CreateFailed(uint256 index);
    error CallbackForbidden();

    constructor(address owner_, address v3Factory_) {
        require(owner_ != address(0), "Invalid owner");
        owner = owner_;
        v3Factory = v3Factory_;
    }

    receive() external payable {}

    function execute(bytes32 operation, bytes32 digest, Call[] calldata calls) external payable {
        if (msg.sender != owner) revert NotOwner();
        bytes32 prior = digestOf[operation];
        if (prior != bytes32(0)) revert OperationDone(operation, prior);
        require(digest != bytes32(0), "Digest required");
        // Bound before any external call, so no reentrant path can run this operation twice.
        digestOf[operation] = digest;
        executing = true;
        for (uint256 i = 0; i < calls.length; i++) {
            Call calldata c = calls[i];
            if (c.target == address(0)) {
                bytes memory init = c.data;
                bytes32 salt = keccak256(abi.encode(operation, i));
                uint256 value = c.value;
                address created;
                assembly { created := create2(value, add(init, 0x20), mload(init), salt) }
                if (created == address(0)) revert CreateFailed(i);
                emit Created(operation, i, created);
            } else {
                (bool ok, bytes memory reason) = c.target.call{value: c.value}(c.data);
                if (!ok) revert CallFailed(i, reason);
            }
        }
        executing = false;
        emit Executed(operation, digest);
    }

    /// Pays what a genuine pool asks for, then donates the rest of the bound totals to the pool so
    /// the pool holds exactly the quoted inventory. The donated remainder is a few atoms of rounding.
    function uniswapV3MintCallback(uint256 owed0, uint256 owed1, bytes calldata data) external {
        if (!executing || v3Factory == address(0)) revert CallbackForbidden();
        IUniswapV3PoolKey pool = IUniswapV3PoolKey(msg.sender);
        address token0 = pool.token0();
        address token1 = pool.token1();
        if (IUniswapV3FactoryLookup(v3Factory).getPool(token0, token1, pool.fee()) != msg.sender) revert CallbackForbidden();
        (uint256 total0, uint256 total1) = abi.decode(data, (uint256, uint256));
        require(owed0 <= total0 && owed1 <= total1, "Owed exceeds bound inventory");
        if (total0 > 0) require(IERC20(token0).transfer(msg.sender, total0), "Token0 transfer failed");
        if (total1 > 0) require(IERC20(token1).transfer(msg.sender, total1), "Token1 transfer failed");
    }
}
