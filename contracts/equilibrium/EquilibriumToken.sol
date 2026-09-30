// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// Fixed canonical issuance: no public faucet, no owner mint, no transfer tax or rebase.
contract EquilibriumCanonical is ERC20 {
    constructor(string memory name_, string memory symbol_, address recipient, uint64 issuance)
        ERC20(name_, symbol_)
    {
        require(recipient != address(0) && issuance > 0, "Invalid issuance");
        _mint(recipient, issuance);
    }
    function decimals() public pure override returns (uint8) { return 6; }
}

/// Zero initial issuance. One irrevocable binding to the NTT burning-mode manager.
/// Manager correctness and its upgrade/admin powers remain part of the bridge trust boundary.
contract EquilibriumSpoke is ERC20 {
    address public immutable binder;
    uint64 public immutable supplyCap;
    address public minter;
    constructor(string memory name_, string memory symbol_, address binder_, uint64 cap_)
        ERC20(name_, symbol_)
    {
        require(binder_ != address(0) && cap_ > 0, "Invalid authority");
        binder = binder_;
        supplyCap = cap_;
    }
    function decimals() public pure override returns (uint8) { return 6; }
    function setMinter(address manager) external {
        require(msg.sender == binder && minter == address(0) && manager.code.length > 0, "Minter binding forbidden");
        minter = manager;
    }
    function mint(address recipient, uint256 amount) external {
        require(msg.sender == minter && totalSupply() + amount <= supplyCap, "Mint forbidden");
        _mint(recipient, amount);
    }
    function burn(uint256 amount) external {
        require(msg.sender == minter, "Burn forbidden");
        _burn(msg.sender, amount);
    }
}

/// Request identity and payload are durably bound on-chain, independently of the worker database.
contract EquilibriumIssuanceFactory {
    address public immutable operator;
    mapping(bytes32 => address) public tokenOf;
    mapping(bytes32 => bytes32) public payloadOf;
    event Issued(bytes32 indexed identity, bytes32 indexed payload, address indexed token);
    constructor(address operator_) {
        require(operator_ != address(0), "Invalid operator");
        operator = operator_;
    }
    function issue(bytes32 identity, bytes32 payload, string calldata name_, string calldata symbol_, address recipient, uint64 issuance)
        external returns (address token)
    {
        require(msg.sender == operator, "Operator only");
        // The caller supplies the full job hash; this additionally binds all issuance parameters.
        bytes32 bound = keccak256(abi.encode(payload, name_, symbol_, recipient, issuance));
        token = tokenOf[identity];
        if (token != address(0)) {
            require(payloadOf[identity] == bound, "Identity conflict");
            return token;
        }
        token = address(new EquilibriumCanonical{salt: identity}(name_, symbol_, recipient, issuance));
        tokenOf[identity] = token;
        payloadOf[identity] = bound;
        emit Issued(identity, payload, token);
    }
}
