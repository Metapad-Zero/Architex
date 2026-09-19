// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../ArchitexFactory.sol";
import "../ArchitexPair.sol";
import "../TestToken.sol";
import "../interfaces/IArchitexCallee.sol";

contract ArchitexPairTest is Test {
    ArchitexFactory factory;
    ArchitexPair    pair;
    TestToken      token0;
    TestToken      token1;

    address alice   = address(0xA11CE);
    address bob     = address(0xB0B);
    address feeTo   = address(0xFEE70);

    uint256 constant MINIMUM_LIQUIDITY = 1000;

    function setUp() public {
        factory = new ArchitexFactory(address(this));

        TestToken tA = new TestToken("Token A", "TKA", 18, 1_000_000, address(this));
        TestToken tB = new TestToken("Token B", "TKB", 18, 1_000_000, address(this));

        // Ensure deterministic token0/token1 order
        if (address(tA) < address(tB)) {
            token0 = tA; token1 = tB;
        } else {
            token0 = tB; token1 = tA;
        }

        address pairAddr = factory.createPair(address(token0), address(token1));
        pair = ArchitexPair(pairAddr);

        // Fund alice and bob
        token0.mint(alice, 1_000_000 ether);
        token1.mint(alice, 1_000_000 ether);
        token0.mint(bob,   1_000_000 ether);
        token1.mint(bob,   1_000_000 ether);
        // Fund test contract itself for direct pair calls
        token0.mint(address(this), 2_000_000 ether);
        token1.mint(address(this), 2_000_000 ether);
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    function _addLiquidity(address from, uint256 amt0, uint256 amt1) internal returns (uint256 liq) {
        vm.startPrank(from);
        token0.transfer(address(pair), amt0);
        token1.transfer(address(pair), amt1);
        liq = pair.mint(from);
        vm.stopPrank();
    }

    function _sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) { z = x; x = (y / x + x) / 2; }
        } else if (y != 0) {
            z = 1;
        }
    }

    // ─── Mint ─────────────────────────────────────────────────────────────────

    function test_firstMint_burnsMINIMUM_LIQUIDITY() public {
        uint256 amt0 = 1 ether;
        uint256 amt1 = 4 ether;

        token0.transfer(address(pair), amt0);
        token1.transfer(address(pair), amt1);
        uint256 liq = pair.mint(alice);

        uint256 expectedLiq = _sqrt(amt0 * amt1) - MINIMUM_LIQUIDITY;
        assertEq(liq, expectedLiq);
        assertEq(pair.totalSupply(), expectedLiq + MINIMUM_LIQUIDITY);
        assertEq(pair.balanceOf(address(0x000000000000000000000000000000000000dEaD)), MINIMUM_LIQUIDITY);
        assertEq(pair.balanceOf(alice), expectedLiq);
    }

    function test_proportionalMint() public {
        _addLiquidity(alice, 100 ether, 100 ether);

        uint256 ts = pair.totalSupply();
        (uint112 r0, uint112 r1,) = pair.getReserves();

        uint256 add0 = 50 ether;
        uint256 add1 = 50 ether;
        uint256 expectedLiq = min(add0 * ts / r0, add1 * ts / r1);

        vm.startPrank(bob);
        token0.transfer(address(pair), add0);
        token1.transfer(address(pair), add1);
        uint256 liq = pair.mint(bob);
        vm.stopPrank();

        assertEq(liq, expectedLiq);
    }

    function test_mint_revertIfZeroLiquidity() public {
        // sqrt(1*1) - 1000 underflows; first mint must fail
        // Transfer only 1 wei each
        token0.transfer(address(pair), 1);
        token1.transfer(address(pair), 1);
        // This reverts with arithmetic underflow (0 - 1000 underflows), not InsufficientLiquidityMinted
        vm.expectRevert();
        pair.mint(alice);
    }

    // ─── Burn ─────────────────────────────────────────────────────────────────

    function test_burn_proRata() public {
        uint256 amt0 = 100 ether;
        uint256 amt1 = 200 ether;
        uint256 liq  = _addLiquidity(alice, amt0, amt1);

        uint256 ts = pair.totalSupply();
        uint256 b0 = token0.balanceOf(address(pair));
        uint256 b1 = token1.balanceOf(address(pair));
        uint256 exp0 = liq * b0 / ts;
        uint256 exp1 = liq * b1 / ts;

        vm.startPrank(alice);
        pair.transfer(address(pair), liq);
        (uint256 out0, uint256 out1) = pair.burn(alice);
        vm.stopPrank();

        assertEq(out0, exp0);
        assertEq(out1, exp1);
    }

    function test_burn_revertIfInsufficient() public {
        _addLiquidity(alice, 1 ether, 1 ether);
        // Transfer 0 LP
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(bytes4(keccak256("InsufficientLiquidityBurned()"))));
        pair.burn(alice);
    }

    // ─── Swap ─────────────────────────────────────────────────────────────────

    function test_swap_exactMatchesGetAmountOut() public {
        _addLiquidity(alice, 1000 ether, 1000 ether);

        (uint112 r0, uint112 r1,) = pair.getReserves();
        uint256 amtIn = 10 ether;
        uint256 amtInFee = amtIn * 997;
        uint256 expectedOut = amtInFee * uint256(r1) / (uint256(r0) * 1000 + amtInFee);

        uint256 balBefore = token1.balanceOf(bob);
        vm.prank(bob);
        token0.transfer(address(pair), amtIn);
        pair.swap(0, expectedOut, bob, new bytes(0));
        assertEq(token1.balanceOf(bob) - balBefore, expectedOut);
    }

    function test_swap_reverseDirection() public {
        _addLiquidity(alice, 1000 ether, 1000 ether);
        uint256 amtIn = 5 ether;
        (uint112 r0, uint112 r1,) = pair.getReserves();
        uint256 amtInFee = amtIn * 997;
        uint256 expectedOut = amtInFee * uint256(r0) / (uint256(r1) * 1000 + amtInFee);

        uint256 balBefore = token0.balanceOf(bob);
        vm.prank(bob);
        token1.transfer(address(pair), amtIn);
        pair.swap(expectedOut, 0, bob, new bytes(0));
        assertEq(token0.balanceOf(bob) - balBefore, expectedOut);
    }

    function test_swap_revertInsufficientOutput() public {
        _addLiquidity(alice, 1000 ether, 1000 ether);
        vm.expectRevert(abi.encodeWithSelector(bytes4(keccak256("InsufficientOutputAmount()"))));
        pair.swap(0, 0, bob, new bytes(0));
    }

    function test_swap_revertInsufficientLiquidity() public {
        _addLiquidity(alice, 1000 ether, 1000 ether);
        vm.expectRevert(abi.encodeWithSelector(bytes4(keccak256("InsufficientLiquidity()"))));
        pair.swap(1001 ether, 0, bob, new bytes(0));
    }

    function test_swap_revertInvalidTo() public {
        _addLiquidity(alice, 1000 ether, 1000 ether);
        token0.transfer(address(pair), 1 ether);
        vm.expectRevert(abi.encodeWithSelector(bytes4(keccak256("InvalidTo()"))));
        pair.swap(0, 1, address(token0), new bytes(0));
    }

    function test_swap_revertKViolation() public {
        _addLiquidity(alice, 1000 ether, 1000 ether);
        // Send in some token0, but request MORE token1 than what the fee math allows
        // This should hit the K check
        token0.transfer(address(pair), 1 ether);
        vm.expectRevert(abi.encodeWithSelector(bytes4(keccak256("K()"))));
        // Request 1.5 ether out when only ~0.997 ether should be allowed
        pair.swap(0, 1.5 ether, bob, new bytes(0));
    }

    // ─── K invariant fuzz ─────────────────────────────────────────────────────

    function testFuzz_kInvariant(uint256 amtIn) public {
        _addLiquidity(alice, 1000 ether, 1000 ether);
        amtIn = bound(amtIn, 1e15, 100 ether); // min 0.001 ether to ensure non-zero output

        (uint112 r0, uint112 r1,) = pair.getReserves();
        uint256 kBefore = uint256(r0) * uint256(r1);

        uint256 amtInFee = amtIn * 997;
        uint256 expectedOut = amtInFee * uint256(r1) / (uint256(r0) * 1000 + amtInFee);
        if (expectedOut == 0) return; // skip dust inputs

        vm.prank(alice);
        token0.transfer(address(pair), amtIn);
        pair.swap(0, expectedOut, bob, new bytes(0));

        (uint112 nr0, uint112 nr1,) = pair.getReserves();
        uint256 kAfter = uint256(nr0) * uint256(nr1);

        assertGe(kAfter, kBefore, "K must not decrease after swap");
    }

    // ─── Reentrancy guard ─────────────────────────────────────────────────────

    function test_reentrancyLock_swap() public {
        // Seed pool so there's something to swap
        token0.transfer(address(pair), 100 ether);
        token1.transfer(address(pair), 100 ether);
        pair.mint(alice);

        // ReentrantSwapper uses flash-swap callback to call swap again
        ReentrantSwapper attacker = new ReentrantSwapper(pair, token0, token1);
        token0.mint(address(attacker), 10 ether);
        token1.mint(address(attacker), 10 ether);

        vm.expectRevert(abi.encodeWithSelector(bytes4(keccak256("Locked()"))));
        attacker.attack();
    }

    // ─── Skim / Sync ──────────────────────────────────────────────────────────

    function test_skim_removesExcess() public {
        _addLiquidity(alice, 100 ether, 100 ether);
        // Send extra token0 directly
        token0.transfer(address(pair), 5 ether);

        uint256 balBefore = token0.balanceOf(bob);
        pair.skim(bob);
        assertEq(token0.balanceOf(bob) - balBefore, 5 ether);
    }

    function test_sync_updatesReserves() public {
        _addLiquidity(alice, 100 ether, 100 ether);
        token0.transfer(address(pair), 10 ether);
        token1.transfer(address(pair), 20 ether);
        pair.sync();
        (uint112 r0, uint112 r1,) = pair.getReserves();
        assertEq(r0, 110 ether);
        assertEq(r1, 120 ether);
    }

    // ─── Cumulative price ─────────────────────────────────────────────────────

    function test_cumulativePrice_advances() public {
        // Warp to a non-zero starting time so blockTimestampLast != block.timestamp+60
        vm.warp(1_000_000);
        _addLiquidity(alice, 100 ether, 400 ether);
        uint256 cp0Before = pair.price0CumulativeLast();
        vm.warp(1_000_060);
        pair.sync();
        uint256 cp0After = pair.price0CumulativeLast();
        assertGt(cp0After, cp0Before, "cumulative price must advance");
    }

    // ─── Protocol fee ─────────────────────────────────────────────────────────

    function test_protocolFee_mintedToFeeTo() public {
        factory.setFeeTo(feeTo);

        // Initial liquidity — sets kLast.
        _addLiquidity(alice, 1000 ether, 1000 ether);

        // Swap to grow k.
        vm.prank(bob);
        token0.transfer(address(pair), 100 ether);
        {
            (uint112 r0b, uint112 r1b,) = pair.getReserves();
            uint256 aIn = 100 ether;
            uint256 expectedOut = (aIn * 997 * uint256(r1b)) / (uint256(r0b) * 1000 + aIn * 997);
            pair.swap(0, expectedOut, bob, new bytes(0));
        }

        uint256 feeBalBefore = pair.balanceOf(feeTo);
        // Trigger _mintFee by adding liquidity.
        token0.transfer(address(pair), 1 ether);
        token1.transfer(address(pair), 1 ether);
        pair.mint(alice);

        uint256 feeBalAfter = pair.balanceOf(feeTo);
        assertGt(feeBalAfter, feeBalBefore, "protocol fee not minted");
    }

    // ─── EIP-2612 permit ──────────────────────────────────────────────────────

    function test_permit_roundTrip() public {
        uint256 privKey = 0xBEEF;
        address owner = vm.addr(privKey);

        // Give owner some LP.
        token0.mint(owner, 100 ether);
        token1.mint(owner, 100 ether);
        vm.startPrank(owner);
        token0.transfer(address(pair), 100 ether);
        token1.transfer(address(pair), 100 ether);
        uint256 liq = pair.mint(owner);
        vm.stopPrank();

        // Build EIP-712 digest.
        bytes32 domSep = pair.DOMAIN_SEPARATOR();
        bytes32 PERMIT_TYPEHASH = keccak256(
            "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
        );
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(PERMIT_TYPEHASH, owner, address(this), liq, pair.nonces(owner), deadline)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domSep, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privKey, digest);

        pair.permit(owner, address(this), liq, deadline, v, r, s);
        assertEq(pair.allowance(owner, address(this)), liq);
        // transferFrom succeeds
        pair.transferFrom(owner, address(this), liq);
        assertEq(pair.balanceOf(address(this)), liq);
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    function min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}

// ─── Reentrancy attacker (flash swap) ─────────────────────────────────────────

contract ReentrantSwapper is IArchitexCallee {
    ArchitexPair pair;
    TestToken   t0;
    TestToken   t1;

    constructor(ArchitexPair _pair, TestToken _t0, TestToken _t1) {
        pair = _pair; t0 = _t0; t1 = _t1;
    }

    function attack() external {
        // Request a flash-swap of 1 ether of token1, callback will try to re-enter swap.
        pair.swap(0, 1 ether, address(this), abi.encode(uint256(1)));
    }

    function architexCall(address, uint256, uint256, bytes calldata) external override {
        // Try to re-enter swap — should revert with Locked()
        pair.swap(0, 1 ether, address(this), new bytes(0));
    }
}
