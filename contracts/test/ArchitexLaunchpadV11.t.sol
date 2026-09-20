// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "../ArchitexFactory.sol";
import "../ArchitexRouter.sol";
import "../interfaces/IArchitexPair.sol";
import "../interfaces/IArchitexLaunchpad.sol";
import "../launchpad/ArchitexLaunchpad.sol";
import "../launchpad/LaunchToken.sol";

/// @dev 6-decimal USDC with Arc's blocklist behaviour: transfers touching a blocked address revert.
contract BlockableUSDC is ERC20 {
    mapping(address => bool) public blocked;

    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address who, bool value) external {
        blocked[who] = value;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[from] && !blocked[to], "blocklisted");
        super._update(from, to, value);
    }
}

contract PlainToken is ERC20 {
    constructor() ERC20("Other", "OTHER") {
        _mint(msg.sender, 1_000_000e18);
    }
}

interface IUsdcHook {
    function onUsdcReceived() external;
}

/// @dev A USDC that calls its recipient back: the only way to reach a reentrant call, since neither
///      real USDC nor LaunchToken has a transfer hook. Proves the guard is there, not that it is needed.
contract HookedUSDC is ERC20 {
    address public hook;

    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setHook(address target) external {
        hook = target;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (to == hook && hook != address(0) && from != address(0)) IUsdcHook(hook).onUsdcReceived();
    }
}

contract ReentrantSeller is IUsdcHook {
    ArchitexLaunchpad public immutable pad;
    address public token;

    constructor(ArchitexLaunchpad _pad) {
        pad = _pad;
    }

    function prime(address _token, IERC20 usdc_, uint256 usdcIn) external {
        token = _token;
        usdc_.approve(address(pad), type(uint256).max);
        pad.buy(_token, usdcIn, 0, address(this));
    }

    function sellAll() external {
        pad.sell(token, IERC20(token).balanceOf(address(this)), 0, address(this));
    }

    function onUsdcReceived() external {
        pad.buy(token, 1e6, 0, address(this));
    }
}

/// @dev Random buys, sells and fee collections over two curves, never a donation.
contract AccountingHandler is Test {
    ArchitexLaunchpad public pad;
    BlockableUSDC public usdc;
    address[2] public tokens;
    address public trader = address(0xA11CE);

    constructor(ArchitexLaunchpad _pad, BlockableUSDC _usdc, address a, address b) {
        pad = _pad;
        usdc = _usdc;
        tokens = [a, b];
        usdc.mint(trader, 1_000_000_000e6);
        vm.prank(trader);
        usdc.approve(address(pad), type(uint256).max);
    }

    function buy(uint8 which, uint64 rawAmount) external {
        address token = tokens[which % 2];
        if (pad.curves(token).graduated) return;
        uint256 amount = bound(uint256(rawAmount), 1, 4_000e6);
        vm.prank(trader);
        try pad.buy(token, amount, 0, trader) {} catch {}
    }

    function sell(uint8 which, uint96 rawAmount) external {
        address token = tokens[which % 2];
        if (pad.curves(token).graduated) return;
        uint256 held = IERC20(token).balanceOf(trader);
        if (held == 0) return;
        vm.prank(trader);
        try pad.sell(token, bound(uint256(rawAmount), 1, held), 0, trader) {} catch {}
    }

    function collect() external {
        pad.collectFees();
    }
}

