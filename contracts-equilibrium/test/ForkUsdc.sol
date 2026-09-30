// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// FORK ONLY. Arc's native USDC routes balances through Arc precompiles (0x18..00/01) that anvil
/// does not implement, so an Arc fork substitutes this EIP-3009 token at the same address with the
/// same name, version and six decimals. It proves the adapter's settlement calls, not Arc's USDC.
contract ForkUsdc is ERC20, EIP712 {
    bytes32 private constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    mapping(address => mapping(bytes32 => bool)) public authorizationState;
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);

    constructor() ERC20("USDC", "USDC") EIP712("USDC", "2") {}
    function decimals() public pure override returns (uint8) { return 6; }
    // Constants, not storage: the substituted address keeps the real proxy's storage underneath.
    function name() public pure override returns (string memory) { return "USDC"; }
    function symbol() public pure override returns (string memory) { return "USDC"; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
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
