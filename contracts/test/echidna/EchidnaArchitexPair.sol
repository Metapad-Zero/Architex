// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "../../ArchitexFactory.sol";
import "../../ArchitexPair.sol";
import "../../TestToken.sol";

/// @title Echidna properties for the AMM pair
/// @notice Run with: echidna contracts/test/echidna/EchidnaArchitexPair.sol --contract EchidnaArchitexPair --config echidna.yaml
///         Mirrors the invariants already checked by Foundry (ArchitexInvariant.t.sol) but
///         under Echidna's own coverage-guided fuzzer, which explores call sequences Foundry's
///         invariant runner may not reach.
contract EchidnaArchitexPair {
    ArchitexFactory internal factory;
    ArchitexPair internal pair;
    TestToken internal token0;
    TestToken internal token1;

    uint256 internal lastK;
    address[] internal lps;

    address internal constant DEAD = address(0x000000000000000000000000000000000000dEaD);

    constructor() {
        factory = new ArchitexFactory(address(this));

        TestToken tA = new TestToken("Token A", "TKA", 18, 1_000_000, address(this));
        TestToken tB = new TestToken("Token B", "TKB", 18, 1_000_000, address(this));
        (token0, token1) = address(tA) < address(tB) ? (tA, tB) : (tB, tA);

        address pairAddr = factory.createPair(address(token0), address(token1));
        pair = ArchitexPair(pairAddr);

        token0.mint(address(this), 1_000_000 ether);
        token1.mint(address(this), 1_000_000 ether);

        token0.transfer(address(pair), 100_000 ether);
        token1.transfer(address(pair), 100_000 ether);
        pair.mint(address(this));
        lps.push(address(this));
        _snapshotK();
    }

    // ─── Fuzzed actions ─────────────────────────────────────────────────────

    function addLiquidity(uint96 amt0, uint96 amt1) public {
        uint256 a0 = _bound(amt0, 1e18, 10_000 ether);
        uint256 a1 = _bound(amt1, 1e18, 10_000 ether);

        token0.mint(address(this), a0);
        token1.mint(address(this), a1);
        token0.transfer(address(pair), a0);
        token1.transfer(address(pair), a1);
        pair.mint(address(this));
        _snapshotK();
    }

    function removeLiquidity(uint256 fraction) public {
        uint256 bal = pair.balanceOf(address(this));
        if (bal == 0) return;
        uint256 amt = (bal * _bound(fraction, 1, 100)) / 100;
        if (amt == 0) return;

        pair.transfer(address(pair), amt);
        pair.burn(address(this));
        _snapshotK();
    }

    function swap0For1(uint96 amtIn) public {
        uint256 a = _bound(amtIn, 1, 1_000 ether);
        (uint112 r0, uint112 r1,) = pair.getReserves();
        if (r0 == 0 || r1 == 0) return;
        uint256 amtOut = (a * 997 * uint256(r1)) / (uint256(r0) * 1000 + a * 997);
        if (amtOut == 0 || amtOut >= r1) return;

        token0.mint(address(this), a);
        token0.transfer(address(pair), a);
        pair.swap(0, amtOut, address(this), new bytes(0));
    }

    function swap1For0(uint96 amtIn) public {
        uint256 a = _bound(amtIn, 1, 1_000 ether);
        (uint112 r0, uint112 r1,) = pair.getReserves();
        if (r0 == 0 || r1 == 0) return;
        uint256 amtOut = (a * 997 * uint256(r0)) / (uint256(r1) * 1000 + a * 997);
        if (amtOut == 0 || amtOut >= r0) return;

        token1.mint(address(this), a);
        token1.transfer(address(pair), a);
        pair.swap(amtOut, 0, address(this), new bytes(0));
    }

    // ─── Properties ─────────────────────────────────────────────────────────

    /// @notice k = reserve0 * reserve1 must never decrease (fees make it non-decreasing).
    function echidna_k_never_decreases() public view returns (bool) {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        return uint256(r0) * uint256(r1) >= lastK;
    }

    /// @notice LP total supply must equal this contract's balance plus the locked MINIMUM_LIQUIDITY.
    function echidna_lp_supply_consistent() public view returns (bool) {
        return pair.totalSupply() == pair.balanceOf(address(this)) + pair.balanceOf(DEAD);
    }

    /// @notice The pair must never report more reserves than it actually holds.
    function echidna_reserves_solvent() public view returns (bool) {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        return token0.balanceOf(address(pair)) >= r0 && token1.balanceOf(address(pair)) >= r1;
    }

    // ─── Helpers ────────────────────────────────────────────────────────────

    function _snapshotK() internal {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        lastK = uint256(r0) * uint256(r1);
    }

    function _bound(uint256 x, uint256 lo, uint256 hi) internal pure returns (uint256) {
        return lo + (x % (hi - lo + 1));
    }
}
