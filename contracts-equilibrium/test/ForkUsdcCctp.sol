// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// FORK ONLY. The refill rehearsal's Arc USDC stand-in. It is ForkUsdc with the two calls Circle's
/// TokenMinterV2 makes: `mint` returning true and `burn`. Declarations and inheritance match
/// ForkUsdc exactly, so it replaces ForkUsdc in place without disturbing balances or used
/// authorizations. Arc's real USDC mints and burns through Arc precompiles anvil lacks; this proves
/// the CCTP contracts' calls against it, not Arc's USDC itself.
contract ForkUsdcCctp is ERC20, EIP712 {
    bytes32 private constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    mapping(address => mapping(bytes32 => bool)) public authorizationState;
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);

    constructor() ERC20("USDC", "USDC") EIP712("USDC", "2") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function name() public pure override returns (string memory) { return "USDC"; }
    function symbol() public pure override returns (string memory) { return "USDC"; }
    function mint(address to, uint256 amount) external returns (bool) { _mint(to, amount); return true; }
    function burn(uint256 amount) external { _burn(msg.sender, amount); }
    function DOMAIN_SEPARATOR() external view returns (bytes32) { return _domainSeparatorV4(); }

    function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external {
        require(block.timestamp > validAfter && block.timestamp < validBefore, "Authorization not valid now");
        require(!authorizationState[from][nonce], "Authorization used");
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)));
        require(ECDSA.recover(digest, v, r, s) == from, "Invalid signature");
        authorizationState[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }
}
