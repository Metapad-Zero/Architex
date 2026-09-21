// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "forge-std/StdInvariant.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "./launchpad/LaunchpadV13Base.sol";

// ─── Invariant handler ────────────────────────────────────────────────────────

contract LaunchpadHandler is Test {
    ArchitexLaunchpad public pad;
    BlockableUSDC public usdc;
    address public token;
    address public alice;

    constructor(ArchitexLaunchpad _pad, BlockableUSDC _usdc, address _token, address _alice) {
        pad = _pad;
        usdc = _usdc;
        token = _token;
        alice = _alice;
    }

    function buy(uint96 rawAmount) public {
        if (pad.isGraduated(token)) return;
        uint256 amount = bound(uint256(rawAmount), 1e4, 500e6); // 0.01–500 USDC
        usdc.mint(alice, amount);
        vm.startPrank(alice);
        usdc.approve(address(pad), amount);
        pad.buy(token, amount, 0, alice);
        vm.stopPrank();
    }

    function sell(uint96 rawAmount) public {
        if (pad.isGraduated(token)) return;
        uint256 bal = IERC20(token).balanceOf(alice);
        if (bal == 0) return;
        uint256 amount = bound(uint256(rawAmount), 1, bal);
        vm.prank(alice);
        try pad.sell(token, amount, 0, alice) {} catch {} // dust worth nothing is refused by design
    }

    function collect() public {
        pad.collectFees();
        pad.collectCreatorFees(token);
    }
}

// ─── Main test contract ───────────────────────────────────────────────────────