contract LaunchpadAccountingInvariant is Test {
    uint256 constant VIRTUAL_USDC_0 = 8_333_333_333;
    uint256 constant VIRTUAL_TOKENS_0 = 1_066_666_667e18;

    BlockableUSDC usdc;
    ArchitexLaunchpad pad;
    AccountingHandler handler;

    function setUp() public {
        usdc = new BlockableUSDC();
        ArchitexFactory amm = new ArchitexFactory(address(this));
        pad = new ArchitexLaunchpad(address(usdc), address(amm), makeAddr("feeTo"), makeAddr("setter"), 3e6);
        usdc.mint(address(this), 100e6);
        usdc.approve(address(pad), type(uint256).max);
        address a = pad.createToken("First", "ONE", "", 0, 0);
        address b = pad.createToken("Second", "TWO", "", 0, 0);
        handler = new AccountingHandler(pad, usdc, a, b);
        targetContract(address(handler));
    }

    /// @notice What the launchpad holds is exactly what it owes: accrued fees plus every live curve's float.
    function invariant_heldEqualsOwed() public view {
        uint256 owed = pad.pendingFees();
        for (uint256 i = 0; i < pad.tokensLength(); i++) {
            IArchitexLaunchpad.Curve memory c = pad.curves(pad.tokenAt(i));
            assertEq(uint256(c.virtualTokens) + uint256(c.tokensSold), VIRTUAL_TOKENS_0);
            if (!c.graduated) owed += uint256(c.virtualUsdc) - VIRTUAL_USDC_0;
        }
        assertEq(usdc.balanceOf(address(pad)), owed);
    }
}

