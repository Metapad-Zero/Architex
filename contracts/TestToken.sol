// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/ITestToken.sol";

/// @title Architex Test Token
/// @notice Testnet-only ERC-20 with an open faucet. NEVER deploy to Arc mainnet (chain 5042).
///         The deploy script must refuse if block.chainid == 5042.
contract TestToken is ITestToken, ERC20, Ownable {
    /// @inheritdoc ITestToken
    uint256 public immutable FAUCET_UNITS;

    uint8 private immutable _decimals;

    /// @param _name      Full token name (e.g. "Wrapped Ether (test)").
    /// @param _symbol    Token symbol (e.g. "WETH").
    /// @param decimals_  Decimal places (e.g. 18 for WETH, 8 for WBTC, 6 for USDC/EURC).
    /// @param faucetUnits Whole-token amount minted per faucet() call (before decimals).
    /// @param _owner     Receives ownership (can call mint()).
    constructor(
        string memory _name,
        string memory _symbol,
        uint8 decimals_,
        uint256 faucetUnits,
        address _owner
    ) ERC20(_name, _symbol) Ownable(_owner) {
        _decimals = decimals_;
        FAUCET_UNITS = faucetUnits;
    }

    // ─── ERC-20 overrides ─────────────────────────────────────────────────────

    /// @inheritdoc ITestToken
    function decimals() public view override(ERC20, ITestToken) returns (uint8) {
        return _decimals;
    }

    function name()         public view override(ERC20, ITestToken) returns (string memory) { return super.name(); }
    function symbol()       public view override(ERC20, ITestToken) returns (string memory) { return super.symbol(); }
    function totalSupply()  public view override(ERC20, ITestToken) returns (uint256)       { return super.totalSupply(); }
    function balanceOf(address account) public view override(ERC20, ITestToken) returns (uint256) { return super.balanceOf(account); }
    function allowance(address o, address s) public view override(ERC20, ITestToken) returns (uint256) { return super.allowance(o, s); }
    function approve(address s, uint256 v)   public override(ERC20, ITestToken) returns (bool) { return super.approve(s, v); }
    function transfer(address to, uint256 v)               public override(ERC20, ITestToken) returns (bool) { return super.transfer(to, v); }
    function transferFrom(address f, address t, uint256 v) public override(ERC20, ITestToken) returns (bool) { return super.transferFrom(f, t, v); }
    function owner() public view override(Ownable, ITestToken) returns (address) { return super.owner(); }

    // ─── Faucet ───────────────────────────────────────────────────────────────

    /// @inheritdoc ITestToken
    /// @dev Mints FAUCET_UNITS * 10**decimals to msg.sender. No cooldown (testnet).
    function faucet() external {
        uint256 amount = FAUCET_UNITS * 10 ** uint256(_decimals);
        _mint(msg.sender, amount);
        emit Faucet(msg.sender, amount);
    }

    /// @inheritdoc ITestToken
    /// @dev Owner-only arbitrary mint for pool seeding.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
