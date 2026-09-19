// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../ArchitexFactory.sol";
import "../ArchitexRouter.sol";
import "../ArchitexPair.sol";
import "../TestToken.sol";

contract ArchitexRouterTest is Test {
    ArchitexFactory factory;
    ArchitexRouter  router;

    TestToken tokenA;  // 18 dec
    TestToken tokenB;  // 18 dec
    TestToken tokenC;  // 18 dec
    TestToken token6;  // 6 dec (USDC-like)

    address alice = address(0xA11CE);
    address bob   = address(0xB0B);

    uint256 constant MAX = type(uint256).max;

    function setUp() public {
        factory = new ArchitexFactory(address(this));
        router  = new ArchitexRouter(address(factory));

        tokenA = new TestToken("Token A", "TKA", 18, 1_000_000, address(this));
        tokenB = new TestToken("Token B", "TKB", 18, 1_000_000, address(this));
        tokenC = new TestToken("Token C", "TKC", 18, 1_000_000, address(this));
        token6 = new TestToken("USD Coin", "USDC", 6, 1_000_000, address(this));

        // Fund alice and bob
        tokenA.mint(alice, 1_000_000 ether);
        tokenB.mint(alice, 1_000_000 ether);
        tokenC.mint(alice, 1_000_000 ether);
        token6.mint(alice, 1_000_000 * 1e6);

        tokenA.mint(bob, 1_000_000 ether);
        tokenB.mint(bob, 1_000_000 ether);
        tokenC.mint(bob, 1_000_000 ether);
        token6.mint(bob, 1_000_000 * 1e6);

        // Pre-approve router for alice and bob
        vm.startPrank(alice);
        tokenA.approve(address(router), MAX);
        tokenB.approve(address(router), MAX);
        tokenC.approve(address(router), MAX);
        token6.approve(address(router), MAX);
        vm.stopPrank();

        vm.startPrank(bob);
        tokenA.approve(address(router), MAX);
        tokenB.approve(address(router), MAX);
        tokenC.approve(address(router), MAX);
        token6.approve(address(router), MAX);
        vm.stopPrank();
    }

    // ─── addLiquidity ─────────────────────────────────────────────────────────

    function test_addLiquidity_createsPair() public {
        vm.prank(alice);
        (uint256 amtA, uint256 amtB, uint256 liq) = router.addLiquidity(
            address(tokenA), address(tokenB),
            100 ether, 100 ether,
            1, 1,
            alice, block.timestamp + 1
        );
        assertGt(amtA, 0);
        assertGt(amtB, 0);
        assertGt(liq, 0);
        assertTrue(factory.getPair(address(tokenA), address(tokenB)) != address(0));
    }

    function test_addLiquidity_respectsMinimums() public {
        // Seed pool first
        vm.prank(alice);
        router.addLiquidity(
            address(tokenA), address(tokenB),
            100 ether, 100 ether,
            1, 1,
            alice, block.timestamp + 1
        );

        // Bob tries to add at a very high minB that can't be met
        vm.prank(bob);
        vm.expectRevert(IArchitexRouter.InsufficientBAmount.selector);
        router.addLiquidity(
            address(tokenA), address(tokenB),
            10 ether, 200 ether,  // desired way more B than pool ratio
            1, 200 ether,          // minB is unreachable
            bob, block.timestamp + 1
        );
    }

    function test_addLiquidity_revertInsufficientA() public {
        // Seed pool
        vm.prank(alice);
        router.addLiquidity(
            address(tokenA), address(tokenB),
            100 ether, 100 ether,
            1, 1,
            alice, block.timestamp + 1
        );

        vm.prank(bob);
        vm.expectRevert(IArchitexRouter.InsufficientAAmount.selector);
        router.addLiquidity(
            address(tokenA), address(tokenB),
            200 ether, 10 ether,  // desired more A than pool ratio
            200 ether, 1,          // minA unreachable
            bob, block.timestamp + 1
        );
    }

    // ─── removeLiquidity ──────────────────────────────────────────────────────

    function test_removeLiquidity_basic() public {
        vm.prank(alice);
        (,, uint256 liq) = router.addLiquidity(
            address(tokenA), address(tokenB),
            100 ether, 100 ether,
            1, 1,
            alice, block.timestamp + 1
        );

        address pair = factory.getPair(address(tokenA), address(tokenB));
        vm.prank(alice);
        IERC20(pair).approve(address(router), liq);

        vm.prank(alice);
        (uint256 out0, uint256 out1) = router.removeLiquidity(
            address(tokenA), address(tokenB),
            liq, 1, 1,
            alice, block.timestamp + 1
        );
        assertGt(out0, 0);
        assertGt(out1, 0);
    }

    // ─── removeLiquidityWithPermit ────────────────────────────────────────────

    function test_removeLiquidityWithPermit() public {
        uint256 privKey = 0xBEEF;
        address owner = vm.addr(privKey);

        tokenA.mint(owner, 100 ether);
        tokenB.mint(owner, 100 ether);
        vm.startPrank(owner);
        tokenA.approve(address(router), MAX);
        tokenB.approve(address(router), MAX);
        (,, uint256 liq) = router.addLiquidity(
            address(tokenA), address(tokenB),
            100 ether, 100 ether,
            1, 1,
            owner, block.timestamp + 1
        );
        vm.stopPrank();

        address pair = factory.getPair(address(tokenA), address(tokenB));
        ArchitexPair p = ArchitexPair(pair);

        bytes32 domSep = p.DOMAIN_SEPARATOR();
        bytes32 PERMIT_TYPEHASH = keccak256(
            "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
        );
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domSep,
            keccak256(abi.encode(PERMIT_TYPEHASH, owner, address(router), liq, p.nonces(owner), deadline))
        ));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privKey, digest);

        vm.prank(owner);
        (uint256 out0, uint256 out1) = router.removeLiquidityWithPermit(
            address(tokenA), address(tokenB),
            liq, 1, 1,
            owner, deadline, false, v, r, s
        );
        assertGt(out0, 0);
        assertGt(out1, 0);
    }

    // ─── swapExactTokensForTokens ─────────────────────────────────────────────

    function test_swapExact_singleHop() public {
        vm.prank(alice);
        router.addLiquidity(
            address(tokenA), address(tokenB),
            1000 ether, 1000 ether,
            1, 1,
            alice, block.timestamp + 1
        );

        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(tokenB);

        uint256 amtIn = 10 ether;
        uint256 minOut = router.getAmountOut(amtIn,
            _reserve(address(tokenA), address(tokenB), true),
            _reserve(address(tokenA), address(tokenB), false)
        );

        uint256 balBefore = tokenB.balanceOf(bob);
        vm.prank(bob);
        uint256[] memory amounts = router.swapExactTokensForTokens(amtIn, 1, path, bob, block.timestamp + 1);
        assertEq(amounts[1], minOut);
        assertEq(tokenB.balanceOf(bob) - balBefore, minOut);
    }

    function test_swapExact_twoHop() public {
        vm.prank(alice);
        router.addLiquidity(address(tokenA), address(tokenB), 1000 ether, 1000 ether, 1, 1, alice, block.timestamp + 1);
        vm.prank(alice);
        router.addLiquidity(address(tokenB), address(tokenC), 1000 ether, 1000 ether, 1, 1, alice, block.timestamp + 1);

        address[] memory path = new address[](3);
        path[0] = address(tokenA);
        path[1] = address(tokenB);
        path[2] = address(tokenC);

        uint256 balBefore = tokenC.balanceOf(bob);
        vm.prank(bob);
        uint256[] memory amounts = router.swapExactTokensForTokens(10 ether, 1, path, bob, block.timestamp + 1);
        assertGt(amounts[2], 0);
        assertEq(tokenC.balanceOf(bob) - balBefore, amounts[2]);
    }

    function test_swapExact_revertInsufficientOutput() public {
        vm.prank(alice);
        router.addLiquidity(address(tokenA), address(tokenB), 1000 ether, 1000 ether, 1, 1, alice, block.timestamp + 1);

        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(tokenB);

        vm.prank(bob);
        vm.expectRevert(IArchitexRouter.InsufficientOutputAmount.selector);
        router.swapExactTokensForTokens(1 ether, type(uint256).max, path, bob, block.timestamp + 1);
    }

    // ─── swapTokensForExactTokens ─────────────────────────────────────────────

    function test_swapForExact_singleHop() public {
        vm.prank(alice);
        router.addLiquidity(address(tokenA), address(tokenB), 1000 ether, 1000 ether, 1, 1, alice, block.timestamp + 1);

        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(tokenB);

        uint256 wantOut = 5 ether;
        uint256 maxIn = router.getAmountIn(wantOut,
            _reserve(address(tokenA), address(tokenB), true),
            _reserve(address(tokenA), address(tokenB), false)
        ) + 1 ether; // add buffer

        uint256 balBefore = tokenB.balanceOf(bob);
        vm.prank(bob);
        uint256[] memory amounts = router.swapTokensForExactTokens(wantOut, maxIn, path, bob, block.timestamp + 1);
        assertEq(amounts[amounts.length - 1], wantOut);
        assertEq(tokenB.balanceOf(bob) - balBefore, wantOut);
    }

    function test_swapForExact_twoHop() public {
        vm.prank(alice);
        router.addLiquidity(address(tokenA), address(tokenB), 1000 ether, 1000 ether, 1, 1, alice, block.timestamp + 1);
        vm.prank(alice);
        router.addLiquidity(address(tokenB), address(tokenC), 1000 ether, 1000 ether, 1, 1, alice, block.timestamp + 1);

        address[] memory path = new address[](3);
        path[0] = address(tokenA);
        path[1] = address(tokenB);
        path[2] = address(tokenC);

        uint256 wantOut = 5 ether;
        uint256 balBefore = tokenC.balanceOf(bob);
        vm.prank(bob);
        uint256[] memory amounts = router.swapTokensForExactTokens(wantOut, MAX, path, bob, block.timestamp + 1);
        assertEq(amounts[amounts.length - 1], wantOut);
        assertEq(tokenC.balanceOf(bob) - balBefore, wantOut);
    }

    function test_swapForExact_revertExcessiveInput() public {
        vm.prank(alice);
        router.addLiquidity(address(tokenA), address(tokenB), 1000 ether, 1000 ether, 1, 1, alice, block.timestamp + 1);

        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(tokenB);

        vm.prank(bob);
        vm.expectRevert(IArchitexRouter.ExcessiveInputAmount.selector);
        // maxIn of 0 is always less than required
        router.swapTokensForExactTokens(5 ether, 0, path, bob, block.timestamp + 1);
    }

    // ─── Deadline ─────────────────────────────────────────────────────────────

    function test_revertExpired_addLiquidity() public {
        vm.expectRevert(IArchitexRouter.Expired.selector);
        vm.prank(alice);
        router.addLiquidity(
            address(tokenA), address(tokenB),
            100 ether, 100 ether, 1, 1,
            alice, block.timestamp - 1 // expired
        );
    }

    function test_revertExpired_swap() public {
        vm.prank(alice);
        router.addLiquidity(address(tokenA), address(tokenB), 1000 ether, 1000 ether, 1, 1, alice, block.timestamp + 1);
        address[] memory path = new address[](2);
        path[0] = address(tokenA); path[1] = address(tokenB);
        vm.prank(bob);
        vm.expectRevert(IArchitexRouter.Expired.selector);
        router.swapExactTokensForTokens(1 ether, 1, path, bob, block.timestamp - 1);
    }

    // ─── InvalidPath ──────────────────────────────────────────────────────────

    function test_revertInvalidPath_tooShort() public {
        address[] memory path = new address[](1);
        path[0] = address(tokenA);
        vm.prank(bob);
        vm.expectRevert(IArchitexRouter.InvalidPath.selector);
        router.swapExactTokensForTokens(1 ether, 1, path, bob, block.timestamp + 1);
    }

    // ─── PairDoesNotExist ─────────────────────────────────────────────────────

    function test_revertPairDoesNotExist_swap() public {
        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(tokenB);
        vm.prank(bob);
        vm.expectRevert(IArchitexRouter.PairDoesNotExist.selector);
        router.swapExactTokensForTokens(1 ether, 1, path, bob, block.timestamp + 1);
    }

    // ─── 6-decimal token compatibility ───────────────────────────────────────

    function test_sixDecToken_swapWithEighteen() public {
        // Seed USDC(6dec)/tokenA(18dec) pool at 1 USDC = 1 tokenA
        vm.prank(alice);
        router.addLiquidity(
            address(token6), address(tokenA),
            1_000 * 1e6, 1_000 ether,
            1, 1,
            alice, block.timestamp + 1
        );

        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(token6);

        // Swap 1 tokenA → USDC
        uint256 balBefore = token6.balanceOf(bob);
        vm.prank(bob);
        router.swapExactTokensForTokens(1 ether, 1, path, bob, block.timestamp + 1);
        uint256 got = token6.balanceOf(bob) - balBefore;
        assertGt(got, 0);
        // Rough sanity: we expect roughly 1 USDC (1e6 units) out
        assertGt(got, 900000); // > 0.9 USDC
        assertLt(got, 1100000); // < 1.1 USDC
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    function _reserve(address tokenIn, address tokenOut, bool wantIn) internal view returns (uint256) {
        address pair = factory.getPair(tokenIn, tokenOut);
        (uint112 r0, uint112 r1,) = ArchitexPair(pair).getReserves();
        (address t0,) = tokenIn < tokenOut ? (tokenIn, tokenOut) : (tokenOut, tokenIn);
        if (wantIn)  return tokenIn  == t0 ? uint256(r0) : uint256(r1);
        else         return tokenOut == t0 ? uint256(r0) : uint256(r1);
    }
}