/// @notice The v1.2 unit suite, ported to v1.3 (launch pairs, pull, creator fees at 0% unless stated).
contract ArchitexLaunchpadTest is LaunchpadV13Base {
    uint256 constant LAUNCH_FEE = 5e6; // 5 USDC

    function setUp() public override {
        usdc = new BlockableUSDC();
        (pad, pairFactory, router) = _deploySuite(address(usdc), LAUNCH_FEE);
        _fund(alice);
        _fund(bob);
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    function _createToken() internal returns (address token) {
        vm.prank(alice);
        token = pad.createToken("TestCoin", "TEST", "ipfs://abc", 0, alice, "", 0, 0);
    }

    /// @notice Buy enough USDC to graduate the curve. Returns the token.
    function _graduateToken() internal returns (address token) {
        vm.prank(alice);
        token = pad.createToken("GradCoin", "GRAD", "ipfs://g", 0, alice, "", 0, 0);
        // A sell-out costs about 25,126 USDC; 30,000 in one shot graduates.
        vm.prank(alice);
        pad.buy(token, 30_000e6, 0, alice);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Section 1 — Deployment and constants
    // ═══════════════════════════════════════════════════════════════════════════

    function test_constants() public view {
        assertEq(pad.TOTAL_SUPPLY(), TOTAL_SUPPLY);
        assertEq(pad.CURVE_SUPPLY(), CURVE_SUPPLY);
        assertEq(pad.POOL_SUPPLY(), POOL_SUPPLY);
        assertEq(pad.VIRTUAL_TOKENS_0(), VIRTUAL_TOKENS_0);
        assertEq(pad.VIRTUAL_USDC_0(), VIRTUAL_USDC_0);
        assertEq(pad.FEE_BPS(), FEE_BPS);
        assertEq(pad.MAX_LAUNCH_FEE(), 100e6);
        assertEq(pad.MAX_CREATOR_FEE_BPS(), 1000);
        assertEq(pad.POOL_SUPPLY() + pad.CURVE_SUPPLY(), TOTAL_SUPPLY);
        assertEq(pad.usdc(), address(usdc));
        assertEq(pad.pairFactory(), address(pairFactory));
        assertEq(pad.router(), address(router));
    }

    function test_constructor_zeroAddressReverts() public {
        vm.expectRevert(IArchitexLaunchpad.ZeroAddress.selector);
        new ArchitexLaunchpad(address(0), feeTo, setter, 0);
        vm.expectRevert(IArchitexLaunchpad.ZeroAddress.selector);
        new ArchitexLaunchpad(address(usdc), address(0), setter, 0);
        vm.expectRevert(IArchitexLaunchpad.ZeroAddress.selector);
        new ArchitexLaunchpad(address(usdc), feeTo, address(0), 0);
    }

    function test_constructor_launchFeeTooHigh() public {
        vm.expectRevert(IArchitexLaunchpad.LaunchFeeTooHigh.selector);
        new ArchitexLaunchpad(address(usdc), feeTo, setter, 100e6 + 1);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Section 2 — createToken
    // ═══════════════════════════════════════════════════════════════════════════

    function test_createToken_basic() public {
        uint256 feesBefore = pad.pendingFees();
        vm.prank(alice);
        address token = pad.createToken("My Coin", "MCOIN", "ipfs://meta", 250, bob, "", 0, 0);

        // Launch fee accrued
        assertEq(pad.pendingFees(), feesBefore + LAUNCH_FEE);

        // Token has the whole supply at the launchpad
        assertEq(IERC20(token).totalSupply(), TOTAL_SUPPLY);
        assertEq(IERC20(token).balanceOf(address(pad)), TOTAL_SUPPLY);
        assertEq(ILaunchToken(token).launchpad(), address(pad));
        assertEq(ILaunchToken(token).router(), address(router));
        assertEq(ILaunchToken(token).usdc(), address(usdc));

        // Curve registered
        IArchitexLaunchpad.Curve memory c = pad.curves(token);
        assertEq(c.token, token);
        assertEq(c.creator, alice);
        assertEq(c.virtualUsdc, VIRTUAL_USDC_0);
        assertEq(c.virtualTokens, VIRTUAL_TOKENS_0);
        assertEq(c.tokensSold, 0);
        assertFalse(c.graduated);
        assertEq(c.creatorFeeBps, 250);
        assertEq(c.plugin, bob);
        assertEq(c.metadataURI, "ipfs://meta");
        assertEq(c.createdAt, block.timestamp);

        // Launch pair created by the launch-pair factory and registered on the token
        address pair = pairFactory.getPair(token);
        assertNotEq(pair, address(0));
        assertEq(c.pair, pair);
        assertEq(ILaunchToken(token).pair(), pair);
        assertEq(LaunchPair(pair).token(), token);
        assertEq(LaunchPair(pair).usdc(), address(usdc));
        assertEq(LaunchPair(pair).router(), address(router));
        assertEq(LaunchPair(pair).factory(), address(pairFactory));
        assertEq(pairFactory.allPairsLength(), 1);
        assertEq(pairFactory.allPairs(0), pair);

        // Token array
        assertEq(pad.tokensLength(), 1);
        assertEq(pad.tokenAt(0), token);
    }

    function test_createToken_initialBuy() public {
        vm.prank(alice);
        address token = pad.createToken("Coin", "COIN", "ipfs://x", 0, alice, "", 10e6, 0);
        assertGt(IERC20(token).balanceOf(alice), 0);
    }

    function test_createToken_initialBuyZeroSkipsWithoutRevert() public {
        vm.prank(alice);
        address token = pad.createToken("Coin", "COIN", "ipfs://x", 0, alice, "", 0, type(uint256).max);
        assertEq(pad.curves(token).tokensSold, 0);
    }

    /// @notice v1.2 had to tolerate a squatted core pair. Launch pairs can only be created by the launchpad.
    function test_createToken_launchPairCannotBePreCreated() public {
        address predicted = vm.computeCreateAddress(address(pad), vm.getNonce(address(pad)));
        vm.prank(mallory);
        vm.expectRevert(ILaunchPairFactory.OnlyLaunchpad.selector);
        pairFactory.createPair(predicted);
        address token = _createToken();
        assertEq(token, predicted);
        assertEq(pad.curves(token).pair, pairFactory.getPair(token));
    }

    // ─── Name/symbol/metadata length limits ──────────────────────────────────

    function test_createToken_invalidName_empty() public {
        vm.prank(alice);
        vm.expectRevert(IArchitexLaunchpad.InvalidName.selector);
        pad.createToken("", "SYM", "ipfs://x", 0, alice, "", 0, 0);
    }

    function test_createToken_invalidName_tooLong() public {
        vm.prank(alice);
        vm.expectRevert(IArchitexLaunchpad.InvalidName.selector);
        pad.createToken("123456789012345678901234567890123", "SYM", "ipfs://x", 0, alice, "", 0, 0); // 33 bytes
    }

    function test_createToken_invalidSymbol_empty() public {
        vm.prank(alice);
        vm.expectRevert(IArchitexLaunchpad.InvalidSymbol.selector);
        pad.createToken("Name", "", "ipfs://x", 0, alice, "", 0, 0);
    }

    function test_createToken_invalidSymbol_tooLong() public {
        vm.prank(alice);
        vm.expectRevert(IArchitexLaunchpad.InvalidSymbol.selector);
        pad.createToken("Name", "12345678901", "ipfs://x", 0, alice, "", 0, 0); // 11 bytes
    }

    function test_createToken_invalidMetadata_tooLong() public {
        string memory longUri = new string(257);
        vm.prank(alice);
        vm.expectRevert(IArchitexLaunchpad.InvalidMetadata.selector);
        pad.createToken("Name", "SYM", longUri, 0, alice, "", 0, 0);
    }

    function test_createToken_exactMaxLengths() public {
        // 32-byte name, 10-byte symbol, 256-byte URI — all OK
        string memory name32 = "12345678901234567890123456789012";
        string memory sym10 = "1234567890";
        bytes memory uriBytes = new bytes(256);
        for (uint256 i; i < 256; i++) {
            uriBytes[i] = "a";
        }
        vm.prank(alice);
        pad.createToken(name32, sym10, string(uriBytes), 0, alice, "", 0, 0); // should not revert
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Section 3 — Buy math correctness (creator fee 0)
    // ═══════════════════════════════════════════════════════════════════════════

    function test_buy_basicMath() public {
        address token = _createToken();

        uint256 usdcIn = 100e6;
        uint256 fee = _divCeil(usdcIn * FEE_BPS, 10_000);
        uint256 net = usdcIn - fee;
        uint256 k = VIRTUAL_USDC_0 * VIRTUAL_TOKENS_0;
        uint256 expectedTokens = VIRTUAL_TOKENS_0 - _divCeil(k, VIRTUAL_USDC_0 + net);

        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 feesBefore = pad.pendingFees();

        vm.prank(alice);
        (uint256 tokensOut, uint256 usdcSpent) = pad.buy(token, usdcIn, 0, alice);

        assertEq(tokensOut, expectedTokens);
        assertEq(usdcSpent, usdcIn);
        assertEq(usdc.balanceOf(alice), aliceBefore - usdcIn);
        assertEq(pad.pendingFees(), feesBefore + fee);
        assertEq(pad.pendingCreatorFees(token), 0);
        assertEq(IERC20(token).balanceOf(alice), expectedTokens);

        IArchitexLaunchpad.Curve memory c = pad.curves(token);
        assertEq(c.virtualUsdc, VIRTUAL_USDC_0 + net);
        assertEq(c.virtualTokens, VIRTUAL_TOKENS_0 - expectedTokens);
        assertEq(c.tokensSold, expectedTokens);
    }

    function test_buy_zeroAmountReverts() public {
        address token = _createToken();
        vm.prank(alice);
        vm.expectRevert(IArchitexLaunchpad.ZeroAmount.selector);
        pad.buy(token, 0, 0, alice);
    }

    function test_buy_unknownTokenReverts() public {
        vm.prank(alice);
        vm.expectRevert(IArchitexLaunchpad.UnknownToken.selector);
        pad.buy(address(0xdead), 1e6, 0, alice);
    }

    function test_buy_slippageReverts() public {
        address token = _createToken();
        vm.prank(alice);
        vm.expectRevert(IArchitexLaunchpad.SlippageExceeded.selector);
        pad.buy(token, 10e6, type(uint256).max, alice);
    }

    function test_sell_basicMath() public {
        address token = _createToken();
        vm.prank(alice);
        (uint256 tokensOut,) = pad.buy(token, 100e6, 0, alice);

        IArchitexLaunchpad.Curve memory c = pad.curves(token);
        uint256 k = uint256(c.virtualUsdc) * uint256(c.virtualTokens);
        uint256 tokensToSell = tokensOut / 2;
        uint256 gross = uint256(c.virtualUsdc) - _divCeil(k, uint256(c.virtualTokens) + tokensToSell);
        uint256 fee = _divCeil(gross * FEE_BPS, 10_000);
        uint256 expectedUsdc = gross - fee;

        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 feesBefore = pad.pendingFees();

        // No approval: the launchpad pulls through the token
        assertEq(IERC20(token).allowance(alice, address(pad)), 0);
        vm.prank(alice);
        uint256 usdcOut = pad.sell(token, tokensToSell, 0, alice);

        assertEq(usdcOut, expectedUsdc);
        assertEq(usdc.balanceOf(alice), aliceBefore + expectedUsdc);
        assertEq(pad.pendingFees(), feesBefore + fee);
    }

    function test_sell_zeroAmountReverts() public {
        address token = _createToken();
        vm.prank(alice);
        vm.expectRevert(IArchitexLaunchpad.ZeroAmount.selector);
        pad.sell(token, 0, 0, alice);
    }

    function test_sell_slippageReverts() public {
        address token = _createToken();
        vm.prank(alice);
        pad.buy(token, 100e6, 0, alice);
        uint256 bal = IERC20(token).balanceOf(alice);
        vm.prank(alice);
        vm.expectRevert(IArchitexLaunchpad.SlippageExceeded.selector);
        pad.sell(token, bal, type(uint256).max, alice);
    }

    // ─── pull: launchpad (into itself) and router (into the pair) only ───────

    function test_pull_onlyLaunchpadOrRouter() public {
        address token = _createToken();
        vm.prank(alice);
        pad.buy(token, 100e6, 0, alice);
        vm.prank(bob);
        vm.expectRevert(ILaunchToken.OnlyLaunchpadOrRouter.selector);
        ILaunchToken(token).pull(alice, bob, 1);
    }

    function test_pull_destinationIsFixedPerCaller() public {
        address token = _createToken();
        vm.prank(alice);
        pad.buy(token, 100e6, 0, alice);
        address pair = pad.pairOf(token);

        vm.startPrank(address(pad));
        vm.expectRevert(ILaunchToken.InvalidPullTarget.selector);
        ILaunchToken(token).pull(alice, bob, 1);
        vm.expectRevert(ILaunchToken.InvalidPullTarget.selector);
        ILaunchToken(token).pull(alice, pair, 1);
        vm.stopPrank();

        vm.startPrank(address(router));
        vm.expectRevert(ILaunchToken.InvalidPullTarget.selector);
        ILaunchToken(token).pull(alice, bob, 1);
        vm.expectRevert(ILaunchToken.InvalidPullTarget.selector);
        ILaunchToken(token).pull(alice, address(pad), 1);
        // Into the pair, but the pair is locked until graduation
        vm.expectRevert(ILaunchToken.PairLockedUntilGraduation.selector);
        ILaunchToken(token).pull(alice, pair, 1);
        vm.stopPrank();
    }

    // ─── initPair only-once / only-launchpad ─────────────────────────────────

    function test_initPair_onlyLaunchpad() public {
        address token = _createToken();
        vm.prank(alice);
        vm.expectRevert(ILaunchToken.OnlyLaunchpad.selector);
        ILaunchToken(token).initPair(address(0x1));
    }

    function test_initPair_onlyOnce() public {
        address token = _createToken();
        vm.prank(address(pad));
        vm.expectRevert(ILaunchToken.PairAlreadySet.selector);
        ILaunchToken(token).initPair(address(0x2));
    }

    // ─── markGraduated only-once / only-launchpad ────────────────────────────

    function test_markGraduated_onlyLaunchpad() public {
        address token = _createToken();
        vm.prank(alice);
        vm.expectRevert(ILaunchToken.OnlyLaunchpad.selector);
        ILaunchToken(token).markGraduated();
    }

    function test_markGraduated_onlyOnce() public {
        address token = _graduateToken();
        vm.prank(address(pad));
        vm.expectRevert(ILaunchToken.AlreadyGraduated.selector);
        ILaunchToken(token).markGraduated();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Section 4 — Transfer to pair blocked before graduation
    // ═══════════════════════════════════════════════════════════════════════════

    function test_transferToPair_revertBeforeGraduation() public {
        address token = _createToken();
        vm.prank(alice);
        pad.buy(token, 100e6, 0, alice);
        address pairAddr = pad.curves(token).pair;

        vm.prank(alice);
        vm.expectRevert(ILaunchToken.PairLockedUntilGraduation.selector);
        IERC20(token).transfer(pairAddr, 1);

        vm.prank(alice);
        IERC20(token).approve(bob, 1);
        vm.prank(bob);
        vm.expectRevert(ILaunchToken.PairLockedUntilGraduation.selector);
        IERC20(token).transferFrom(alice, pairAddr, 1);
    }

    function test_transferToPair_succeedsAfterGraduation() public {
        address token = _graduateToken();
        address pairAddr = pad.curves(token).pair;
        assertTrue(ILaunchToken(token).graduated());
        vm.prank(alice);
        IERC20(token).transfer(pairAddr, 1e18); // should not revert
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Section 5 — Graduation
    // ═══════════════════════════════════════════════════════════════════════════

    function test_graduation_basic() public {
        address token = _graduateToken();
        IArchitexLaunchpad.Curve memory c = pad.curves(token);
        assertTrue(c.graduated);
        assertTrue(pad.isGraduated(token));
        assertEq(c.tokensSold, CURVE_SUPPLY);
        assertEq(IERC20(token).balanceOf(address(pad)), 0, "the launchpad keeps no tokens");
    }

    function test_graduation_lpAtDead() public {
        address token = _graduateToken();
        LaunchPair pair = _pairOf(token);
        uint256 totalLp = pair.totalSupply();
        assertGt(totalLp, 0);
        // MINIMUM_LIQUIDITY and the graduation LP both go to DEAD
        assertEq(pair.balanceOf(DEAD), totalLp);
    }

    function test_graduation_poolPriceMatchesCurveFinalPrice() public {
        address token = _graduateToken();
        IArchitexLaunchpad.Curve memory c = pad.curves(token);
        (uint112 reserveToken, uint112 reserveUsdc,) = _pairOf(token).getReserves();
        assertEq(reserveToken, POOL_SUPPLY);

        uint256 poolPrice = uint256(reserveUsdc) * 1e18 / uint256(reserveToken);
        uint256 curvePrice = uint256(c.virtualUsdc) * 1e18 / uint256(c.virtualTokens);
        uint256 diff = poolPrice > curvePrice ? poolPrice - curvePrice : curvePrice - poolPrice;
        assertLt(diff * 1e6, curvePrice, "pool price deviates from curve final price by more than 1e-6");
    }

    function test_graduation_buyAfterReverts() public {
        address token = _graduateToken();
        vm.prank(alice);
        vm.expectRevert(IArchitexLaunchpad.CurveGraduated.selector);
        pad.buy(token, 1e6, 0, alice);
    }

    function test_graduation_sellAfterReverts() public {
        address token = _graduateToken();
        vm.prank(alice);
        vm.expectRevert(IArchitexLaunchpad.CurveGraduated.selector);
        pad.sell(token, 1e18, 0, alice);
    }

    function test_graduation_withDonatedUsdcAndSync() public {
        vm.prank(alice);
        address token = pad.createToken("DonCoin", "DON", "ipfs://d", 0, alice, "", 0, 0);
        address pairAddr = pad.curves(token).pair;

        // Attacker donates USDC and syncs the pair (reserves become (0, x))
        usdc.mint(address(this), 100e6);
        usdc.transfer(pairAddr, 100e6);
        LaunchPair(pairAddr).sync();

        // Graduation still works (direct mint on deltas is immune to sync)
        vm.prank(alice);
        pad.buy(token, 30_000e6, 0, alice);
        assertTrue(pad.curves(token).graduated);
        assertGt(LaunchPair(pairAddr).totalSupply(), 0);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Section 6 — Exact-fill on last buy
    // ═══════════════════════════════════════════════════════════════════════════

    function test_exactFill_noDustNoOvercharge() public {
        vm.prank(alice);
        address token = pad.createToken("ExactCoin", "EXACT", "ipfs://e", 0, alice, "", 0, 0);

        vm.prank(alice);
        pad.buy(token, 24_000e6, 0, alice);

        IArchitexLaunchpad.Curve memory c = pad.curves(token);
        assertFalse(c.graduated);
        uint256 remaining = CURVE_SUPPLY - c.tokensSold;
        assertGt(remaining, 0);

        uint256 k = uint256(c.virtualUsdc) * uint256(c.virtualTokens);
        uint256 net = _divCeil(k, uint256(c.virtualTokens) - remaining) - uint256(c.virtualUsdc);
        uint256 fee = _divCeil(net * FEE_BPS, 10_000 - FEE_BPS);
        uint256 exactTotal = net + fee;

        uint256 aliceBefore = usdc.balanceOf(alice);
        // Offer three times more: the exact fill pulls only exactTotal
        vm.prank(alice);
        (uint256 tokensOut, uint256 usdcSpent) = pad.buy(token, exactTotal * 3, 0, alice);

        assertEq(tokensOut, remaining, "tokensOut != remaining");
        assertEq(usdcSpent, exactTotal, "usdcSpent != exactTotal");
        assertEq(usdc.balanceOf(alice), aliceBefore - exactTotal, "wrong USDC pulled");
        assertEq(pad.curves(token).tokensSold, CURVE_SUPPLY, "tokensSold != CURVE_SUPPLY");
        assertTrue(pad.curves(token).graduated, "not graduated");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Section 7 — Solvency: USDC held == fees + creator fees + Σ live floats
    // ═══════════════════════════════════════════════════════════════════════════

    function test_solvency_afterBuys() public {
        address t1 = _createToken();
        vm.prank(alice);
        pad.buy(t1, 500e6, 0, alice);
        vm.prank(bob);
        pad.buy(t1, 200e6, 0, bob);

        vm.prank(bob);
        address t2 = pad.createToken("Coin2", "C2", "ipfs://2", 700, bob, "", 0, 0);
        vm.prank(alice);
        pad.buy(t2, 1_000e6, 0, alice);

        _assertSolvent();
    }

    function test_solvency_afterBuysAndSells() public {
        vm.prank(alice);
        address t1 = pad.createToken("Coin1", "C1", "", 300, alice, "", 0, 0);
        vm.prank(alice);
        pad.buy(t1, 500e6, 0, alice);
        uint256 halfTokens = IERC20(t1).balanceOf(alice) / 2;
        vm.prank(alice);
        pad.sell(t1, halfTokens, 0, alice);

        _assertSolvent();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Section 8 — Fuzzed round-trip (buy then sell same amount, never profit)
    // ═══════════════════════════════════════════════════════════════════════════

    function testFuzz_roundTrip_neverProfit(uint96 rawUsdcIn, uint16 rawCreatorFee) public {
        uint256 usdcIn = bound(uint256(rawUsdcIn), 1e4, 500e6); // 0.01–500 USDC
        uint16 creatorFeeBps = uint16(bound(uint256(rawCreatorFee), 0, 1000));
        vm.prank(alice);
        address token = pad.createToken("Trip", "TRIP", "", creatorFeeBps, alice, "", 0, 0);

        uint256 aliceBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        (uint256 tokensOut, uint256 spent) = pad.buy(token, usdcIn, 0, alice);

        vm.prank(alice);
        try pad.sell(token, tokensOut, 0, alice) returns (uint256 usdcBack) {
            assertLe(usdcBack, spent, "sell returned more than buy cost");
        } catch {
            return; // proceeds consumed by fees: refused, nothing returned
        }
        assertLe(usdc.balanceOf(alice), aliceBefore, "round trip profit detected");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Section 9 — k non-decreasing
    // ═══════════════════════════════════════════════════════════════════════════

    function test_k_nonDecreasing_afterBuy() public {
        address token = _createToken();
        IArchitexLaunchpad.Curve memory c = pad.curves(token);
        uint256 kBefore = uint256(c.virtualUsdc) * uint256(c.virtualTokens);

        vm.prank(alice);
        pad.buy(token, 100e6, 0, alice);

        c = pad.curves(token);
        uint256 kAfter = uint256(c.virtualUsdc) * uint256(c.virtualTokens);
        assertGe(kAfter, kBefore, "k decreased on buy");
    }

    function test_k_nonDecreasing_afterSell() public {
        address token = _createToken();
        vm.prank(alice);
        pad.buy(token, 200e6, 0, alice);
        uint256 tokensHeld = IERC20(token).balanceOf(alice);

        IArchitexLaunchpad.Curve memory c = pad.curves(token);
        uint256 kBefore = uint256(c.virtualUsdc) * uint256(c.virtualTokens);

        vm.prank(alice);
        pad.sell(token, tokensHeld / 2, 0, alice);

        c = pad.curves(token);
        uint256 kAfter = uint256(c.virtualUsdc) * uint256(c.virtualTokens);
        assertGe(kAfter, kBefore, "k decreased on sell");
    }

    function testFuzz_k_nonDecreasing(uint96 rawBuy, uint96 rawSell) public {
        uint256 buyAmt = bound(uint256(rawBuy), 1e4, 500e6);
        address token = _createToken();
        vm.prank(alice);
        pad.buy(token, buyAmt, 0, alice);

        IArchitexLaunchpad.Curve memory c = pad.curves(token);
        if (c.graduated) return;
        uint256 kBefore = uint256(c.virtualUsdc) * uint256(c.virtualTokens);

        uint256 bal = IERC20(token).balanceOf(alice);
        if (bal == 0) return;
        uint256 sellAmt = bound(uint256(rawSell), 1, bal);
        // dust that would pay out nothing is refused by design
        vm.prank(alice);
        try pad.sell(token, sellAmt, 0, alice) {} catch { return; }

        c = pad.curves(token);
        uint256 kAfter = uint256(c.virtualUsdc) * uint256(c.virtualTokens);
        assertGe(kAfter, kBefore, "k decreased on fuzzed sell");
    }

    function testFuzz_tokensSold_neverExceedsCurveSupply(uint96 rawBuy) public {
        uint256 buyAmt = bound(uint256(rawBuy), 1e4, 30_000e6);
        address token = _createToken();
        vm.prank(alice);
        pad.buy(token, buyAmt, 0, alice);

        IArchitexLaunchpad.Curve memory c = pad.curves(token);
        assertLe(c.tokensSold, CURVE_SUPPLY, "tokensSold > CURVE_SUPPLY");
        assertEq(uint256(c.virtualTokens) + uint256(c.tokensSold), VIRTUAL_TOKENS_0);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Section 10 — Fee accounting
    // ═══════════════════════════════════════════════════════════════════════════

    function test_fee_onBuy() public {
        address token = _createToken();
        uint256 feesBefore = pad.pendingFees();
        uint256 usdcIn = 1_000e6;
        uint256 expectedFee = _divCeil(usdcIn * FEE_BPS, 10_000);

        vm.prank(alice);
        pad.buy(token, usdcIn, 0, alice);

        assertEq(pad.pendingFees(), feesBefore + expectedFee);
    }

    function test_fee_onSell() public {
        address token = _createToken();
        vm.prank(alice);
        pad.buy(token, 500e6, 0, alice);
        uint256 tokens = IERC20(token).balanceOf(alice);
        uint256 feesBefore = pad.pendingFees();

        IArchitexLaunchpad.Curve memory c = pad.curves(token);
        uint256 k = uint256(c.virtualUsdc) * uint256(c.virtualTokens);
        uint256 gross = uint256(c.virtualUsdc) - _divCeil(k, uint256(c.virtualTokens) + tokens / 2);
        uint256 expectedFee = _divCeil(gross * FEE_BPS, 10_000);

        vm.prank(alice);
        pad.sell(token, tokens / 2, 0, alice);

        assertEq(pad.pendingFees(), feesBefore + expectedFee);
    }

    function test_fee_launchFee() public {
        uint256 feesBefore = pad.pendingFees();
        vm.prank(alice);
        pad.createToken("X", "X", "ipfs://x", 0, alice, "", 0, 0);
        assertEq(pad.pendingFees(), feesBefore + LAUNCH_FEE);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Section 11 — Admin setters and access control
    // ═══════════════════════════════════════════════════════════════════════════

    function test_setFeeTo_onlySetter() public {
        address newFeeTo = makeAddr("newFeeTo");
        vm.prank(alice);
        vm.expectRevert(IArchitexLaunchpad.Forbidden.selector);
        pad.setFeeTo(newFeeTo);

        vm.prank(setter);
        pad.setFeeTo(newFeeTo);
        assertEq(pad.feeTo(), newFeeTo);
    }

    function test_setFeeTo_zeroAddressReverts() public {
        vm.prank(setter);
        vm.expectRevert(IArchitexLaunchpad.ZeroAddress.selector);
        pad.setFeeTo(address(0));
    }

    function test_setFeeToSetter_onlySetter() public {
        address newSetter = makeAddr("newSetter");
        vm.prank(alice);
        vm.expectRevert(IArchitexLaunchpad.Forbidden.selector);
        pad.setFeeToSetter(newSetter);

        vm.prank(setter);
        pad.setFeeToSetter(newSetter);
        assertEq(pad.feeToSetter(), newSetter);
    }

    function test_setLaunchFee_limit() public {
        vm.prank(setter);
        vm.expectRevert(IArchitexLaunchpad.LaunchFeeTooHigh.selector);
        pad.setLaunchFee(100e6 + 1);

        vm.prank(setter);
        pad.setLaunchFee(100e6);
        assertEq(pad.launchFee(), 100e6);
    }

    function test_setLaunchFee_onlySetter() public {
        vm.prank(alice);
        vm.expectRevert(IArchitexLaunchpad.Forbidden.selector);
        pad.setLaunchFee(0);
    }

    function test_adminHasNoPowerOverCreatorFeesOrCurves() public {
        vm.prank(alice);
        address token = pad.createToken("Mine", "MINE", "", 500, alice, "", 100e6, 0);
        uint256 owed = pad.pendingCreatorFees(token);
        assertGt(owed, 0);
        vm.prank(setter);
        pad.setFeeTo(setter);
        // Collecting platform fees never touches creator fees or the curve float
        uint256 floatBefore = _float(token);
        pad.collectFees();
        assertEq(pad.pendingCreatorFees(token), owed);
        assertEq(_float(token), floatBefore);
        assertEq(pad.pluginOf(token), alice);
        assertEq(pad.creatorFeeBpsOf(token), 500);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Section 12 — Reentrancy guards (every value-moving entry point)
    // ═══════════════════════════════════════════════════════════════════════════

    function test_reentrancy_fromPluginHooksIsRefusedEverywhere() public {
        address graduated = _graduateToken();
        ReentrantPlugin plugin = new ReentrantPlugin(pad, router);
        plugin.setGraduatedToken(graduated);
        usdc.mint(address(plugin), 1_000e6);

        vm.prank(alice);
        address token = pad.createToken("Re", "RE", "", 100, address(plugin), "", 10e6, 0);
        // onLaunch attempted buy, sell, collectCreatorFees, collectFees, createToken and a router buy
        assertEq(plugin.errorsLength(), 6);
        for (uint256 i = 0; i < 6; i++) {
            assertEq(plugin.errors(i), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        }
        assertFalse(plugin.anyReentrySucceeded());

        // onFees: the same six attempts all refused, then an exact pull
        pad.collectCreatorFees(token);
        assertEq(plugin.errorsLength(), 12);
        for (uint256 i = 6; i < 12; i++) {
            assertEq(plugin.errors(i), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        }
        assertFalse(plugin.anyReentrySucceeded());
        assertEq(pad.pendingCreatorFees(token), 0);
        _assertSolvent();
    }

    function test_reentrancy_createAndBuy() public {
        // createToken holds the guard and runs the first buy through the internal _buy
        vm.prank(alice);
        address token = pad.createToken("Safe", "SAFE", "ipfs://s", 0, alice, "", 10e6, 0);
        assertGt(IERC20(token).balanceOf(alice), 0);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Section 13 — Views
    // ═══════════════════════════════════════════════════════════════════════════

    function test_spotPrice_initial() public {
        address token = _createToken();
        assertEq(pad.spotPrice(token), VIRTUAL_USDC_0 * 1e36 / VIRTUAL_TOKENS_0);
    }

    function test_marketCap_initial() public {
        address token = _createToken();
        assertEq(pad.marketCap(token), VIRTUAL_USDC_0 * CURVE_SUPPLY / VIRTUAL_TOKENS_0);
    }

    function test_progressBps_initial() public {
        address token = _createToken();
        assertEq(pad.progressBps(token), 0);
    }

    function test_progressBps_afterGraduation() public {
        address token = _graduateToken();
        assertEq(pad.curves(token).tokensSold, CURVE_SUPPLY);
        assertEq(pad.progressBps(token), 10_000);
    }

    function test_curvesPage_clamping() public {
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(alice);
            pad.createToken("T", "T", "ipfs://t", 0, alice, "", 0, 0);
        }
        assertEq(pad.curvesPage(10, 5).length, 0);
        assertEq(pad.curvesPage(2, 5).length, 1);
        assertEq(pad.curvesPage(0, 1_000).length, 3);
    }

    function test_quoteBuy_matchesBuy() public {
        vm.prank(alice);
        address token = pad.createToken("Q", "Q", "", 321, alice, "", 0, 0);
        uint256 usdcIn = 100e6;
        (uint256 qTokens, uint256 qPlatform, uint256 qCreator, uint256 qSpent, bool qGrad) = pad.quoteBuy(token, usdcIn);

        uint256 feesBefore = pad.pendingFees();
        vm.prank(alice);
        (uint256 tokensOut, uint256 usdcSpent) = pad.buy(token, usdcIn, 0, alice);
        assertEq(tokensOut, qTokens);
        assertEq(usdcSpent, qSpent);
        assertFalse(qGrad);
        assertEq(pad.pendingFees() - feesBefore, qPlatform);
        assertEq(pad.pendingCreatorFees(token), qCreator);
    }

    function test_quoteSell_matchesSell() public {
        vm.prank(alice);
        address token = pad.createToken("Q", "Q", "", 321, alice, "", 0, 0);
        vm.prank(alice);
        pad.buy(token, 100e6, 0, alice);
        uint256 bal = IERC20(token).balanceOf(alice);

        (uint256 qUsdc, uint256 qPlatform, uint256 qCreator) = pad.quoteSell(token, bal);
        uint256 feesBefore = pad.pendingFees();
        uint256 creatorBefore = pad.pendingCreatorFees(token);

        vm.prank(alice);
        uint256 usdcOut = pad.sell(token, bal, 0, alice);
        assertEq(usdcOut, qUsdc);
        assertEq(pad.pendingFees() - feesBefore, qPlatform);
        assertEq(pad.pendingCreatorFees(token) - creatorBefore, qCreator);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Invariant test suite (single curve; the multi-token suite is LaunchpadV13Invariant.t.sol)
// ═══════════════════════════════════════════════════════════════════════════════

contract LaunchpadInvariantTest is LaunchpadV13Base {
    LaunchpadHandler handler;
    address token;

    function setUp() public override {
        super.setUp();
        vm.prank(alice);
        token = pad.createToken("InvCoin", "INV", "ipfs://inv", 150, creatorWallet, "", 0, 0);

        handler = new LaunchpadHandler(pad, usdc, token, alice);

        bytes4[] memory selectors = new bytes4[](3);
        selectors[0] = LaunchpadHandler.buy.selector;
        selectors[1] = LaunchpadHandler.sell.selector;
        selectors[2] = LaunchpadHandler.collect.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// @notice USDC held by the launchpad == fees + creator fees + the live curve's float, to the unit
    function invariant_solvency() public view {
        _assertSolvent();
    }

    /// @notice tokensSold never exceeds CURVE_SUPPLY; virtualTokens + tokensSold is constant
    function invariant_tokensSoldBound() public view {
        IArchitexLaunchpad.Curve memory c = pad.curves(token);
        assertLe(uint256(c.tokensSold), CURVE_SUPPLY, "tokensSold > CURVE_SUPPLY");
        assertEq(uint256(c.virtualTokens) + uint256(c.tokensSold), VIRTUAL_TOKENS_0);
    }

    /// @notice k never falls below its starting value
    function invariant_kNonDecreasing() public view {
        IArchitexLaunchpad.Curve memory c = pad.curves(token);
        uint256 k = uint256(c.virtualUsdc) * uint256(c.virtualTokens);
        assertGe(k, VIRTUAL_USDC_0 * VIRTUAL_TOKENS_0, "k decreased below initial");
    }
}
