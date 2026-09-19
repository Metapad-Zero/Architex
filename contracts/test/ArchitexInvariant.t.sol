// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../ArchitexFactory.sol";
import "../ArchitexPair.sol";
import "../TestToken.sol";

/// @title Architex Invariant Test
/// @notice Property: reserve0 * reserve1 must never decrease between liquidity events (mint/burn).
///         Between liquidity events only swaps happen — fees make k monotonically non-decreasing.
///         Also asserts LP supply consistency (totalSupply = sum of all balances).
contract ArchitexInvariantTest is Test {
    ArchitexFactory factory;
    ArchitexPair    pair;
    TestToken      token0;
    TestToken      token1;
    ArchitexHandler handler;

    function setUp() public {
        factory = new ArchitexFactory(address(this));

        TestToken tA = new TestToken("Token A", "TKA", 18, 1_000_000, address(this));
        TestToken tB = new TestToken("Token B", "TKB", 18, 1_000_000, address(this));
        if (address(tA) < address(tB)) { token0 = tA; token1 = tB; }
        else                           { token0 = tB; token1 = tA; }

        address pairAddr = factory.createPair(address(token0), address(token1));
        pair = ArchitexPair(pairAddr);

        handler = new ArchitexHandler(pair, token0, token1);
        // Seed initial liquidity from test contract, not through handler
        token0.mint(address(handler), 1_000_000 ether);
        token1.mint(address(handler), 1_000_000 ether);
        handler.seed();

        // Target the handler for invariant calls
        targetContract(address(handler));
    }

    /// @dev k = reserve0 * reserve1 must be >= what it was after the last liquidity event.
    function invariant_k_nonDecreasing() public view {
        uint256 k = handler.snapshotK();
        (uint112 r0, uint112 r1,) = pair.getReserves();
        uint256 currentK = uint256(r0) * uint256(r1);
        assertGe(currentK, k, "K decreased");
    }

    /// @dev totalSupply must equal the sum of all known LP holders' balances.
    function invariant_lpSupplyConsistent() public view {
        uint256 supply = pair.totalSupply();
        uint256 sumBals = handler.sumLpBalances();
        assertEq(supply, sumBals, "LP supply inconsistent");
    }
}

contract ArchitexHandler is Test {
    ArchitexPair pair;
    TestToken   token0;
    TestToken   token1;

    address[] lps;
    uint256 public snapshotK;
    bool private _seeded;

    address constant DEAD = address(0x000000000000000000000000000000000000dEaD);

    constructor(ArchitexPair _pair, TestToken _t0, TestToken _t1) {
        pair   = _pair;
        token0 = _t0;
        token1 = _t1;
    }

    function seed() external {
        // Guard: only run once (called from setUp, but fuzzer may call it again)
        if (_seeded) return;
        _seeded = true;
        token0.transfer(address(pair), 100_000 ether);
        token1.transfer(address(pair), 100_000 ether);
        pair.mint(address(this));
        lps.push(address(this));
        _snapshotK();
    }

    function addLiquidity(uint96 amt0, uint96 amt1) external {
        uint256 a0 = bound(uint256(amt0), 1e18, 10_000 ether);
        uint256 a1 = bound(uint256(amt1), 1e18, 10_000 ether);
        address lp = address(uint160(uint256(keccak256(abi.encode(a0, a1, block.number)))));
        token0.mint(lp, a0);
        token1.mint(lp, a1);

        vm.startPrank(lp);
        token0.transfer(address(pair), a0);
        token1.transfer(address(pair), a1);
        pair.mint(lp);
        vm.stopPrank();

        lps.push(lp);
        _snapshotK();
    }

    function removeLiquidity(uint8 lpIdx) external {
        if (lps.length == 0) return;
        address lp = lps[lpIdx % lps.length];
        uint256 bal = pair.balanceOf(lp);
        if (bal == 0) return;

        vm.prank(lp);
        pair.transfer(address(pair), bal);
        pair.burn(lp);
        _snapshotK();
    }

    function swap0For1(uint96 amtIn) external {
        uint256 a = bound(uint256(amtIn), 1, 1_000 ether);
        (uint112 r0, uint112 r1,) = pair.getReserves();
        if (r0 == 0 || r1 == 0) return;
        uint256 amtOut = (a * 997 * uint256(r1)) / (uint256(r0) * 1000 + a * 997);
        if (amtOut == 0 || amtOut >= r1) return;

        token0.mint(address(pair), a);
        pair.swap(0, amtOut, address(this), new bytes(0));
    }

    function swap1For0(uint96 amtIn) external {
        uint256 a = bound(uint256(amtIn), 1, 1_000 ether);
        (uint112 r0, uint112 r1,) = pair.getReserves();
        if (r0 == 0 || r1 == 0) return;
        uint256 amtOut = (a * 997 * uint256(r0)) / (uint256(r1) * 1000 + a * 997);
        if (amtOut == 0 || amtOut >= r0) return;

        token1.mint(address(pair), a);
        pair.swap(amtOut, 0, address(this), new bytes(0));
    }

    function _snapshotK() internal {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        snapshotK = uint256(r0) * uint256(r1);
    }

    function sumLpBalances() external view returns (uint256 total) {
        // Include dead address (MINIMUM_LIQUIDITY lock)
        total = pair.balanceOf(DEAD);
        for (uint256 i; i < lps.length; ++i) {
            total += pair.balanceOf(lps[i]);
        }
        // Include any accumulated fee LP (feeTo not set in this test, so 0)
    }
}