/// @notice Spec v1.1: the reference vectors from src/lib/curve.ts asserted to the unit, the exact
///         accounting identity, and the red-team scenarios from docs/launchpad/GROK-REVIEW-1.md.
contract ArchitexLaunchpadV11Test is Test {
    uint256 constant CURVE_SUPPLY = 800_000_000e18;
    uint256 constant POOL_SUPPLY = 200_000_000e18;
    uint256 constant VIRTUAL_USDC_0 = 8_333_333_333;
    uint256 constant VIRTUAL_TOKENS_0 = 1_066_666_667e18;
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    BlockableUSDC usdc;
    ArchitexFactory amm;
    ArchitexRouter router;
    ArchitexLaunchpad pad;

    address feeTo = makeAddr("feeTo");
    address setter = makeAddr("setter");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address mallory = makeAddr("mallory");

    event Trade(
        address indexed token,
        address indexed trader,
        bool isBuy,
        uint256 usdcAmount,
        uint256 tokenAmount,
        uint256 fee,
        uint256 virtualUsdc,
        uint256 virtualTokens
    );

    function setUp() public {
        usdc = new BlockableUSDC();
        amm = new ArchitexFactory(address(this));
        router = new ArchitexRouter(address(amm));
        pad = new ArchitexLaunchpad(address(usdc), address(amm), feeTo, setter, 0);
        address[3] memory people = [alice, bob, mallory];
        for (uint256 i = 0; i < people.length; i++) {
            usdc.mint(people[i], 10_000_000e6);
            vm.prank(people[i]);
            usdc.approve(address(pad), type(uint256).max);
        }
    }

    function _create() internal returns (address token) {
        vm.prank(alice);
        token = pad.createToken("Vector", "VEC", "", 0, 0);
    }

    function _realUsdc(address token) internal view returns (uint256) {
        return uint256(pad.curves(token).virtualUsdc) - VIRTUAL_USDC_0;
    }

    // ── Reference vectors ────────────────────────────────────────────────────

    function test_vector_start() public {
        address token = _create();
        assertEq(pad.spotPrice(token), 7812499997246093750);
        assertEq(pad.marketCap(token), 6249999997);
        assertEq(pad.progressBps(token), 0);
    }

    function test_vector_V1_buy_then_V3_sell() public {
        address token = _create();
        (uint256 qTokens, uint256 qFee, uint256 qSpent, bool qGraduates) = pad.quoteBuy(token, 100_000_000);
        vm.prank(alice);
        (uint256 tokensOut, uint256 spent) = pad.buy(token, 100_000_000, 0, alice);
        assertEq(tokensOut, 12585726430898500955823408);
        assertEq(spent, 100_000_000);
        assertEq(pad.pendingFees(), 500_000);
        assertEq(qTokens, tokensOut);
        assertEq(qFee, 500_000);
        assertEq(qSpent, spent);
        assertFalse(qGraduates);
        IArchitexLaunchpad.Curve memory c = pad.curves(token);
        assertEq(c.virtualUsdc, 8432833333);
        assertEq(c.virtualTokens, 1054080940569101499044176592);

        (uint256 qOut, uint256 qSellFee) = pad.quoteSell(token, tokensOut);
        vm.prank(alice);
        uint256 usdcOut = pad.sell(token, tokensOut, 0, alice);
        assertEq(usdcOut, 99002499);
        assertEq(qOut, usdcOut);
        assertEq(qSellFee, 497500);
        assertEq(pad.pendingFees(), 500_000 + 497500);
        assertEq(pad.curves(token).tokensSold, 0);
        assertEq(pad.progressBps(token), 0);
    }

    function test_vector_V2_sellOut() public {
        address token = _create();
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        (uint256 tokensOut, uint256 spent) = pad.buy(token, 1_000_000_000_000, 0, alice);
        assertEq(tokensOut, CURVE_SUPPLY);
        assertEq(spent, 25125628109);
        assertEq(before - usdc.balanceOf(alice), 25125628109, "pulled exactly usdcSpent");
        assertEq(pad.pendingFees(), 125628141);
        IArchitexLaunchpad.Curve memory c = pad.curves(token);
        assertTrue(c.graduated);
        assertEq(c.virtualUsdc, 33333333301);
        assertEq(usdc.balanceOf(c.pair), 24999999968, "usdcSeeded");
        assertEq(IERC20(token).balanceOf(c.pair), POOL_SUPPLY);
        // The views keep answering after graduation with the curve's final numbers.
        assertEq(pad.marketCap(token), 99999999778);
        assertEq(pad.spotPrice(token), 124999999722500000346);
        assertEq(pad.progressBps(token), 10_000);
    }

    function test_vector_V4_smallestSellOutInput() public {
        address token = _create();
        (,,, bool graduatesOneLess) = pad.quoteBuy(token, 25125628108);
        assertFalse(graduatesOneLess);
        (uint256 tokensOut,, uint256 spent, bool graduates) = pad.quoteBuy(token, 25125628109);
        assertTrue(graduates);
        assertEq(tokensOut, CURVE_SUPPLY);
        assertEq(spent, 25125628109);
    }

    function test_vector_V5_dust() public {
        address token = _create();
        (uint256 tokensOut, uint256 fee,,) = pad.quoteBuy(token, 199);
        assertEq(fee, 1);
        assertEq(tokensOut, 25343999406760334071);
        vm.expectRevert(IArchitexLaunchpad.ZeroAmount.selector);
        pad.quoteBuy(token, 1);
    }

    // ── Exact accounting ─────────────────────────────────────────────────────

    /// @dev With one curve and no donations the launchpad holds exactly what it has credited.
    function testFuzz_accountingIsExact(uint64[12] calldata amounts, uint8 sellMask) public {
        address token = _create();
        for (uint256 i = 0; i < amounts.length; i++) {
            if (pad.curves(token).graduated) break;
            bool selling = (sellMask >> (i % 8)) & 1 == 1;
            uint256 held = IERC20(token).balanceOf(alice);
            if (selling && held > 0) {
                uint256 tokensIn = bound(uint256(amounts[i]), 1, held);
                vm.prank(alice);
                try pad.sell(token, tokensIn, 0, alice) {} catch {}
            } else {
                uint256 usdcIn = bound(uint256(amounts[i]), 1, 3_000e6);
                vm.prank(alice);
                try pad.buy(token, usdcIn, 0, alice) returns (uint256, uint256 spent) {
                    assertLe(spent, usdcIn, "never pulls more than offered");
                } catch {}
            }
            uint256 owed = pad.pendingFees() + (pad.curves(token).graduated ? 0 : _realUsdc(token));
            assertEq(usdc.balanceOf(address(pad)), owed, "USDC held == fees + curve float");
            IArchitexLaunchpad.Curve memory c = pad.curves(token);
            assertEq(uint256(c.virtualTokens) + uint256(c.tokensSold), VIRTUAL_TOKENS_0);
        }
    }

    /// @dev Walk to a nearly sold-out curve, then offer one unit less than the uncapped exact-fill
    ///      gross. If that still sells out, the cap bites: nothing beyond the offer may be pulled or credited.
    function testFuzz_cappedSellOutNeverOverCredits(uint64 rawFirst) public {
        address token = _create();
        uint256 first = bound(uint256(rawFirst), 1e6, 8_700e6);
        vm.prank(alice);
        pad.buy(token, first, 0, alice);
        (,, uint256 gross,) = pad.quoteBuy(token, 1_000_000_000_000);
        (, uint256 fee, uint256 spent, bool graduates) = pad.quoteBuy(token, gross - 1);
        if (!graduates) return;
        assertEq(spent, gross - 1);
        uint256 padBefore = usdc.balanceOf(address(pad));
        uint256 feesBefore = pad.pendingFees();
        uint256 floatBefore = _realUsdc(token);
        vm.prank(bob);
        (, uint256 pulled) = pad.buy(token, gross - 1, 0, bob);
        assertEq(pulled, gross - 1);
        IArchitexLaunchpad.Curve memory c = pad.curves(token);
        uint256 seeded = usdc.balanceOf(c.pair);
        // received == credited: what came in equals the fee accrued plus the float added, all of which was seeded
        assertEq(pad.pendingFees() - feesBefore, fee);
        assertEq(padBefore + pulled - seeded, usdc.balanceOf(address(pad)));
        assertEq(usdc.balanceOf(address(pad)), pad.pendingFees(), "only fees remain after graduation");
        assertEq(seeded, floatBefore + (pulled - fee));
    }

    // ── Two live curves ──────────────────────────────────────────────────────

    function test_graduatingOneCurveLeavesTheOtherSolvent() public {
        address a = _create();
        vm.prank(bob);
        address b = pad.createToken("Second", "TWO", "", 0, 0);
        vm.prank(bob);
        (uint256 bobTokens,) = pad.buy(b, 4_000e6, 0, bob);
        uint256 floatB = _realUsdc(b);

        vm.prank(alice);
        pad.buy(a, 1_000_000e6, 0, alice);
        assertTrue(pad.curves(a).graduated);
        assertEq(usdc.balanceOf(pad.curves(a).pair), 24999999968, "A's pool got only A's raise");
        assertEq(_realUsdc(b), floatB, "B's float untouched");
        assertEq(usdc.balanceOf(address(pad)), pad.pendingFees() + floatB);

        vm.prank(bob);
        uint256 out = pad.sell(b, bobTokens, 0, bob);
        assertGt(out, 0);
        vm.prank(bob);
        pad.buy(b, 1_000_000e6, 0, bob);
        assertTrue(pad.curves(b).graduated);
        assertEq(usdc.balanceOf(address(pad)), pad.pendingFees());
    }

    // ── Creation-time paths ──────────────────────────────────────────────────

    function test_createTokenThatBuysOutTheWholeCurve() public {
        vm.prank(alice);
        uint256 gasBefore = gasleft();
        address token = pad.createToken("AllIn", "ALL", "", 30_000e6, CURVE_SUPPLY);
        uint256 gasUsed = gasBefore - gasleft();
        emit log_named_uint("gas: createToken + createPair + sell-out + graduation", gasUsed);
        assertLt(gasUsed, 30_000_000);
        IArchitexLaunchpad.Curve memory c = pad.curves(token);
        assertTrue(c.graduated);
        assertEq(IERC20(token).balanceOf(alice), CURVE_SUPPLY);
        assertGt(IArchitexPair(c.pair).balanceOf(DEAD), 1000);
        assertEq(IArchitexPair(c.pair).balanceOf(address(pad)), 0);
    }

    function test_preCreatedPairDoesNotBlockLaunchOrGraduation() public {
        address predicted = vm.computeCreateAddress(address(pad), vm.getNonce(address(pad)));
        vm.prank(mallory);
        address squatted = amm.createPair(predicted, address(usdc));
        address token = _create();
        assertEq(token, predicted);
        assertEq(pad.curves(token).pair, squatted);
        vm.prank(alice);
        pad.buy(token, 1_000_000e6, 0, alice);
        assertTrue(pad.curves(token).graduated);
    }

    // ── Donations cannot brick graduation ────────────────────────────────────

    function test_donationWithSyncOnlyGiftsValue() public {
        address token = _create();
        address pair = pad.curves(token).pair;
        vm.startPrank(mallory);
        usdc.transfer(pair, 1_000e6);
        IArchitexPair(pair).sync();
        vm.stopPrank();
        vm.prank(alice);
        pad.buy(token, 1_000_000e6, 0, alice);
        assertTrue(pad.curves(token).graduated);
        assertEq(usdc.balanceOf(pair), 24999999968 + 1_000e6);
        assertGt(IArchitexPair(pair).balanceOf(DEAD), 1000);
    }

    function test_donationWithoutSyncOnlyGiftsValue() public {
        address token = _create();
        address pair = pad.curves(token).pair;
        vm.prank(mallory);
        usdc.transfer(pair, 5e6);
        vm.prank(alice);
        pad.buy(token, 1_000_000e6, 0, alice);
        assertTrue(pad.curves(token).graduated);
    }

    function test_protocolFeeSwitchedOnDoesNotAffectGraduation() public {
        amm.setFeeTo(makeAddr("ammFeeTo"));
        address token = _create();
        vm.prank(alice);
        pad.buy(token, 1_000_000e6, 0, alice);
        IArchitexLaunchpad.Curve memory c = pad.curves(token);
        assertTrue(c.graduated);
        assertEq(IArchitexPair(c.pair).balanceOf(makeAddr("ammFeeTo")), 0);
    }

    // ── A blocked or broken fee address never stops trading ──────────────────

    function test_blocklistedFeeToCannotFreezeAnything() public {
        vm.prank(setter);
        pad.setLaunchFee(5e6);
        usdc.setBlocked(feeTo, true);

        vm.prank(alice);
        address token = pad.createToken("Frozen", "ICE", "", 50e6, 0);
        vm.prank(alice);
        (uint256 tokens,) = pad.buy(token, 200e6, 0, alice);
        vm.prank(alice);
        pad.sell(token, tokens / 2, 0, alice);
        vm.prank(bob);
        pad.buy(token, 1_000_000e6, 0, bob);
        assertTrue(pad.curves(token).graduated);

        uint256 owed = pad.pendingFees();
        assertGt(owed, 5e6);
        vm.expectRevert();
        pad.collectFees();
        assertEq(pad.pendingFees(), owed, "fees stay claimable");

        address newFeeTo = makeAddr("newFeeTo");
        vm.prank(setter);
        pad.setFeeTo(newFeeTo);
        vm.prank(mallory); // permissionless
        assertEq(pad.collectFees(), owed);
        assertEq(usdc.balanceOf(newFeeTo), owed);
        assertEq(pad.pendingFees(), 0);
        assertEq(pad.collectFees(), 0);
    }

    // ── The pair stays closed until graduation ───────────────────────────────

    function test_pairLockThroughEveryDoor() public {
        address token = _create();
        address pair = pad.curves(token).pair;
        vm.prank(alice);
        (uint256 tokens,) = pad.buy(token, 500e6, 0, alice);

        vm.startPrank(alice);
        vm.expectRevert(ILaunchToken.PairLockedUntilGraduation.selector);
        IERC20(token).transfer(pair, 1e18);

        vm.expectRevert(ILaunchToken.PairLockedUntilGraduation.selector);
        pad.buy(token, 10e6, 0, pair);

        IERC20(token).approve(address(router), type(uint256).max);
        address[] memory path = new address[](2);
        path[0] = token;
        path[1] = address(usdc);
        vm.expectRevert();
        router.swapExactTokensForTokens(1e18, 0, path, alice, block.timestamp + 1);
        vm.stopPrank();

        // Any other market is allowed before graduation.
        PlainToken other = new PlainToken();
        other.transfer(alice, 1_000e18);
        vm.startPrank(alice);
        other.approve(address(router), type(uint256).max);
        router.addLiquidity(token, address(other), tokens / 10, 100e18, 0, 0, alice, block.timestamp + 1);
        vm.stopPrank();

        vm.prank(bob);
        pad.buy(token, 1_000_000e6, 0, bob);
        assertTrue(pad.curves(token).graduated);

        vm.prank(alice);
        uint256[] memory amounts = router.swapExactTokensForTokens(1_000e18, 0, path, alice, block.timestamp + 1);
        assertGt(amounts[1], 0, "the USDC route opens at graduation");
    }

    // ── Privileges ───────────────────────────────────────────────────────────

    function test_launchpadPullOnlyServesSells() public {
        address token = _create();
        vm.prank(alice);
        (uint256 tokens,) = pad.buy(token, 300e6, 0, alice);

        vm.prank(mallory);
        vm.expectRevert(ILaunchToken.OnlyLaunchpad.selector);
        ILaunchToken(token).launchpadPull(alice, tokens);

        // Mallory holds nothing: a sell can only ever move the caller's own tokens.
        vm.prank(mallory);
        vm.expectRevert();
        pad.sell(token, tokens, 0, mallory);
        assertEq(IERC20(token).balanceOf(alice), tokens);

        uint256 padBefore = IERC20(token).balanceOf(address(pad));
        vm.prank(alice);
        pad.sell(token, tokens, 0, bob);
        assertEq(IERC20(token).balanceOf(address(pad)), padBefore + tokens, "sold tokens return to the launchpad");
        assertEq(IERC20(token).balanceOf(token), 0);
    }

    function test_traderInTheEventIsTheCaller() public {
        address token = _create();
        (uint256 tokensOut, uint256 fee,,) = pad.quoteBuy(token, 100e6);
        vm.expectEmit(true, true, false, true, address(pad));
        emit Trade(token, alice, true, 100e6, tokensOut, fee, VIRTUAL_USDC_0 + 100e6 - fee, VIRTUAL_TOKENS_0 - tokensOut);
        vm.prank(alice);
        pad.buy(token, 100e6, 0, bob);
        assertEq(IERC20(token).balanceOf(bob), tokensOut);
    }

    function test_adminSurface() public {
        vm.startPrank(setter);
        vm.expectRevert(IArchitexLaunchpad.ZeroAddress.selector);
        pad.setFeeTo(address(0));
        vm.expectRevert(IArchitexLaunchpad.ZeroAddress.selector);
        pad.setFeeTo(address(pad));
        vm.expectRevert(IArchitexLaunchpad.LaunchFeeTooHigh.selector);
        pad.setLaunchFee(100e6 + 1);
        pad.setFeeToSetter(address(0)); // irreversible renounce
        vm.expectRevert(IArchitexLaunchpad.Forbidden.selector);
        pad.setLaunchFee(1e6);
        vm.stopPrank();
    }

    function test_unknownTokenReverts() public {
        vm.expectRevert(IArchitexLaunchpad.UnknownToken.selector);
        pad.curves(address(0xBEEF));
        vm.expectRevert(IArchitexLaunchpad.UnknownToken.selector);
        pad.spotPrice(address(0xBEEF));
    }

    function test_curvesPageClampsAndPages() public {
        _create();
        _create();
        _create();
        assertEq(pad.curvesPage(0, 1_000).length, 3);
        assertEq(pad.curvesPage(1, 1).length, 1);
        assertEq(pad.curvesPage(3, 10).length, 0);
    }

    // ── Review #2: vectors executed, not only quoted ─────────────────────────

    function test_vector_V4_executedOnBothSidesOfTheBoundary() public {
        address below = _create();
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        (uint256 tokensBelow, uint256 spentBelow) = pad.buy(below, 25125628108, 0, alice);
        assertEq(spentBelow, 25125628108);
        assertEq(before - usdc.balanceOf(alice), 25125628108);
        assertLt(tokensBelow, CURVE_SUPPLY);
        assertFalse(pad.curves(below).graduated);

        address at = _create();
        before = usdc.balanceOf(bob);
        vm.prank(bob);
        (uint256 tokensAt, uint256 spentAt) = pad.buy(at, 25125628109, 0, bob);
        assertEq(spentAt, 25125628109);
        assertEq(before - usdc.balanceOf(bob), 25125628109);
        assertEq(tokensAt, CURVE_SUPPLY);
        assertTrue(pad.curves(at).graduated);
    }

    function test_vector_V5_executed() public {
        address token = _create();
        vm.prank(alice);
        (uint256 tokensOut, uint256 spent) = pad.buy(token, 199, 0, alice);
        assertEq(tokensOut, 25343999406760334071);
        assertEq(spent, 199);
        assertEq(pad.pendingFees(), 1);
        vm.prank(alice);
        vm.expectRevert(IArchitexLaunchpad.ZeroAmount.selector);
        pad.buy(token, 1, 0, alice);
    }

    function test_quoteSellRevertsExactlyWhereSellWould() public {
        address token = _create();
        vm.prank(alice);
        (uint256 tokens,) = pad.buy(token, 100e6, 0, alice);

        vm.expectRevert(IArchitexLaunchpad.ZeroAmount.selector);
        pad.quoteSell(token, 0);
        vm.expectRevert(IArchitexLaunchpad.ZeroAmount.selector);
        pad.quoteSell(token, 1);
        vm.expectRevert(IArchitexLaunchpad.ExceedsSold.selector);
        pad.quoteSell(token, tokens + 1);

        vm.startPrank(alice);
        vm.expectRevert(IArchitexLaunchpad.ZeroAmount.selector);
        pad.sell(token, 0, 0, alice);
        vm.expectRevert(IArchitexLaunchpad.ZeroAmount.selector);
        pad.sell(token, 1, 0, alice);
        vm.expectRevert(IArchitexLaunchpad.ExceedsSold.selector);
        pad.sell(token, tokens + 1, 0, alice);
        vm.stopPrank();

        (uint256 quoted,) = pad.quoteSell(token, tokens);
        vm.prank(alice);
        assertEq(pad.sell(token, tokens, 0, alice), quoted);
    }

    function test_absurdInputRevertsOnlyThatCall() public {
        address token = _create();
        IArchitexLaunchpad.Curve memory beforeCall = pad.curves(token);
        vm.prank(alice);
        vm.expectRevert();
        pad.buy(token, type(uint256).max, 0, alice);
        IArchitexLaunchpad.Curve memory afterCall = pad.curves(token);
        assertEq(afterCall.virtualUsdc, beforeCall.virtualUsdc);
        assertEq(afterCall.tokensSold, 0);
        vm.prank(alice);
        pad.buy(token, 10e6, 0, alice);
    }

    function test_reentrantCallIsRefused() public {
        HookedUSDC hooked = new HookedUSDC();
        ArchitexFactory amm2 = new ArchitexFactory(address(this));
        ArchitexLaunchpad pad2 = new ArchitexLaunchpad(address(hooked), address(amm2), feeTo, setter, 0);
        address token = pad2.createToken("Hook", "HOOK", "", 0, 0);
        ReentrantSeller attacker = new ReentrantSeller(pad2);
        hooked.mint(address(attacker), 1_000e6);
        attacker.prime(token, IERC20(address(hooked)), 100e6);
        hooked.setHook(address(attacker));
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        attacker.sellAll();
    }

    function test_launchFeeAndTradeFeesAreAllCollectable() public {
        vm.prank(setter);
        pad.setLaunchFee(5e6);
        vm.prank(alice);
        address token = pad.createToken("Paid", "PAID", "", 30_000e6, CURVE_SUPPLY);
        assertTrue(pad.curves(token).graduated);
        assertEq(pad.pendingFees(), 5e6 + 125628141);
        assertEq(usdc.balanceOf(address(pad)), pad.pendingFees(), "after graduation only fees remain");
        assertEq(pad.collectFees(), 5e6 + 125628141);
        assertEq(usdc.balanceOf(feeTo), 5e6 + 125628141);
        assertEq(usdc.balanceOf(address(pad)), 0);
    }

    function test_allLiquidityIsLockedAndGasIsBounded() public {
        vm.prank(alice);
        uint256 gasBefore = gasleft();
        address token = pad.createToken("Gas", "GAS", "", 30_000e6, CURVE_SUPPLY);
        uint256 gasUsed = gasBefore - gasleft();
        assertLt(gasUsed, 3_500_000, "create + pair + sell-out + graduation");
        IArchitexPair pair = IArchitexPair(pad.curves(token).pair);
        assertEq(pair.balanceOf(DEAD), pair.totalSupply(), "every LP unit sits at the dead address");
    }

    function test_skimmedDonationLeavesTheOpeningPriceExact() public {
        address token = _create();
        IArchitexPair pair = IArchitexPair(pad.curves(token).pair);
        vm.prank(mallory);
        usdc.transfer(address(pair), 500e6);
        pair.skim(mallory);
        assertEq(usdc.balanceOf(address(pair)), 0);
        vm.prank(alice);
        pad.buy(token, 1_000_000e6, 0, alice);
        uint256 poolPrice = usdc.balanceOf(address(pair)) * 1e36 / IERC20(token).balanceOf(address(pair));
        uint256 curvePrice = pad.spotPrice(token);
        uint256 gap = poolPrice > curvePrice ? poolPrice - curvePrice : curvePrice - poolPrice;
        assertLt(gap * 1_000_000, curvePrice, "pool opens at the curve's final price within 1e-6");
    }

    function test_nobodyCanMintThePairBeforeGraduation() public {
        address token = _create();
        IArchitexPair pair = IArchitexPair(pad.curves(token).pair);
        vm.startPrank(mallory);
        usdc.transfer(address(pair), 100e6);
        vm.expectRevert();
        pair.mint(mallory);
        vm.stopPrank();
        assertEq(pair.totalSupply(), 0);
    }

    function test_flashSwapIntoTheUsdcPairIsLocked() public {
        address token = _create();
        address usdcPair = pad.curves(token).pair;
        vm.prank(alice);
        (uint256 tokens,) = pad.buy(token, 500e6, 0, alice);
        PlainToken other = new PlainToken();
        other.transfer(alice, 1_000e18);
        vm.startPrank(alice);
        IERC20(token).approve(address(router), type(uint256).max);
        other.approve(address(router), type(uint256).max);
        router.addLiquidity(token, address(other), tokens / 2, 500e18, 0, 0, alice, block.timestamp + 1);
        vm.stopPrank();

        IArchitexPair otherPair = IArchitexPair(amm.getPair(token, address(other)));
        bool tokenIsZero = otherPair.token0() == token;
        other.transfer(address(otherPair), 50e18);
        uint256 out = tokens / 100;
        vm.expectRevert(ILaunchToken.PairLockedUntilGraduation.selector);
        otherPair.swap(tokenIsZero ? out : 0, tokenIsZero ? 0 : out, usdcPair, "");
    }
}
