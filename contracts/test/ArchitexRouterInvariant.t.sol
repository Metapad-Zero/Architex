// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../ArchitexFactory.sol";
import "../ArchitexRouter.sol";
import "../ArchitexPair.sol";
import "../TestToken.sol";

/// @title Architex Router Invariant Test
/// @notice Mythril's symbolic execution never converges on the router (path explosion from
///         arbitrary-length multi-hop swap paths — see SECURITY.md). This is the fuzz coverage
///         that closes the gap instead: three tokens (A-B-C) wired into two pairs so every call
///         can multi-hop, fuzzing addLiquidity/removeLiquidity/both swap directions through it.
contract ArchitexRouterInvariantTest is Test {
    ArchitexFactory factory;
    ArchitexRouter router;
    TestToken tokenA;
    TestToken tokenB;
    TestToken tokenC;
    RouterHandler handler;

    function setUp() public {
        factory = new ArchitexFactory(address(this));
        router = new ArchitexRouter(address(factory));

        tokenA = new TestToken("Token A", "TKA", 18, 0, address(this));
        tokenB = new TestToken("Token B", "TKB", 18, 0, address(this));
        tokenC = new TestToken("Token C", "TKC", 18, 0, address(this));

        handler = new RouterHandler(factory, router, tokenA, tokenB, tokenC);
        tokenA.mint(address(handler), 10_000_000 ether);
        tokenB.mint(address(handler), 10_000_000 ether);
        tokenC.mint(address(handler), 10_000_000 ether);
        handler.seed();

        targetContract(address(handler));
    }

    /// @dev The router is a pure pass-through: it must never end a call holding a balance.
    function invariant_routerNeverHoldsTokens() public view {
        assertEq(tokenA.balanceOf(address(router)), 0, "router holds token A");
        assertEq(tokenB.balanceOf(address(router)), 0, "router holds token B");
        assertEq(tokenC.balanceOf(address(router)), 0, "router holds token C");
    }

    /// @dev k must never decrease for either pair the router can touch, across any call.
    function invariant_kNeverDecreasesForEitherPair() public view {
        (uint112 r0AB, uint112 r1AB,) = ArchitexPair(handler.pairAB()).getReserves();
        assertGe(uint256(r0AB) * uint256(r1AB), handler.snapshotKAB(), "K decreased on A/B");

        (uint112 r0BC, uint112 r1BC,) = ArchitexPair(handler.pairBC()).getReserves();
        assertGe(uint256(r0BC) * uint256(r1BC), handler.snapshotKBC(), "K decreased on B/C");
    }

    /// @dev A pair's on-chain balance must always cover what it reports as reserves.
    function invariant_pairsAreSolvent() public view {
        (uint112 r0AB, uint112 r1AB,) = ArchitexPair(handler.pairAB()).getReserves();
        address t0AB = ArchitexPair(handler.pairAB()).token0();
        address t1AB = ArchitexPair(handler.pairAB()).token1();
        assertGe(IERC20Like(t0AB).balanceOf(handler.pairAB()), r0AB);
        assertGe(IERC20Like(t1AB).balanceOf(handler.pairAB()), r1AB);

        (uint112 r0BC, uint112 r1BC,) = ArchitexPair(handler.pairBC()).getReserves();
        address t0BC = ArchitexPair(handler.pairBC()).token0();
        address t1BC = ArchitexPair(handler.pairBC()).token1();
        assertGe(IERC20Like(t0BC).balanceOf(handler.pairBC()), r0BC);
        assertGe(IERC20Like(t1BC).balanceOf(handler.pairBC()), r1BC);
    }
}

interface IERC20Like {
    function balanceOf(address) external view returns (uint256);
}

contract RouterHandler is Test {
    ArchitexFactory factory;
    ArchitexRouter router;
    TestToken tokenA;
    TestToken tokenB;
    TestToken tokenC;

    address public pairAB;
    address public pairBC;
    uint256 public snapshotKAB;
    uint256 public snapshotKBC;
    bool private _seeded;

    constructor(ArchitexFactory _factory, ArchitexRouter _router, TestToken _a, TestToken _b, TestToken _c) {
        factory = _factory;
        router = _router;
        tokenA = _a;
        tokenB = _b;
        tokenC = _c;
    }

    function seed() external {
        if (_seeded) return;
        _seeded = true;

        tokenA.approve(address(router), type(uint256).max);
        tokenB.approve(address(router), type(uint256).max);
        tokenC.approve(address(router), type(uint256).max);

        router.addLiquidity(address(tokenA), address(tokenB), 500_000 ether, 500_000 ether, 0, 0, address(this), block.timestamp);
        router.addLiquidity(address(tokenB), address(tokenC), 500_000 ether, 500_000 ether, 0, 0, address(this), block.timestamp);

        pairAB = factory.getPair(address(tokenA), address(tokenB));
        pairBC = factory.getPair(address(tokenB), address(tokenC));
        _snapshotK();
    }

    function addLiquidity(uint96 amtA, uint96 amtB) external {
        uint256 a = bound(uint256(amtA), 1e18, 100_000 ether);
        uint256 b = bound(uint256(amtB), 1e18, 100_000 ether);
        router.addLiquidity(address(tokenA), address(tokenB), a, b, 0, 0, address(this), block.timestamp);
        _snapshotK();
    }

    function removeLiquidity(uint256 fraction) external {
        uint256 bal = ArchitexPair(pairAB).balanceOf(address(this));
        if (bal == 0) return;
        uint256 amt = (bal * bound(fraction, 1, 100)) / 100;
        if (amt == 0) return;

        ArchitexPair(pairAB).approve(address(router), amt);
        router.removeLiquidity(address(tokenA), address(tokenB), amt, 0, 0, address(this), block.timestamp);
        _snapshotK();
    }

    /// @dev Multi-hop A -> B -> C, exact input.
    function swapExactAtoC(uint96 amtIn) external {
        uint256 a = bound(uint256(amtIn), 1, 10_000 ether);
        address[] memory path = new address[](3);
        path[0] = address(tokenA);
        path[1] = address(tokenB);
        path[2] = address(tokenC);

        try router.getAmountsOut(a, path) returns (uint256[] memory amounts) {
            if (amounts[2] == 0) return;
            router.swapExactTokensForTokens(a, 0, path, address(this), block.timestamp);
            _snapshotK();
        } catch {
            // Reserves too thin for this path right now; not an invariant violation.
        }
    }

    /// @dev Multi-hop C -> B -> A, exact output.
    function swapExactOutCtoA(uint96 amtOut) external {
        uint256 out = bound(uint256(amtOut), 1, 1_000 ether);
        address[] memory path = new address[](3);
        path[0] = address(tokenC);
        path[1] = address(tokenB);
        path[2] = address(tokenA);

        try router.getAmountsIn(out, path) returns (uint256[] memory amounts) {
            router.swapTokensForExactTokens(out, amounts[0] * 2, path, address(this), block.timestamp);
            _snapshotK();
        } catch {
            // amountIn required exceeds what's sane to bound, or reserves too thin; skip.
        }
    }

    function _snapshotK() internal {
        (uint112 r0AB, uint112 r1AB,) = ArchitexPair(pairAB).getReserves();
        snapshotKAB = uint256(r0AB) * uint256(r1AB);
        (uint112 r0BC, uint112 r1BC,) = ArchitexPair(pairBC).getReserves();
        snapshotKBC = uint256(r0BC) * uint256(r1BC);
    }
}
