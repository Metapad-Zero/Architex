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

    function nextBlock(uint256 blocks) external {
        vm.roll(block.number + bound(blocks, 1, 3));
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

contract HolderHandler is PluginHandlerBase {
    /// @dev A token's stream just before a delivery.
    struct Before {
        uint256 due;
        uint256 unreleased;
        uint256 distributed;
        uint256 end;
    }

    HolderDistributionPlugin internal immutable HOLDER;
    uint256 internal immutable PERIOD;
    /// @notice Per token, the stream's balance right after its latest delivery (the line it may not drop below).
    mapping(address token => uint256) public ghostBalanceAfterDelivery;
    /// @notice Per token, when its latest delivery happened (where that line starts).
    mapping(address token => uint256) public ghostDeliveryTime;
    /// @notice Releases (by drip, dripAndClaim or a delivery) that differ from the linear rule.
    uint256 public badReleases;
    /// @notice Deliveries that released any of themselves in their own block, or left the stream mis-set.
    uint256 public badDeliveries;
    uint256 public releases; // coverage: drips that released something
    uint256 public partialReleases; // coverage: releases before the stream's end
    uint256 public heldForNoHolders; // coverage: something was due but the token had no eligible supply
    uint256 public deliveriesMidStream; // coverage: deliveries onto a stream that still held USDC
    uint256 public endsShortOfAFullPeriod; // coverage: deliveries whose weighted end fell short of now + period

    constructor(HolderDistributionPlugin holder_, TestToken usdc_, MockLaunchpad launchpad_, address[] memory tokens_)
        PluginHandlerBase(usdc_, launchpad_, tokens_)
    {
        HOLDER = holder_;
        PERIOD = holder_.DRIP_PERIOD();
    }

    function deliverViaLaunchpad(uint256 tokenSeed, uint256 amount) external {
        address token = _token(tokenSeed);
        amount = bound(amount, 0, 1e12);
        Before memory b = _beforeDelivery(token);
        _deliverViaLaunchpad(token, amount);
        _afterDelivery(token, amount, b);
    }

    function deliverDirect(uint256 tokenSeed, uint256 payerSeed, uint256 amount) external {
        address token = _token(tokenSeed);
        amount = bound(amount, 0, 1e12);
        Before memory b = _beforeDelivery(token);
        _deliverDirect(address(HOLDER), token, payerSeed, amount);
        _afterDelivery(token, amount, b);
    }

    function drip(uint256 tokenSeed) external {
        address token = _token(tokenSeed);
        uint256 expected = _expectedRelease(token);
        _noteCoverage(token, expected);
        _checkRelease(token, expected, HOLDER.drip(token));
    }

    /// @dev Anyone drips and claims; the mock token pays no dividends, so only the drip is checked here (the real
    ///      token's claims are covered in HolderDistributionPlugin.t.sol).
    function dripAndClaim(uint256 tokenSeed, uint256 callerSeed) external {
        address token = _token(tokenSeed);
        uint256 expected = _expectedRelease(token);
        _noteCoverage(token, expected);
        vm.prank(_payers[callerSeed % _payers.length]);
        (uint256 released,) = HOLDER.dripAndClaim(token);
        _checkRelease(token, expected, released);
    }

    function setEligible(uint256 tokenSeed, bool eligible) external {
        MockLaunchToken(_token(tokenSeed)).forceEligibleSupply(eligible ? 1e18 : 0);
    }

    function warp(uint256 secondsRaw) external {
        vm.warp(block.timestamp + bound(secondsRaw, 0, 30 hours));
    }

    /// @dev The rule, from the plugin's stream views and the token's eligibility.
    function _expectedRelease(address token) internal view returns (uint256) {
        uint256 pending = HOLDER.unreleased(token);
        if (pending == 0 || MockLaunchToken(token).eligibleSupply() == 0) return 0;
        uint256 end = HOLDER.streamEnd(token);
        if (block.timestamp >= end) return pending;
        uint256 last = HOLDER.lastDrip(token);
        return Math.mulDiv(pending, block.timestamp - last, end - last);
    }

    function _noteCoverage(address token, uint256 expected) internal {
        if (expected == 0 && HOLDER.unreleased(token) != 0 && MockLaunchToken(token).eligibleSupply() == 0) {
            heldForNoHolders += 1;
        }
        if (expected != 0) {
            releases += 1;
            if (block.timestamp < HOLDER.streamEnd(token)) partialReleases += 1;
        }
    }

    function _checkRelease(address token, uint256 expected, uint256 released) internal {
        if (released != expected) badReleases += 1;
        if (released != 0 && HOLDER.lastDrip(token) != block.timestamp) badReleases += 1;
        if (HOLDER.releasable(token) != 0) badReleases += 1; // a second drip in the same block has nothing
    }

    function _beforeDelivery(address token) internal view returns (Before memory b) {
        b.due = _expectedRelease(token);
        b.unreleased = HOLDER.unreleased(token);
        b.distributed = HOLDER.totalDistributed(token);
        b.end = HOLDER.streamEnd(token);
    }

    /// @dev A delivery releases exactly the old stream's due, restarts the line from now, moves the end to
    ///      ceil((kept * max(oldEnd, now) + amount * (now + period)) / (kept + amount)), which must lie in
    ///      [max(oldEnd, now), now + period] and after now, and leaves nothing releasable in its own block. A zero
    ///      delivery changes nothing.
    function _afterDelivery(address token, uint256 amount, Before memory b) internal {
        if (amount == 0) {
            if (
                HOLDER.unreleased(token) != b.unreleased || HOLDER.totalDistributed(token) != b.distributed
                    || HOLDER.streamEnd(token) != b.end
            ) badDeliveries += 1;
            return;
        }
        uint256 kept = b.unreleased - b.due;
        if (kept != 0) deliveriesMidStream += 1;
        uint256 from = b.end > block.timestamp ? b.end : block.timestamp;
        uint256 expectedEnd = (kept * from + amount * (block.timestamp + PERIOD) + kept + amount - 1) / (kept + amount);
        uint256 end = HOLDER.streamEnd(token);
        if (end < block.timestamp + PERIOD) endsShortOfAFullPeriod += 1;

        if (HOLDER.totalDistributed(token) != b.distributed + b.due) badReleases += 1;
        if (
            HOLDER.unreleased(token) != kept + amount || HOLDER.lastDrip(token) != block.timestamp
                || HOLDER.releasable(token) != 0
        ) badDeliveries += 1;
        if (end != expectedEnd || end < from || end > block.timestamp + PERIOD || end <= block.timestamp) {
            badDeliveries += 1;
        }
        ghostBalanceAfterDelivery[token] = HOLDER.unreleased(token);
        ghostDeliveryTime[token] = block.timestamp;
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

        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = HolderHandler.deliverViaLaunchpad.selector;
        selectors[1] = HolderHandler.deliverDirect.selector;
        selectors[2] = HolderHandler.drip.selector;
        selectors[3] = HolderHandler.dripAndClaim.selector;
        selectors[4] = HolderHandler.setEligible.selector;
        selectors[5] = HolderHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// @dev The plugin holds exactly Σ unreleased: every other unit it received went into a token's distribute.
    function invariant_usdcHeldEqualsSumOfUnreleased() public view {
        uint256 sum;
        for (uint256 i; i < tokens.length; ++i) {
            assertEq(holder.usdcHeld(tokens[i]), holder.unreleased(tokens[i]));
            sum += holder.unreleased(tokens[i]);
        }
        assertEq(usdc.balanceOf(address(holder)), sum);
    }

    /// @dev Per token: unreleased + distributed == credited, and the token received exactly what was distributed.
    function invariant_perTokenDistributionAccounting() public view {
        for (uint256 i; i < tokens.length; ++i) {
            address token = tokens[i];
            assertEq(holder.unreleased(token) + holder.totalDistributed(token), handler.ghostCredited(token));
            assertEq(MockLaunchToken(token).totalDistributed(), holder.totalDistributed(token));
            assertEq(usdc.balanceOf(token), holder.totalDistributed(token));
            assertEq(usdc.allowance(address(holder), token), 0);
        }
    }

    /// @dev A stream with USDC in it started at most DRIP_PERIOD before its end, has not started in the future, and
    ///      never has more releasable than it holds.
    function invariant_streamShape() public view {
        uint256 period = holder.DRIP_PERIOD();
        for (uint256 i; i < tokens.length; ++i) {
            address token = tokens[i];
            uint256 releasable = holder.releasable(token);
            assertLe(releasable, holder.unreleased(token));
            if (holder.unreleased(token) == 0) continue;
            uint256 last = holder.lastDrip(token);
            uint256 end = holder.streamEnd(token);
            assertLe(last, block.timestamp);
            assertLt(last, end);
            assertLe(end - last, period);
        }
    }

    /// @dev Never early: until the stream's end, what is unreleased stays on or above the straight line from the
    ///      balance right after the latest delivery (at that delivery's time) down to zero at the end. That window is
    ///      at most a period, so the weaker full-period form holds too.
    function invariant_neverReleasesEarly() public view {
        uint256 period = holder.DRIP_PERIOD();
        for (uint256 i; i < tokens.length; ++i) {
            address token = tokens[i];
            uint256 end = holder.streamEnd(token);
            if (block.timestamp >= end) continue;
            uint256 line = handler.ghostBalanceAfterDelivery(token) * (end - block.timestamp);
            assertGe(holder.unreleased(token) * (end - handler.ghostDeliveryTime(token)), line);
            assertGe(holder.unreleased(token) * period, line);
        }
    }

    /// @dev Every release followed the rule, and no delivery released any of itself.
    function invariant_everyReleaseFollowedTheRule() public view {
        assertEq(handler.badReleases(), 0, "a release broke the linear rule");
        assertEq(handler.badDeliveries(), 0, "a delivery released itself or mis-set the stream");
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
    uint256 public drips; // coverage: holder drips that released something

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

    function drip(uint256 tokenSeed) external {
        address token = _token(tokenSeed);
        if (!HOLDER.isConfigured(token)) return;
        if (HOLDER.drip(token) != 0) drips += 1;
    }

    function setEligible(uint256 tokenSeed, bool eligible) external {
        MockLaunchToken(_token(tokenSeed)).forceEligibleSupply(eligible ? 1e18 : 0);
    }

    function nextBlock() external {
        vm.roll(block.number + 1);
    }

    /// @dev Time passes, so the holder slice's stream drips.
    function warp(uint256 secondsRaw) external {
        vm.warp(block.timestamp + bound(secondsRaw, 0, 30 hours));
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

        bytes4[] memory selectors = new bytes4[](8);
        selectors[0] = ComboHandler.deliverViaLaunchpad.selector;
        selectors[1] = ComboHandler.deliverDirect.selector;
        selectors[2] = ComboHandler.release.selector;
        selectors[3] = ComboHandler.runBuyback.selector;
        selectors[4] = ComboHandler.drip.selector;
        selectors[5] = ComboHandler.setEligible.selector;
        selectors[6] = ComboHandler.nextBlock.selector;
        selectors[7] = ComboHandler.warp.selector;
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
