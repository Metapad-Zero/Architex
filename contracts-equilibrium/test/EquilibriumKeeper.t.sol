// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {EquilibriumKeeper} from "../../contracts/equilibrium/EquilibriumKeeper.sol";
import {MintableToken, MockV2Pair, MockV3Pool} from "./KeeperMocks.sol";

/// Every bound the keeper vault enforces itself, driven against constant-product pools with the real
/// v2 balance-delta accounting and the real v3 callback ordering. Real pool bytecode and real
/// executable quotes are proven separately on pinned forks.
contract EquilibriumKeeperTest is Test {
    MintableToken private token;
    MintableToken private quote;
    MockV2Pair private pair;
    MockV3Pool private pool;
    EquilibriumKeeper private vault;
    EquilibriumKeeper private v3Vault;

    address private constant OPERATOR = address(0xA11CE);
    address private constant STRANGER = address(0xB0B);
    bytes32 private constant CYCLE = keccak256("cycle-1");

    uint256 private constant MAX_TOKENS = 2_000e6;
    uint256 private constant MAX_QUOTE = 3_000e6;
    uint256 private constant SPEND_CAP = 4_000e6;
    uint256 private constant RESERVE = 1_500e6;
    uint256 private constant DRAIN_CAP = 4_000e6;

    function setUp() public {
        token = new MintableToken("Equilibrium", "EQL", 6);
        quote = new MintableToken("USDC", "USDC", 6);
        pair = new MockV2Pair(address(token), address(quote));
        pool = new MockV3Pool(address(token), address(quote));
        token.mint(address(pair), 500_000e6);
        quote.mint(address(pair), 500_000e6);
        pair.sync();
        token.mint(address(pool), 500_000e6);
        quote.mint(address(pool), 600_000e6);
        pool.sync();
        vault = _deploy(address(pair), EquilibriumKeeper.Venue.ArchitexPair, RESERVE, SPEND_CAP, DRAIN_CAP, 1);
        v3Vault = _deploy(address(pool), EquilibriumKeeper.Venue.UniswapV3Pool, RESERVE, SPEND_CAP, DRAIN_CAP, 1);
        for (EquilibriumKeeper v = vault; ; v = v3Vault) {
            token.mint(address(v), 2_000e6);
            quote.mint(address(v), 5_000e6);
            if (v == v3Vault) break;
        }
    }

    function _deploy(address venuePool, EquilibriumKeeper.Venue venue, uint256 reserve, uint256 spendCap, uint256 drainCap, uint8 maxOpen)
        private returns (EquilibriumKeeper)
    {
        return _deploy(venuePool, venue, MAX_QUOTE, reserve, spendCap, drainCap, maxOpen);
    }

    function _deploy(address venuePool, EquilibriumKeeper.Venue venue, uint256 maxQuote, uint256 reserve, uint256 spendCap, uint256 drainCap, uint8 maxOpen)
        private returns (EquilibriumKeeper)
    {
        return new EquilibriumKeeper(
            OPERATOR, IERC20(address(token)), IERC20(address(quote)), venuePool, venue,
            MAX_TOKENS, maxQuote, spendCap, reserve, drainCap, maxOpen
        );
    }

    function _leg(EquilibriumKeeper v, string memory name, EquilibriumKeeper.LegKind kind, uint256 tokens, uint256 limit)
        private view returns (EquilibriumKeeper.Leg memory)
    {
        return EquilibriumKeeper.Leg({
            id: keccak256(abi.encode(name, address(v))), cycle: CYCLE, kind: kind, chainId: block.chainid,
            pool: v.pool(), tokens: tokens, limit: limit, deadline: block.timestamp + 300
        });
    }

    function _run(EquilibriumKeeper v, EquilibriumKeeper.Leg memory leg) private returns (uint256, uint256) {
        vm.prank(OPERATOR);
        return v.run(leg);
    }

    // ------------------------------------------------------------ happy paths

    function test_v2BuyThenSellRunsOnceAndMovesExactlyTheBoundAmounts() public {
        uint256 quoted = _quoteBuy(vault, 1_000e6);
        EquilibriumKeeper.Leg memory buy = _leg(vault, "buy", EquilibriumKeeper.LegKind.Buy, 1_000e6, quoted);
        (uint256 amountIn, uint256 amountOut) = _run(vault, buy);
        assertEq(amountOut, 1_000e6, "exact output delivered");
        assertEq(amountIn, quoted, "executed input equals the probe quote");
        assertEq(vault.spentQuote(), amountIn);
        assertEq(vault.openCycles(), 1);
        assertEq(vault.openTokensOf(CYCLE), 1_000e6);
        assertEq(vault.legOf(buy.id), keccak256(abi.encode(buy)), "leg digest bound");

        uint256 proceeds = _quoteSell(vault, 1_000e6);
        EquilibriumKeeper.Leg memory sell = _leg(vault, "sell", EquilibriumKeeper.LegKind.Sell, 1_000e6, proceeds);
        (uint256 sold, uint256 received) = _run(vault, sell);
        assertEq(sold, 1_000e6);
        assertEq(received, proceeds, "executed output equals the probe quote");
        assertEq(vault.receivedQuote(), received);
    }

    function test_v3BuySellRoundTripHonoursTheBoundLimits() public {
        uint256 quoted = _quoteBuy(v3Vault, 500e6);
        (uint256 amountIn, uint256 amountOut) = _run(v3Vault, _leg(v3Vault, "buy", EquilibriumKeeper.LegKind.Buy, 500e6, quoted));
        assertEq(amountOut, 500e6);
        assertEq(amountIn, quoted);
        uint256 proceeds = _quoteSell(v3Vault, 500e6);
        (, uint256 received) = _run(v3Vault, _leg(v3Vault, "sell", EquilibriumKeeper.LegKind.Sell, 500e6, proceeds));
        assertEq(received, proceeds);
    }

    // ------------------------------------------------- replay and destination

    function test_repeatingASettledLegRevertsWithoutMovingAnything() public {
        EquilibriumKeeper.Leg memory buy = _leg(vault, "buy", EquilibriumKeeper.LegKind.Buy, 1_000e6, _quoteBuy(vault, 1_000e6));
        _run(vault, buy);
        uint256 spent = vault.spentQuote();
        uint256 held = quote.balanceOf(address(vault));
        vm.prank(OPERATOR);
        vm.expectRevert(abi.encodeWithSelector(EquilibriumKeeper.LegDone.selector, buy.id, keccak256(abi.encode(buy))));
        vault.run(buy);
        assertEq(vault.spentQuote(), spent, "nothing spent on the repeat");
        assertEq(quote.balanceOf(address(vault)), held);
    }

    function test_aLegPlannedForAnotherChainIsRefusedHere() public {
        EquilibriumKeeper.Leg memory leg = _leg(vault, "buy", EquilibriumKeeper.LegKind.Buy, 100e6, MAX_QUOTE);
        leg.chainId = block.chainid + 1;
        vm.prank(OPERATOR);
        vm.expectRevert(abi.encodeWithSelector(EquilibriumKeeper.WrongChain.selector, block.chainid + 1, block.chainid));
        vault.run(leg);
    }

    function test_aLegPlannedForAnotherPoolIsRefusedHere() public {
        EquilibriumKeeper.Leg memory leg = _leg(vault, "buy", EquilibriumKeeper.LegKind.Buy, 100e6, MAX_QUOTE);
        leg.pool = address(pool);
        vm.prank(OPERATOR);
        vm.expectRevert(abi.encodeWithSelector(EquilibriumKeeper.WrongPool.selector, address(pool), address(pair)));
        vault.run(leg);
    }

    function test_onlyTheOwnerMayRun() public {
        EquilibriumKeeper.Leg memory small = _leg(vault, "buy", EquilibriumKeeper.LegKind.Buy, 100e6, MAX_QUOTE);
        vm.prank(STRANGER);
        vm.expectRevert(EquilibriumKeeper.NotOwner.selector);
        vault.run(small);
    }

    function test_aStaleQuotesLegExpiresInsteadOfExecuting() public {
        EquilibriumKeeper.Leg memory leg = _leg(vault, "buy", EquilibriumKeeper.LegKind.Buy, 100e6, MAX_QUOTE);
        vm.warp(leg.deadline + 1);
        vm.prank(OPERATOR);
        vm.expectRevert(abi.encodeWithSelector(EquilibriumKeeper.LegExpired.selector, leg.deadline, leg.deadline + 1));
        vault.run(leg);
    }

    function test_aStrangerCannotDrawTheV3Callback() public {
        vm.prank(STRANGER);
        vm.expectRevert(EquilibriumKeeper.CallbackForbidden.selector);
        v3Vault.uniswapV3SwapCallback(1, -1, abi.encode(uint256(1)));
    }

    // ---------------------------------------------------------------- bounds

    function test_aBuyAboveTheQuoteLimitIsRefusedBeforeAnythingMoves() public {
        uint256 quoted = _quoteBuy(vault, 1_000e6);
        uint256 held = quote.balanceOf(address(vault));
        EquilibriumKeeper.Leg memory buy = _leg(vault, "buy", EquilibriumKeeper.LegKind.Buy, 1_000e6, quoted - 1);
        vm.prank(OPERATOR);
        vm.expectRevert(abi.encodeWithSelector(EquilibriumKeeper.MaxInExceeded.selector, quoted, quoted - 1));
        vault.run(buy);
        assertEq(quote.balanceOf(address(vault)), held);
    }

    function test_aSaleBelowItsFloorIsRefused() public {
        uint256 proceeds = _quoteSell(vault, 1_000e6);
        EquilibriumKeeper.Leg memory sell = _leg(vault, "sell", EquilibriumKeeper.LegKind.Sell, 1_000e6, proceeds + 1);
        vm.prank(OPERATOR);
        vm.expectRevert(abi.encodeWithSelector(EquilibriumKeeper.MinOutShortfall.selector, proceeds, proceeds + 1));
        vault.run(sell);
    }

    function test_aLegAboveThePerLegSizeLimitIsRefused() public {
        EquilibriumKeeper.Leg memory big = _leg(vault, "buy", EquilibriumKeeper.LegKind.Buy, MAX_TOKENS + 1, MAX_QUOTE);
        vm.prank(OPERATOR);
        vm.expectRevert(abi.encodeWithSelector(EquilibriumKeeper.LegTooLarge.selector, MAX_TOKENS + 1, MAX_TOKENS));
        vault.run(big);
    }

    function test_aBuyLimitAboveThePerLegQuoteCapIsRefused() public {
        EquilibriumKeeper.Leg memory overLimit = _leg(vault, "buy", EquilibriumKeeper.LegKind.Buy, 100e6, MAX_QUOTE + 1);
        vm.prank(OPERATOR);
        vm.expectRevert(abi.encodeWithSelector(EquilibriumKeeper.LimitTooLarge.selector, MAX_QUOTE + 1, MAX_QUOTE));
        vault.run(overLimit);
    }

    function test_theSessionSpendCapStopsTheSecondPurchase() public {
        // A vault whose spend cap allows one 1,000 EQL purchase and not a second.
        EquilibriumKeeper tight = _deploy(address(pair), EquilibriumKeeper.Venue.ArchitexPair, 1_050e6, 0, 1_100e6, DRAIN_CAP, 2);
        token.mint(address(tight), 2_000e6);
        quote.mint(address(tight), 5_000e6);
        uint256 first = _quoteBuy(tight, 1_000e6);
        _run(tight, _leg(tight, "buy-1", EquilibriumKeeper.LegKind.Buy, 1_000e6, first));
        uint256 second = _quoteBuy(tight, 1_000e6);
        EquilibriumKeeper.Leg memory buy2 = _leg(tight, "buy-2", EquilibriumKeeper.LegKind.Buy, 1_000e6, second);
        buy2.cycle = keccak256("cycle-2");
        uint256 cumulative = tight.spentQuote() + second;
        vm.prank(OPERATOR);
        vm.expectRevert(abi.encodeWithSelector(EquilibriumKeeper.SpendCapExceeded.selector, cumulative, 1_100e6));
        tight.run(buy2);
    }

    function test_theNetDrainCapStopsTheCycleThatWouldEmptyTheVault() public {
        // A vault's net drain cap can never sit below one leg's quote cap, so it binds cumulatively:
        // one purchase fits, a second unsold one does not.
        EquilibriumKeeper tight = _deploy(address(pair), EquilibriumKeeper.Venue.ArchitexPair, 600e6, 0, SPEND_CAP, 600e6, 2);
        token.mint(address(tight), 2_000e6);
        quote.mint(address(tight), 5_000e6);
        uint256 first = _quoteBuy(tight, 490e6);
        _run(tight, _leg(tight, "buy-1", EquilibriumKeeper.LegKind.Buy, 490e6, first));
        assertEq(tight.spentQuote() - tight.receivedQuote(), first, "one purchase fits inside the drain cap");

        uint256 second = _quoteBuy(tight, 490e6);
        EquilibriumKeeper.Leg memory buy2 = _leg(tight, "buy-2", EquilibriumKeeper.LegKind.Buy, 490e6, second);
        buy2.cycle = keccak256("cycle-2");
        uint256 drained = first + second;
        vm.prank(OPERATOR);
        vm.expectRevert(abi.encodeWithSelector(EquilibriumKeeper.DrainCapExceeded.selector, drained, 600e6));
        tight.run(buy2);
    }

    function test_aPurchaseThatWouldEatTheRecoveryReserveIsRefused() public {
        // Reserve set above what the vault would hold after the purchase.
        EquilibriumKeeper reserved = _deploy(address(pair), EquilibriumKeeper.Venue.ArchitexPair, 4_500e6, SPEND_CAP, DRAIN_CAP, 1);
        token.mint(address(reserved), 2_000e6);
        quote.mint(address(reserved), 5_000e6);
        uint256 cost = _quoteBuy(reserved, 1_000e6);
        EquilibriumKeeper.Leg memory buy = _leg(reserved, "buy", EquilibriumKeeper.LegKind.Buy, 1_000e6, cost);
        vm.prank(OPERATOR);
        vm.expectRevert(abi.encodeWithSelector(EquilibriumKeeper.RecoveryReserveBreached.selector, 5_000e6 - cost, 4_500e6));
        reserved.run(buy);
    }

    function test_aShortFillIsRefusedRatherThanAcceptedAsPartial() public {
        pool.setFillBps(9_000);
        uint256 quoted = _quoteBuy(v3Vault, 500e6);
        EquilibriumKeeper.Leg memory buy = _leg(v3Vault, "buy", EquilibriumKeeper.LegKind.Buy, 500e6, quoted * 2);
        vm.prank(OPERATOR);
        vm.expectRevert(abi.encodeWithSelector(EquilibriumKeeper.TokensNotDelivered.selector, 450e6, 500e6));
        v3Vault.run(buy);
    }

    // --------------------------------------------------- exposure and recovery

    function test_aSecondCycleCannotOpenWhileOneIsOpen() public {
        _run(vault, _leg(vault, "buy", EquilibriumKeeper.LegKind.Buy, 1_000e6, _quoteBuy(vault, 1_000e6)));
        EquilibriumKeeper.Leg memory next = _leg(vault, "buy-2", EquilibriumKeeper.LegKind.Buy, 100e6, MAX_QUOTE);
        next.cycle = keccak256("cycle-2");
        vm.prank(OPERATOR);
        vm.expectRevert(abi.encodeWithSelector(EquilibriumKeeper.TooManyOpenCycles.selector, uint8(1), uint8(1)));
        vault.run(next);
    }

    function test_aHaltedVaultRefusesToOpenOrSellButStillRecovers() public {
        _run(vault, _leg(vault, "buy", EquilibriumKeeper.LegKind.Buy, 1_000e6, _quoteBuy(vault, 1_000e6)));
        vm.prank(OPERATOR);
        vault.halt("sale leg failed");

        EquilibriumKeeper.Leg memory sell = _leg(vault, "sell", EquilibriumKeeper.LegKind.Sell, 1_000e6, 0);
        vm.prank(OPERATOR);
        vm.expectRevert(EquilibriumKeeper.Paused.selector);
        vault.run(sell);

        uint256 proceeds = _quoteSell(vault, 1_000e6);
        EquilibriumKeeper.Leg memory recover = _leg(vault, "recover", EquilibriumKeeper.LegKind.Recover, 1_000e6, proceeds);
        (uint256 sold, uint256 received) = _run(vault, recover);
        assertEq(sold, 1_000e6);
        assertEq(received, proceeds);
        assertEq(vault.openCycles(), 0, "recovery closed the position");
        assertEq(vault.openTokensOf(CYCLE), 0);
    }

    function test_recoveryMustCloseExactlyTheOpenPosition() public {
        _run(vault, _leg(vault, "buy", EquilibriumKeeper.LegKind.Buy, 1_000e6, _quoteBuy(vault, 1_000e6)));
        EquilibriumKeeper.Leg memory shortRecover = _leg(vault, "recover", EquilibriumKeeper.LegKind.Recover, 500e6, 0);
        vm.prank(OPERATOR);
        vm.expectRevert(abi.encodeWithSelector(EquilibriumKeeper.RecoverAmountMismatch.selector, 1_000e6, 500e6));
        vault.run(shortRecover);
    }

    function test_recoveryOfAnUnopenedCycleIsRefused() public {
        EquilibriumKeeper.Leg memory orphanRecover = _leg(vault, "recover", EquilibriumKeeper.LegKind.Recover, 1_000e6, 0);
        vm.prank(OPERATOR);
        vm.expectRevert(abi.encodeWithSelector(EquilibriumKeeper.CycleNotOpen.selector, CYCLE));
        vault.run(orphanRecover);
    }

    function test_resumeRefusesWhileAPositionIsOpenAndSucceedsAfterRecovery() public {
        _run(vault, _leg(vault, "buy", EquilibriumKeeper.LegKind.Buy, 1_000e6, _quoteBuy(vault, 1_000e6)));
        vm.prank(OPERATOR);
        vault.halt("sale leg failed");
        vm.prank(OPERATOR);
        vm.expectRevert(abi.encodeWithSelector(EquilibriumKeeper.OpenExposure.selector, uint8(1)));
        vault.resume();

        _run(vault, _leg(vault, "recover", EquilibriumKeeper.LegKind.Recover, 1_000e6, _quoteSell(vault, 1_000e6)));
        vm.prank(OPERATOR);
        vault.resume();
        assertFalse(vault.halted());
    }

    function test_attestingARemoteSaleClosesThePositionOnce() public {
        _run(vault, _leg(vault, "buy", EquilibriumKeeper.LegKind.Buy, 1_000e6, _quoteBuy(vault, 1_000e6)));
        vm.prank(OPERATOR);
        vault.attestClosed(CYCLE, keccak256("remote-sell"));
        assertEq(vault.openCycles(), 0);
        vm.prank(OPERATOR);
        vm.expectRevert(abi.encodeWithSelector(EquilibriumKeeper.CycleNotOpen.selector, CYCLE));
        vault.attestClosed(CYCLE, keccak256("remote-sell"));
    }

    function test_withdrawalIsRefusedWhileExposureIsOpenOrTheVaultIsHalted() public {
        _run(vault, _leg(vault, "buy", EquilibriumKeeper.LegKind.Buy, 1_000e6, _quoteBuy(vault, 1_000e6)));
        vm.prank(OPERATOR);
        vm.expectRevert(abi.encodeWithSelector(EquilibriumKeeper.OpenExposure.selector, uint8(1)));
        vault.withdraw(IERC20(address(quote)), OPERATOR, 1);

        vm.prank(OPERATOR);
        vault.attestClosed(CYCLE, keccak256("remote-sell"));
        vm.prank(OPERATOR);
        vault.halt("end of session");
        vm.prank(OPERATOR);
        vm.expectRevert(EquilibriumKeeper.Paused.selector);
        vault.withdraw(IERC20(address(quote)), OPERATOR, 1);

        vm.prank(OPERATOR);
        vault.resume();
        uint256 before = quote.balanceOf(OPERATOR);
        vm.prank(OPERATOR);
        vault.withdraw(IERC20(address(quote)), OPERATOR, 10e6);
        assertEq(quote.balanceOf(OPERATOR) - before, 10e6);
    }

    function test_constructorRefusesCapsBelowOneLeg() public {
        vm.expectRevert("Caps below one leg");
        new EquilibriumKeeper(
            OPERATOR, IERC20(address(token)), IERC20(address(quote)), address(pair), EquilibriumKeeper.Venue.ArchitexPair,
            MAX_TOKENS, MAX_QUOTE, MAX_QUOTE - 1, RESERVE, DRAIN_CAP, 1
        );
    }

    // ------------------------------------------------------ executable quotes

    /// The probe answers by reverting, so a quote can never move funds.
    function _quoteBuy(EquilibriumKeeper v, uint256 tokens) private returns (uint256 amountIn) {
        uint256 held = quote.balanceOf(address(v));
        try v.probe(true, tokens) { revert("probe must revert"); }
        catch (bytes memory reason) { (amountIn,) = _decodeQuote(reason); }
        assertEq(quote.balanceOf(address(v)), held, "quoting spent nothing");
    }
    function _quoteSell(EquilibriumKeeper v, uint256 tokens) private returns (uint256 amountOut) {
        uint256 held = token.balanceOf(address(v));
        try v.probe(false, tokens) { revert("probe must revert"); }
        catch (bytes memory reason) { (, amountOut) = _decodeQuote(reason); }
        assertEq(token.balanceOf(address(v)), held, "quoting spent nothing");
    }
    function _decodeQuote(bytes memory reason) private pure returns (uint256 amountIn, uint256 amountOut) {
        require(reason.length == 68, "unexpected revert payload");
        bytes4 selector;
        assembly { selector := mload(add(reason, 0x20)) }
        require(selector == EquilibriumKeeper.Quoted.selector, "not a Quoted revert");
        assembly {
            amountIn := mload(add(reason, 0x24))
            amountOut := mload(add(reason, 0x44))
        }
    }
}
