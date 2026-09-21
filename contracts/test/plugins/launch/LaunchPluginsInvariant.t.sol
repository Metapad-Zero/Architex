// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IArchitexFeePlugin} from "../../../interfaces/IArchitexFeePlugin.sol";
import {TestToken} from "../../../TestToken.sol";
import {SplitPlugin} from "../../../plugins/launch/SplitPlugin.sol";
import {BuybackBurnPlugin} from "../../../plugins/launch/BuybackBurnPlugin.sol";
import {HolderDistributionPlugin} from "../../../plugins/launch/HolderDistributionPlugin.sol";
import {ComboPlugin} from "../../../plugins/launch/ComboPlugin.sol";
import {MockLaunchpad, MockLaunchRouter, MockLaunchToken, MockLaunchPair} from "./LaunchPluginMocks.sol";

// One invariant suite per plugin. Each checks, after every random call sequence, that the plugin's USDC balance is
// exactly the sum of what it holds per token (nothing leaks between tokens, nothing is credited without being
// received), plus that plugin's own properties. Handlers record violations of per-call properties in ghost
// counters that the invariants assert are zero, so a violation is never lost as an ignored handler revert.

/// @notice Shared plumbing: the handler owns USDC (so it can mint) and delivers fees the two ways V13-SPEC allows.
abstract contract PluginHandlerBase is Test {
    TestToken internal immutable USDC;
    MockLaunchpad internal immutable LAUNCHPAD;
    address[] internal _tokens;
    address[] internal _payers;
    mapping(address token => uint256) public ghostCredited;

    constructor(TestToken usdc_, MockLaunchpad launchpad_, address[] memory tokens_) {
        USDC = usdc_;
        LAUNCHPAD = launchpad_;
        _tokens = tokens_;
        _payers.push(makeAddr("payer 1"));
        _payers.push(makeAddr("payer 2"));
    }

    function _token(uint256 seed) internal view returns (address) {
        return _tokens[seed % _tokens.length];
    }

    /// @dev The launchpad's collection (exact-pull and zero-allowance checked by the mock launchpad).
    function _deliverViaLaunchpad(address token, uint256 amount) internal {
        USDC.mint(address(LAUNCHPAD), amount);
        LAUNCHPAD.collect(token, amount);
        ghostCredited[token] += amount;
    }

    /// @dev Anyone paying a plugin's onFees directly with their own USDC.
    function _deliverDirect(address plugin, address token, uint256 payerSeed, uint256 amount) internal {
        address payer = _payers[payerSeed % _payers.length];
        USDC.mint(payer, amount);
        vm.startPrank(payer);
        USDC.approve(plugin, amount);
        IArchitexFeePlugin(plugin).onFees(token, amount);
        vm.stopPrank();
        ghostCredited[token] += amount;
    }
}

// ═══ Split ════════════════════════════════════════════════════════════════════

contract SplitHandler is PluginHandlerBase {
    SplitPlugin internal immutable SPLIT;
    mapping(address token => uint256) public ghostPaid;
    mapping(address token => mapping(address payee => uint256)) public ghostPaidTo;
    uint256 public badReleases;
    uint256 public releases; // coverage

    constructor(SplitPlugin split_, TestToken usdc_, MockLaunchpad launchpad_, address[] memory tokens_)
        PluginHandlerBase(usdc_, launchpad_, tokens_)
    {
        SPLIT = split_;
    }

    function deliverViaLaunchpad(uint256 tokenSeed, uint256 amount) external {
        _deliverViaLaunchpad(_token(tokenSeed), bound(amount, 0, 1e12));
    }

    function deliverDirect(uint256 tokenSeed, uint256 payerSeed, uint256 amount) external {
        _deliverDirect(address(SPLIT), _token(tokenSeed), payerSeed, bound(amount, 0, 1e12));
    }

    function release(uint256 tokenSeed, uint256 payeeSeed) external {
        address token = _token(tokenSeed);
        (address[] memory payees,) = SPLIT.payeesOf(token);
        address payee = payees[payeeSeed % payees.length];
        uint256 owed = SPLIT.releasable(token, payee);
        if (owed == 0) return;
        uint256 balanceBefore = USDC.balanceOf(payee);
        vm.prank(_payers[payeeSeed % _payers.length]); // anyone may release; the payee is paid
        uint256 paid = SPLIT.release(token, payee);
        if (paid != owed || USDC.balanceOf(payee) - balanceBefore != paid) badReleases += 1;
        releases += 1;
        ghostPaid[token] += paid;
        ghostPaidTo[token][payee] += paid;
    }
}

