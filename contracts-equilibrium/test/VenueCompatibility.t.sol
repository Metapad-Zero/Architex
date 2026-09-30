// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import "forge-std/Test.sol";
import "../../contracts/equilibrium/EquilibriumToken.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IV3Factory {
    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address);
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}
interface IV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function initialize(uint160 sqrtPriceX96) external;
    function mint(address recipient, int24 lower, int24 upper, uint128 liquidity, bytes calldata data) external returns (uint256, uint256);
    function swap(address recipient, bool zeroForOne, int256 amount, uint160 limit, bytes calldata data) external returns (int256, int256);
}

/// Actual venue bytecode on READ-ONLY forks. Minting here is fixture setup, not a public NTT credit.
contract VenueCompatibilityTest is Test {
    IV3Pool private activePool;
    function rehearse(string memory rpc, address factoryAddress) internal {
        vm.createSelectFork(rpc);
        EquilibriumSpoke token = new EquilibriumSpoke("Equilibrium", "EQL", address(this), 1_000_000e6);
        token.setMinter(address(this)); token.mint(address(this), 10_000e6);
        EquilibriumCanonical quote = new EquilibriumCanonical("Synthetic quote", "Q", address(this), 10_000e6);
        IV3Factory factory = IV3Factory(factoryAddress);
        activePool = IV3Pool(factory.createPool(address(token), address(quote), 3000));
        assertEq(factory.getPool(address(token), address(quote), 3000), address(activePool));
        activePool.initialize(uint160(1 << 96));
        (uint256 amount0, uint256 amount1) = activePool.mint(address(this), -887220, 887220, 1000e6, "");
        assertGt(amount0, 0); assertGt(amount1, 0);
        (int256 paid, int256 received) = activePool.swap(address(this), true, 10e6, 4295128740, "");
        assertGt(paid, 0); assertLt(received, 0); assertEq(token.totalSupply(), 10_000e6);
        vm.expectRevert(); factory.createPool(address(token), address(quote), 3000);
    }
    function test_existingSixDecimalSpokeAcceptedOnBaseSepoliaFork() public {
        rehearse("https://sepolia.base.org", 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24);
    }
    function test_existingSixDecimalSpokeAcceptedOnRobinhoodMainnetFork() public {
        rehearse("https://rpc.mainnet.chain.robinhood.com", 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA);
    }
    function uniswapV3MintCallback(uint256 amount0, uint256 amount1, bytes calldata) external {
        require(msg.sender == address(activePool), "Pool only");
        if (amount0 > 0) IERC20(activePool.token0()).transfer(msg.sender, amount0);
        if (amount1 > 0) IERC20(activePool.token1()).transfer(msg.sender, amount1);
    }
    function uniswapV3SwapCallback(int256 amount0, int256 amount1, bytes calldata) external {
        require(msg.sender == address(activePool), "Pool only");
        if (amount0 > 0) IERC20(activePool.token0()).transfer(msg.sender, uint256(amount0));
        if (amount1 > 0) IERC20(activePool.token1()).transfer(msg.sender, uint256(amount1));
    }
}
