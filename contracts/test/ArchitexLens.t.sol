// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../ArchitexFactory.sol";
import "../ArchitexRouter.sol";
import "../ArchitexLens.sol";
import "../ArchitexPair.sol";
import "../TestToken.sol";

contract ArchitexLensTest is Test {
    ArchitexFactory factory;
    ArchitexRouter  router;
    ArchitexLens    lens;

    TestToken tokenA;
    TestToken tokenB;
    TestToken tokenC;
    TestToken token6;

    address alice = address(0xA11CE);

    function setUp() public {
        factory = new ArchitexFactory(address(this));
        router  = new ArchitexRouter(address(factory));
        lens    = new ArchitexLens(address(factory), address(router));

        tokenA = new TestToken("Token A", "TKA", 18, 1_000_000, address(this));
        tokenB = new TestToken("Token B", "TKB", 18, 1_000_000, address(this));
        tokenC = new TestToken("Token C", "TKC", 18, 1_000_000, address(this));
        token6 = new TestToken("USD Coin", "USDC", 6,  1_000_000, address(this));

        tokenA.mint(alice, 1_000_000 ether);
        tokenB.mint(alice, 1_000_000 ether);
        tokenC.mint(alice, 1_000_000 ether);
        token6.mint(alice, 1_000_000 * 1e6);

        vm.startPrank(alice);
        tokenA.approve(address(router), type(uint256).max);
        tokenB.approve(address(router), type(uint256).max);
        tokenC.approve(address(router), type(uint256).max);
        token6.approve(address(router), type(uint256).max);

        router.addLiquidity(address(tokenA), address(tokenB), 1000 ether, 1000 ether, 1, 1, alice, block.timestamp + 1);
        router.addLiquidity(address(tokenA), address(tokenC), 1000 ether, 1000 ether, 1, 1, alice, block.timestamp + 1);
        router.addLiquidity(address(tokenB), address(tokenC), 1000 ether, 1000 ether, 1, 1, alice, block.timestamp + 1);
        vm.stopPrank();
    }

    // ─── pairs ────────────────────────────────────────────────────────────────

    function test_pairs_all() public view {
        IArchitexLens.PairInfo[] memory ps = lens.pairs(0, 100);
        assertEq(ps.length, 3);
    }

    function test_pairs_paging() public view {
        IArchitexLens.PairInfo[] memory ps = lens.pairs(1, 1);
        assertEq(ps.length, 1);
    }

    function test_pairs_clampToLength() public view {
        IArchitexLens.PairInfo[] memory ps = lens.pairs(0, 1000);
        assertEq(ps.length, 3);
    }

    function test_pairs_startBeyondLength_returnsEmpty() public view {
        IArchitexLens.PairInfo[] memory ps = lens.pairs(100, 10);
        assertEq(ps.length, 0);
    }

    function test_pairsByAddress() public view {
        address pAB = factory.getPair(address(tokenA), address(tokenB));
        address pBC = factory.getPair(address(tokenB), address(tokenC));
        address[] memory addrs = new address[](2);
        addrs[0] = pAB; addrs[1] = pBC;
        IArchitexLens.PairInfo[] memory ps = lens.pairsByAddress(addrs);
        assertEq(ps.length, 2);
        assertEq(ps[0].pair, pAB);
        assertEq(ps[1].pair, pBC);
    }

    // ─── tokenMeta ────────────────────────────────────────────────────────────

    function test_tokenMeta_basicValues() public view {
        address[] memory tkns = new address[](2);
        tkns[0] = address(tokenA);
        tkns[1] = address(token6);
        IArchitexLens.TokenMeta[] memory meta = lens.tokenMeta(tkns);
        assertEq(meta[0].symbol,   "TKA");
        assertEq(meta[0].decimals, 18);
        assertEq(meta[1].symbol,   "USDC");
        assertEq(meta[1].decimals, 6);
    }

    function test_tokenMeta_nonERC20_noRevert() public {
        // Deploy a contract that has no symbol/name/decimals functions
        NoMetaContract noMeta = new NoMetaContract();
        address[] memory tkns = new address[](1);
        tkns[0] = address(noMeta);
        IArchitexLens.TokenMeta[] memory meta = lens.tokenMeta(tkns);
        assertEq(meta.length, 1);
        assertEq(bytes(meta[0].symbol).length, 0); // fallback empty string
        assertEq(meta[0].decimals, 18);             // fallback 18
    }

    // ─── balances / allowances ────────────────────────────────────────────────

    function test_balances_lengths() public view {
        address[] memory tkns = new address[](3);
        tkns[0] = address(tokenA); tkns[1] = address(tokenB); tkns[2] = address(tokenC);
        uint256[] memory bals = lens.balances(alice, tkns);
        assertEq(bals.length, 3);
        assertGt(bals[0], 0); // alice added liquidity but still holds some
    }

    function test_allowances_lengths() public {
        vm.prank(alice);
        tokenA.approve(address(router), 500 ether);
        address[] memory tkns = new address[](1);
        tkns[0] = address(tokenA);
        uint256[] memory alw = lens.allowances(alice, address(router), tkns);
        assertEq(alw.length, 1);
    }

    // ─── positions ────────────────────────────────────────────────────────────

    function test_positions_filtersZeroBalance() public {
        // bob has no LP
        IArchitexLens.Position[] memory pos = lens.positions(address(0xB0B), 0, 100);
        assertEq(pos.length, 0);
    }

    function test_positions_aliceHoldsAll() public view {
        IArchitexLens.Position[] memory pos = lens.positions(alice, 0, 100);
        assertEq(pos.length, 3);
        for (uint256 i; i < pos.length; ++i) {
            assertGt(pos[i].lpBalance, 0);
        }
    }

    function test_positions_paging() public view {
        IArchitexLens.Position[] memory pos = lens.positions(alice, 0, 1);
        assertEq(pos.length, 1);
    }

    function test_positions_includesRouterAllowance() public {
        address pair = factory.getPair(address(tokenA), address(tokenB));
        vm.prank(alice);
        ArchitexPair(pair).approve(address(router), 999);

        IArchitexLens.Position[] memory pos = lens.positions(alice, 0, 100);
        bool found;
        for (uint256 i; i < pos.length; ++i) {
            if (pos[i].pair == pair) {
                assertEq(pos[i].routerAllowance, 999);
                found = true;
            }
        }
        assertTrue(found);
    }
}

/// @dev A contract with no ERC-20 metadata functions — used to test tokenMeta try/catch fallback.
///      The fallback reverts so the try/catch catches it and returns the default values.
contract NoMetaContract {
    fallback() external { revert(); }
}