contract SplitPluginInvariantTest is Test {
    TestToken internal usdc;
    MockLaunchpad internal launchpad;
    SplitPlugin internal split;
    SplitHandler internal handler;
    address[] internal tokens;
    address[] internal allPayees;

    function setUp() public {
        usdc = new TestToken("USD Coin", "USDC", 6, 0, address(this));
        launchpad = new MockLaunchpad(address(usdc));
        split = new SplitPlugin(address(launchpad));

        address alice = makeAddr("alice");
        address bob = makeAddr("bob");
        address carol = makeAddr("carol");
        address dave = makeAddr("dave");
        allPayees = [alice, bob, carol, dave];

        // Overlapping payees with different shares, so a leak between tokens would show.
        _launch(_pair(alice, bob), _pairShares(50, 50));
        _launch(_three(alice, carol, dave), _threeShares(1, 1, 1));
        _launch(_pair(bob, dave), _pairShares(2 ** 200, 3)); // huge and tiny shares together

        handler = new SplitHandler(split, usdc, launchpad, tokens);
        usdc.transferOwnership(address(handler));

        bytes4[] memory selectors = new bytes4[](3);
        selectors[0] = SplitHandler.deliverViaLaunchpad.selector;
        selectors[1] = SplitHandler.deliverDirect.selector;
        selectors[2] = SplitHandler.release.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function _launch(address[] memory payees, uint256[] memory shares) internal {
        MockLaunchToken token = new MockLaunchToken(address(usdc), address(launchpad));
        launchpad.launch(address(token), address(this), address(split), address(0), abi.encode(payees, shares));
        tokens.push(address(token));
    }

    /// @dev The plugin holds exactly what its tokens have received and not yet paid out.
    function invariant_usdcHeldEqualsSumOfUnreleased() public view {
        uint256 sum;
        for (uint256 i; i < tokens.length; ++i) {
            sum += split.usdcHeld(tokens[i]);
        }
        assertEq(usdc.balanceOf(address(split)), sum);
    }

    /// @dev Per token: credits match deliveries, releases never exceed receipts, and each payee's paid + releasable
    ///      is exactly floor(received * share / totalShares).
    function invariant_perTokenSplitAccounting() public view {
        for (uint256 i; i < tokens.length; ++i) {
            address token = tokens[i];
            uint256 received = split.totalReceived(token);
            assertEq(received, handler.ghostCredited(token));
            assertEq(split.totalReleased(token), handler.ghostPaid(token));
            assertLe(split.totalReleased(token), received);

            (address[] memory payees, uint256[] memory shares) = split.payeesOf(token);
            uint256 total = split.totalShares(token);
            uint256 sumReleased;
            uint256 sumOwed;
            for (uint256 j; j < payees.length; ++j) {
                uint256 owed = Math.mulDiv(received, shares[j], total);
                uint256 paid = split.released(token, payees[j]);
                assertEq(paid + split.releasable(token, payees[j]), owed);
                assertEq(paid, handler.ghostPaidTo(token, payees[j]));
                sumReleased += paid;
                sumOwed += owed;
            }
            assertEq(sumReleased, split.totalReleased(token));
            // Rounding dust: received minus everything owed is under one unit per payee.
            assertLe(sumOwed, received);
            assertLt(received - sumOwed, payees.length);
        }
    }

    /// @dev Payees received exactly what was released to them, across all tokens.
    function invariant_payeesHoldExactlyWhatTheyWerePaid() public view {
        for (uint256 p; p < allPayees.length; ++p) {
            uint256 paid;
            for (uint256 i; i < tokens.length; ++i) {
                paid += handler.ghostPaidTo(tokens[i], allPayees[p]);
            }
            assertEq(usdc.balanceOf(allPayees[p]), paid);
        }
        assertEq(handler.badReleases(), 0);
    }

    function _pair(address a, address b) internal pure returns (address[] memory r) {
        r = new address[](2);
        (r[0], r[1]) = (a, b);
    }

    function _three(address a, address b, address c) internal pure returns (address[] memory r) {
        r = new address[](3);
        (r[0], r[1], r[2]) = (a, b, c);
    }

    function _pairShares(uint256 a, uint256 b) internal pure returns (uint256[] memory r) {
        r = new uint256[](2);
        (r[0], r[1]) = (a, b);
    }

    function _threeShares(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory r) {
        r = new uint256[](3);
        (r[0], r[1], r[2]) = (a, b, c);
    }
}

// ═══ Buyback & burn ═══════════════════════════════════════════════════════════

contract BuybackHandler is PluginHandlerBase {
    BuybackBurnPlugin internal immutable BUYBACK;
    mapping(address token => uint256) public ghostSpent;
    mapping(address token => uint256) public ghostRuns;
    uint256 public capViolations;
    uint256 public secondRunsInABlock;
    uint256 public runs;
    uint256 public poolRuns; // coverage
    uint256 public sellOutRuns; // coverage: curve runs that spent less than offered

    constructor(BuybackBurnPlugin buyback_, TestToken usdc_, MockLaunchpad launchpad_, address[] memory tokens_)
        PluginHandlerBase(usdc_, launchpad_, tokens_)
    {
        BUYBACK = buyback_;
    }

    function deliverViaLaunchpad(uint256 tokenSeed, uint256 amount) external {
        _deliverViaLaunchpad(_token(tokenSeed), bound(amount, 0, 1e11));
    }

    function deliverDirect(uint256 tokenSeed, uint256 payerSeed, uint256 amount) external {
        _deliverDirect(address(BUYBACK), _token(tokenSeed), payerSeed, bound(amount, 0, 1e11));
    }

    /// @dev Runs if a run is possible, checking the spend against 0.25% of the reserve read just before, then tries
    ///      a second run in the same block, which must fail.
    function run(uint256 tokenSeed, bool tryAgain) external {
        address token = _token(tokenSeed);
        (uint256 offered, bool graduated) = BUYBACK.previewRun(token);
        if (offered == 0) return;
        uint256 cap = (_reserve(token, graduated) * 25) / 10_000;
        uint256 heldBefore = BUYBACK.usdcHeld(token);

        (uint256 spent,) = BUYBACK.run(token);
        runs += 1;
        if (graduated) poolRuns += 1;
        else if (spent < offered) sellOutRuns += 1;
        ghostRuns[token] += 1;
        ghostSpent[token] += spent;
        if (spent > cap || spent > heldBefore || spent > offered || spent == 0) capViolations += 1;

        if (tryAgain) {
            try BUYBACK.run(token) {
                secondRunsInABlock += 1;
            } catch {}
        }
    }

    /// @dev Moves time too: runs are paced by time (RUN_INTERVAL), so blocks alone would leave almost no budget.
    function nextBlock(uint256 blocks) external {
        uint256 n = bound(blocks, 1, 3);
        vm.roll(vm.getBlockNumber() + n);
        vm.warp(vm.getBlockTimestamp() + n * 20 minutes);
    }

    /// @dev Graduates a token (as a sell-out buy by someone else would), opening its pool with `reserveUsdc`.
    ///      Rare on purpose (1 call in 16), so most tokens spend a while on the curve and usually graduate through
    ///      a buyback's own sell-out buy (see nearSellOut).
    function graduate(uint256 tokenSeed, uint256 reserveUsdc) external {
        address token = _token(tokenSeed);
        if (LAUNCHPAD.isGraduated(token) || uint256(keccak256(abi.encode(tokenSeed, reserveUsdc))) % 16 != 0) return;
        LAUNCHPAD.setGraduated(token, true);
        MockLaunchPair(LAUNCHPAD.pairOf(token)).setReserves(200_000_000e18, uint112(bound(reserveUsdc, 1e9, 1e12)));
    }

    /// @dev Other traders move the reserve the cap is computed from. After a sell-out this also opens the pool.
    function moveReserve(uint256 tokenSeed, uint256 value) external {
        address token = _token(tokenSeed);
        if (LAUNCHPAD.isGraduated(token)) {
            MockLaunchPair(LAUNCHPAD.pairOf(token)).setReserves(200_000_000e18, uint112(bound(value, 1e6, 1e12)));
        } else {
            LAUNCHPAD.setVirtualUsdc(token, bound(value, 8_333_333_333, 33_333_333_333));
        }
    }

    /// @dev Brings the curve's sell-out close, so a run can be the sell-out buy and spend less than it offers.
    ///      Rare on purpose (1 call in 8), so tokens also see plenty of ordinary curve runs first.
    function nearSellOut(uint256 tokenSeed, uint256 cost) external {
        address token = _token(tokenSeed);
        if (LAUNCHPAD.isGraduated(token) || uint256(keccak256(abi.encode(tokenSeed, cost))) % 8 != 0) return;
        LAUNCHPAD.setSellOutCost(token, bound(cost, 1, 50e6));
    }

    function _reserve(address token, bool graduated) internal view returns (uint256) {
        if (!graduated) return LAUNCHPAD.virtualUsdcOf(token);
        (, uint112 reserveUsdc,) = MockLaunchPair(LAUNCHPAD.pairOf(token)).getReserves();
        return reserveUsdc;
    }
}

contract BuybackBurnPluginInvariantTest is Test {
    TestToken internal usdc;
    MockLaunchpad internal launchpad;
    MockLaunchRouter internal router;
    BuybackBurnPlugin internal buyback;
    BuybackHandler internal handler;
    address[] internal tokens;

    function setUp() public {
        usdc = new TestToken("USD Coin", "USDC", 6, 0, address(this));
        launchpad = new MockLaunchpad(address(usdc));
        router = new MockLaunchRouter(launchpad);
        launchpad.setRouter(address(router));
        buyback = new BuybackBurnPlugin(address(launchpad));

        for (uint256 i; i < 3; ++i) {
            MockLaunchToken token = new MockLaunchToken(address(usdc), address(launchpad));
            MockLaunchPair pair = new MockLaunchPair();
            token.setPair(address(pair));
            launchpad.launch(address(token), address(this), address(buyback), address(pair), "");
            tokens.push(address(token));
        }

        handler = new BuybackHandler(buyback, usdc, launchpad, tokens);
        usdc.transferOwnership(address(handler));

        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = BuybackHandler.deliverViaLaunchpad.selector;
        selectors[1] = BuybackHandler.deliverDirect.selector;
        selectors[2] = BuybackHandler.run.selector;
        selectors[3] = BuybackHandler.nextBlock.selector;
        selectors[4] = BuybackHandler.graduate.selector;
        selectors[5] = BuybackHandler.moveReserve.selector;
        selectors[6] = BuybackHandler.nearSellOut.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// @dev The plugin holds exactly the sum of what waits per token.
    function invariant_usdcHeldEqualsSumOfWaiting() public view {
        uint256 sum;
        for (uint256 i; i < tokens.length; ++i) {
            sum += buyback.usdcHeld(tokens[i]);
        }
        assertEq(usdc.balanceOf(address(buyback)), sum);
    }

    /// @dev Per token: waiting + spent == credited, spend matches the handler's record, every bought token was
    ///      burned (the plugin keeps none), and one burn per run.
    function invariant_perTokenBuybackAccounting() public view {
        for (uint256 i; i < tokens.length; ++i) {
            address token = tokens[i];
            assertEq(buyback.usdcHeld(token) + buyback.totalUsdcSpent(token), handler.ghostCredited(token));
            assertEq(buyback.totalUsdcSpent(token), handler.ghostSpent(token));
            assertEq(MockLaunchToken(token).balanceOf(address(buyback)), 0);
            assertEq(buyback.totalTokensBurned(token), MockLaunchToken(token).totalBurned());
            assertEq(MockLaunchToken(token).burnCalls(), handler.ghostRuns(token));
        }
    }

    /// @dev Every run spent at most 0.25% of the USDC-side reserve, and no token ran twice in one block.
    function invariant_capAndOncePerBlock() public view {
        assertEq(handler.capViolations(), 0, "a run exceeded its cap");
        assertEq(handler.secondRunsInABlock(), 0, "a token ran twice in one block");
    }

    function invariant_noAllowanceLeftBehind() public view {
        assertEq(usdc.allowance(address(buyback), address(launchpad)), 0);
        assertEq(usdc.allowance(address(buyback), address(router)), 0);
    }
}

// ═══ Distribute to holders ════════════════════════════════════════════════════

/// @notice The holders plugin forwards every delivery to the token's distribute in the same call. The handler counts
///         deliveries that revert (none may: nothing holder-side can block a collection) and toggles eligibility.
contract HolderHandler is PluginHandlerBase {
    HolderDistributionPlugin internal immutable HOLDER;
    /// @notice Deliveries that reverted.
    uint256 public deliveryReverts;
    uint256 public deliveriesWithoutHolders; // coverage

    constructor(HolderDistributionPlugin holder_, TestToken usdc_, MockLaunchpad launchpad_, address[] memory tokens_)
        PluginHandlerBase(usdc_, launchpad_, tokens_)
    {
        HOLDER = holder_;
    }

    function deliverViaLaunchpad(uint256 tokenSeed, uint256 amount) external {
        address token = _token(tokenSeed);
        amount = bound(amount, 0, 1e12);
        _noteCoverage(token);
        USDC.mint(address(LAUNCHPAD), amount);
        try LAUNCHPAD.collect(token, amount) {
            ghostCredited[token] += amount;
        } catch {
            deliveryReverts += 1;
        }
    }

    function deliverDirect(uint256 tokenSeed, uint256 payerSeed, uint256 amount) external {
        address token = _token(tokenSeed);
        amount = bound(amount, 0, 1e12);
        _noteCoverage(token);
        address payer = _payers[payerSeed % _payers.length];
        USDC.mint(payer, amount);
        vm.startPrank(payer);
        USDC.approve(address(HOLDER), amount);
        bool delivered;
        try HOLDER.onFees(token, amount) {
            delivered = true;
        } catch {}
        vm.stopPrank();
        if (delivered) ghostCredited[token] += amount;
        else deliveryReverts += 1;
    }

    function setEligible(uint256 tokenSeed, bool eligible) external {
        MockLaunchToken(_token(tokenSeed)).forceEligibleSupply(eligible ? 1e18 : 0);
    }

    function _noteCoverage(address token) internal {
        if (MockLaunchToken(token).eligibleSupply() == 0) deliveriesWithoutHolders += 1;
    }
}

contract HolderDistributionPluginInvariantTest is Test {
    TestToken internal usdc;
    MockLaunchpad internal launchpad;
    HolderDistributionPlugin internal holder;
    HolderHandler internal handler;
    address[] internal tokens;

    function setUp() public {
        usdc = new TestToken("USD Coin", "USDC", 6, 0, address(this));
        launchpad = new MockLaunchpad(address(usdc));
        holder = new HolderDistributionPlugin(address(launchpad));

        for (uint256 i; i < 3; ++i) {
            MockLaunchToken token = new MockLaunchToken(address(usdc), address(launchpad));
            token.forceEligibleSupply(0);
            launchpad.launch(address(token), address(this), address(holder), address(0), "");
            tokens.push(address(token));
        }

        handler = new HolderHandler(holder, usdc, launchpad, tokens);
        usdc.transferOwnership(address(handler));

        bytes4[] memory selectors = new bytes4[](3);
        selectors[0] = HolderHandler.deliverViaLaunchpad.selector;
        selectors[1] = HolderHandler.deliverDirect.selector;
        selectors[2] = HolderHandler.setEligible.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// @dev The plugin holds nothing and leaves no allowance: every unit it received went into a token's distribute in
    ///      the same call.
    function invariant_holdsNothing() public view {
        assertEq(usdc.balanceOf(address(holder)), 0);
        for (uint256 i; i < tokens.length; ++i) {
            assertEq(holder.usdcHeld(tokens[i]), 0);
            assertEq(usdc.allowance(address(holder), tokens[i]), 0);
        }
    }

    /// @dev Per token: everything credited reached exactly that token's distribute, and nothing more.
    function invariant_everythingCreditedReachedItsToken() public view {
        for (uint256 i; i < tokens.length; ++i) {
            address token = tokens[i];
            assertEq(holder.totalDistributed(token), handler.ghostCredited(token));
            assertEq(MockLaunchToken(token).totalDistributed(), handler.ghostCredited(token));
            assertEq(usdc.balanceOf(token), handler.ghostCredited(token));
        }
    }

    /// @dev No delivery reverted, with or without eligible supply.
    function invariant_deliveriesNeverRevert() public view {
        assertEq(handler.deliveryReverts(), 0, "a delivery reverted");
    }
}

// ═══ Combo ════════════════════════════════════════════════════════════════════

contract ComboHandler is PluginHandlerBase {
    ComboPlugin internal immutable COMBO;
    SplitPlugin internal immutable SPLIT;
    BuybackBurnPlugin internal immutable BUYBACK;
    HolderDistributionPlugin internal immutable HOLDER;
    uint256 public releases; // coverage
    uint256 public buybackRuns; // coverage

    constructor(
        ComboPlugin combo_,
        SplitPlugin split_,
        BuybackBurnPlugin buyback_,
        HolderDistributionPlugin holder_,
        TestToken usdc_,
        MockLaunchpad launchpad_,
        address[] memory tokens_
    ) PluginHandlerBase(usdc_, launchpad_, tokens_) {
        COMBO = combo_;
        SPLIT = split_;
        BUYBACK = buyback_;
        HOLDER = holder_;
    }

    function deliverViaLaunchpad(uint256 tokenSeed, uint256 amount) external {
        _deliverViaLaunchpad(_token(tokenSeed), bound(amount, 0, 1e12));
    }

    function deliverDirect(uint256 tokenSeed, uint256 payerSeed, uint256 amount) external {
        _deliverDirect(address(COMBO), _token(tokenSeed), payerSeed, bound(amount, 0, 1e12));
    }

    function release(uint256 tokenSeed, uint256 payeeSeed) external {
        address token = _token(tokenSeed);
        (address[] memory payees,) = SPLIT.payeesOf(token);
        if (payees.length == 0) return;
        address payee = payees[payeeSeed % payees.length];
        if (SPLIT.releasable(token, payee) == 0) return;
        SPLIT.release(token, payee);
        releases += 1;
    }

    function runBuyback(uint256 tokenSeed) external {
        address token = _token(tokenSeed);
        (uint256 offered,) = BUYBACK.previewRun(token);
        if (offered == 0) return;
        BUYBACK.run(token);
        buybackRuns += 1;
    }

    function setEligible(uint256 tokenSeed, bool eligible) external {
        MockLaunchToken(_token(tokenSeed)).forceEligibleSupply(eligible ? 1e18 : 0);
    }

    function nextBlock() external {
        vm.roll(block.number + 1);
    }
}

contract ComboPluginInvariantTest is Test {
    TestToken internal usdc;
    MockLaunchpad internal launchpad;
    MockLaunchRouter internal router;
    ComboPlugin internal combo;
    SplitPlugin internal split;
    BuybackBurnPlugin internal buyback;
    HolderDistributionPlugin internal holder;
    ComboHandler internal handler;
    address[] internal tokens;
    address internal carol = makeAddr("carol wallet");
    address internal dave = makeAddr("dave wallet");

    function setUp() public {
        usdc = new TestToken("USD Coin", "USDC", 6, 0, address(this));
        launchpad = new MockLaunchpad(address(usdc));
        router = new MockLaunchRouter(launchpad);
        launchpad.setRouter(address(router));
        combo = new ComboPlugin(address(launchpad));
        split = new SplitPlugin(address(launchpad));
        buyback = new BuybackBurnPlugin(address(launchpad));
        holder = new HolderDistributionPlugin(address(launchpad));

        // Token 0: every reference plugin plus a wallet. Token 1: a different split plus another wallet.
        address[] memory targets0 = new address[](4);
        (targets0[0], targets0[1], targets0[2], targets0[3]) =
            (address(split), address(buyback), address(holder), carol);
        uint16[] memory bps0 = new uint16[](4);
        (bps0[0], bps0[1], bps0[2], bps0[3]) = (3000, 2500, 2000, 2500);
        bytes[] memory datas0 = new bytes[](4);
        datas0[0] = abi.encode(_two(makeAddr("alice"), makeAddr("bob")), _twoShares(1, 2));
        _launch(abi.encode(targets0, bps0, datas0));

        address[] memory targets1 = new address[](2);
        (targets1[0], targets1[1]) = (dave, address(split));
        uint16[] memory bps1 = new uint16[](2);
        (bps1[0], bps1[1]) = (3333, 6667);
        bytes[] memory datas1 = new bytes[](2);
        datas1[1] = abi.encode(_two(makeAddr("bob"), makeAddr("erin")), _twoShares(7, 3));
        _launch(abi.encode(targets1, bps1, datas1));

        handler = new ComboHandler(combo, split, buyback, holder, usdc, launchpad, tokens);
        usdc.transferOwnership(address(handler));

        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = ComboHandler.deliverViaLaunchpad.selector;
        selectors[1] = ComboHandler.deliverDirect.selector;
        selectors[2] = ComboHandler.release.selector;
        selectors[3] = ComboHandler.runBuyback.selector;
        selectors[4] = ComboHandler.setEligible.selector;
        selectors[5] = ComboHandler.nextBlock.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function _launch(bytes memory data) internal {
        MockLaunchToken token = new MockLaunchToken(address(usdc), address(launchpad));
        MockLaunchPair pair = new MockLaunchPair();
        token.setPair(address(pair));
        token.forceEligibleSupply(0);
        launchpad.launch(address(token), address(this), address(combo), address(pair), data);
        tokens.push(address(token));
    }

    /// @dev The Combo never keeps anything, and never leaves an allowance behind.
    function invariant_comboHoldsNothing() public view {
        assertEq(usdc.balanceOf(address(combo)), 0);
        assertEq(usdc.allowance(address(combo), address(split)), 0);
        assertEq(usdc.allowance(address(combo), address(buyback)), 0);
        assertEq(usdc.allowance(address(combo), address(holder)), 0);
    }

    /// @dev Everything credited to the Combo for a token reached exactly that token's destinations.
    function invariant_everythingForwardedToTheTokensDestinations() public view {
        address token0 = tokens[0];
        address token1 = tokens[1];
        uint256 reached0 = split.totalReceived(token0) + buyback.usdcHeld(token0) + buyback.totalUsdcSpent(token0)
            + holder.usdcHeld(token0) + holder.totalDistributed(token0) + usdc.balanceOf(carol);
        assertEq(reached0, handler.ghostCredited(token0));
        uint256 reached1 = split.totalReceived(token1) + usdc.balanceOf(dave);
        assertEq(reached1, handler.ghostCredited(token1));
        // Token 1's allocation has no buyback or holder entry: they never received anything for it.
        assertFalse(buyback.isConfigured(token1));
        assertFalse(holder.isConfigured(token1));
    }

    /// @dev Each sub-plugin holds exactly what it owes its tokens.
    function invariant_subPluginsHoldExactlyTheirPerTokenBalances() public view {
        assertEq(usdc.balanceOf(address(split)), split.usdcHeld(tokens[0]) + split.usdcHeld(tokens[1]));
        assertEq(usdc.balanceOf(address(buyback)), buyback.usdcHeld(tokens[0]));
        assertEq(usdc.balanceOf(address(holder)), holder.usdcHeld(tokens[0]));
    }

    function _two(address a, address b) internal pure returns (address[] memory r) {
        r = new address[](2);
        (r[0], r[1]) = (a, b);
    }

    function _twoShares(uint256 a, uint256 b) internal pure returns (uint256[] memory r) {
        r = new uint256[](2);
        (r[0], r[1]) = (a, b);
    }
}
