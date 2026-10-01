// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {SeismicCurveHub, Origin} from "../src/SeismicCurveHub.sol";
import {LocalTestEndpoint} from "../src/LocalTestEndpoint.sol";

/// Logic tests under sforge. Shielded arguments here are plain calldata; the encrypted (0x4A) path is
/// exercised against sanvil by script/prototype.ts.
contract SeismicCurveHubTest is Test {
    uint32 constant HUB_EID = 40456;
    uint32 constant ARC = 40434;
    uint32 constant BASE = 40245;
    bytes32 constant ARC_PEER = bytes32(uint256(0xa4c));
    bytes32 constant BASE_PEER = bytes32(uint256(0xba5e));
    bytes32 constant ASSET = keccak256("EQL");
    bytes32 constant USDC = keccak256("USDC");
    address constant ALICE = address(0xA11CE);
    address constant BOB = address(0xB0B);

    LocalTestEndpoint endpoint;
    SeismicCurveHub hub;
    bytes32 curve;
    uint64 nonce;

    function setUp() public {
        endpoint = new LocalTestEndpoint(HUB_EID, address(this));
        hub = new SeismicCurveHub(endpoint, HUB_EID);
        hub.setPeer(ARC, ARC_PEER);
        hub.setPeer(BASE, BASE_PEER);
        // 30,000 USDC virtual quote, 1,073,000,000 virtual tokens, 800,000,000 sold on the curve, graduation at 85,000 USDC.
        curve = hub.openCurve(ASSET, USDC, 30_000e6, 1_073_000_000e6, 800_000_000e6, 85_000e6);
    }

    function deposit(uint32 src, bytes32 peer, bytes32 depositId, uint256 amount, uint8 decimals, address to) internal returns (bytes32 guid) {
        Origin memory origin = Origin(src, peer, ++nonce);
        guid = keccak256(abi.encodePacked(origin.nonce, origin.srcEid, origin.sender, HUB_EID, bytes32(uint256(uint160(address(hub))))));
        endpoint.deliver(address(hub), origin, guid, abi.encode(uint8(1), depositId, USDC, amount, decimals, to));
    }

    function balances(address who) internal returns (uint256 q, uint256 t) {
        vm.startPrank(who);
        q = hub.myQuoteBalance(USDC);
        t = hub.myTokenBalance(curve);
        vm.stopPrank();
    }

    function expected(uint256 reserve, uint256 soldSoFar, uint256 q) internal pure returns (uint256) {
        return (1_073_000_000e6 - soldSoFar) * q / (30_000e6 + reserve + q);
    }

    function test_authenticatedDepositCreditsOnceAndNormalizes() public {
        deposit(ARC, ARC_PEER, keccak256("arc-1"), 1_000e18, 18, ALICE);
        deposit(BASE, BASE_PEER, keccak256("base-1"), 500e6, 6, ALICE);
        (uint256 q,) = balances(ALICE);
        assertEq(q, 1_500e6);
        assertEq(hub.totalCredited(USDC), 1_500e6);
        // Dust below one atom is refused, not rounded.
        vm.expectRevert(SeismicCurveHub.BadMessage.selector);
        deposit(ARC, ARC_PEER, keccak256("arc-dust"), 1e18 + 1, 18, ALICE);
    }

    function test_forgedPeerEndpointGuidAndReplaysAreRefused() public {
        bytes32 guid = deposit(ARC, ARC_PEER, keccak256("arc-1"), 100e6, 6, ALICE);
        Origin memory origin = Origin(ARC, ARC_PEER, nonce);
        bytes memory message = abi.encode(uint8(1), keccak256("arc-1"), USDC, uint256(100e6), uint8(6), ALICE);
        // Same packet again.
        vm.expectRevert(SeismicCurveHub.Replayed.selector);
        endpoint.deliver(address(hub), origin, guid, message);
        // Same source deposit id under a fresh packet.
        vm.expectRevert(SeismicCurveHub.Replayed.selector);
        deposit(ARC, ARC_PEER, keccak256("arc-1"), 100e6, 6, ALICE);
        // A peer that is not registered for the source domain.
        vm.expectRevert(SeismicCurveHub.UnknownPeer.selector);
        deposit(ARC, BASE_PEER, keccak256("arc-2"), 100e6, 6, ALICE);
        // An unregistered domain.
        vm.expectRevert(SeismicCurveHub.UnknownPeer.selector);
        deposit(30168, ARC_PEER, keccak256("sol-1"), 100e6, 6, ALICE);
        // A GUID that is not the one the origin implies.
        Origin memory fresh = Origin(ARC, ARC_PEER, 99);
        vm.expectRevert(SeismicCurveHub.GuidMismatch.selector);
        endpoint.deliver(address(hub), fresh, keccak256("forged"), message);
        // Anyone but the endpoint calling the receiver directly.
        bytes32 freshGuid = hub.guidOf(fresh);
        vm.prank(BOB);
        vm.expectRevert(SeismicCurveHub.NotEndpoint.selector);
        hub.lzReceive(fresh, freshGuid, message, BOB, "");
        (uint256 q,) = balances(ALICE);
        assertEq(q, 100e6);
    }

    function test_reorderedDeliveriesConverge() public {
        Origin memory first = Origin(ARC, ARC_PEER, 1);
        Origin memory second = Origin(ARC, ARC_PEER, 2);
        endpoint.deliver(address(hub), second, hub.guidOf(second), abi.encode(uint8(1), keccak256("d2"), USDC, uint256(20e6), uint8(6), ALICE));
        endpoint.deliver(address(hub), first, hub.guidOf(first), abi.encode(uint8(1), keccak256("d1"), USDC, uint256(10e6), uint8(6), ALICE));
        (uint256 q,) = balances(ALICE);
        assertEq(q, 30e6);
    }

    function test_noCallerSuppliedAmountCanCreateABalance() public {
        vm.prank(BOB);
        vm.expectRevert(SeismicCurveHub.Insufficient.selector);
        hub.buy(curve, suint256(1_000e6), suint256(0), block.timestamp);
        vm.prank(BOB);
        vm.expectRevert(SeismicCurveHub.Insufficient.selector);
        hub.withdraw(curve, 1, ARC, bytes32(uint256(1)));
    }

    function test_buyFollowsTheCurveRoundsDownAndChecksSlippageAndDeadline() public {
        deposit(ARC, ARC_PEER, keccak256("a"), 10_000e6, 6, ALICE);
        uint256 out1 = expected(0, 0, 1_000e6);
        vm.prank(ALICE);
        hub.buy(curve, suint256(1_000e6), suint256(out1), block.timestamp);
        (uint256 q, uint256 t) = balances(ALICE);
        assertEq(q, 9_000e6);
        assertEq(t, out1);
        uint256 out2 = expected(1_000e6, out1, 2_000e6);
        assertLt(out2 * 1_000e6, out1 * 2_000e6, "price rises along the curve");
        vm.prank(ALICE);
        vm.expectRevert(SeismicCurveHub.Slippage.selector);
        hub.buy(curve, suint256(2_000e6), suint256(out2 + 1), block.timestamp);
        vm.prank(ALICE);
        vm.expectRevert(SeismicCurveHub.Expired.selector);
        hub.buy(curve, suint256(2_000e6), suint256(0), block.timestamp - 1);
        vm.prank(ALICE);
        hub.buy(curve, suint256(2_000e6), suint256(out2), block.timestamp);
        (, t) = balances(ALICE);
        assertEq(t, out1 + out2);
        assertEq(hub.quote(curve, 1e6), expected(3_000e6, out1 + out2, 1e6));
        assertTrue(hub.conserved(curve));
    }

    function test_graduationIsOnceAndClosesTheCurve() public {
        deposit(ARC, ARC_PEER, keccak256("a"), 100_000e6, 6, ALICE);
        vm.prank(ALICE);
        hub.buy(curve, suint256(84_999e6), suint256(0), block.timestamp);
        (,,,,,,, bool graduated) = hub.curves(curve);
        assertFalse(graduated);
        vm.prank(ALICE);
        vm.expectEmit(true, false, false, false, address(hub));
        emit SeismicCurveHub.Graduated(curve);
        hub.buy(curve, suint256(1e6), suint256(0), block.timestamp);
        (,,,,,,, graduated) = hub.curves(curve);
        assertTrue(graduated);
        vm.prank(ALICE);
        vm.expectRevert(SeismicCurveHub.CurveClosed.selector);
        hub.buy(curve, suint256(1e6), suint256(0), block.timestamp);
        assertTrue(hub.conserved(curve));
    }

    function test_unavailableDestinationKeepsThePendingClaimAndRetriesOnce() public {
        deposit(ARC, ARC_PEER, keccak256("a"), 1_000e6, 6, ALICE);
        vm.prank(ALICE);
        hub.buy(curve, suint256(1_000e6), suint256(0), block.timestamp);
        (, uint256 t) = balances(ALICE);
        endpoint.setAvailable(false);
        vm.prank(ALICE);
        bytes32 id = hub.withdraw(curve, t / 2, BASE, bytes32(uint256(0xbeef)));
        (,,,,, bool sent,) = hub.outbound(id);
        assertFalse(sent);
        assertEq(hub.pendingOutbound(curve), t / 2);
        assertTrue(hub.conserved(curve), "a pending claim is accounted, not lost");
        vm.expectRevert(SeismicCurveHub.Insufficient.selector);
        hub.retry(id);
        endpoint.setAvailable(true);
        hub.retry(id);
        (,,,,, sent,) = hub.outbound(id);
        assertTrue(sent);
        assertEq(hub.pendingOutbound(curve), 0);
        assertEq(hub.totalWithdrawn(curve), t / 2);
        vm.expectRevert(SeismicCurveHub.AlreadySent.selector);
        hub.retry(id);
        assertTrue(hub.conserved(curve));
    }

    function test_quoteIsOperatorOnly() public {
        vm.prank(ALICE);
        vm.expectRevert(SeismicCurveHub.NotOwner.selector);
        hub.quote(curve, 1e6);
    }

    /// Anyone who may call an executable quote recovers the shielded reserve from two probes.
    function test_aQuoteGetterReconstructsTheShieldedReserve() public {
        deposit(ARC, ARC_PEER, keccak256("a"), 10_000e6, 6, ALICE);
        vm.startPrank(ALICE);
        hub.buy(curve, suint256(1_234e6), suint256(0), block.timestamp);
        hub.buy(curve, suint256(2_345e6), suint256(0), block.timestamp);
        vm.stopPrank();
        // out(q) = A q / (B + q), with A = Y0 - S and B = X0 + R. Two probes at q and 3q give
        // B = 3q (out2 - out1) / (3 out1 - out2).
        uint256 q = 1e15;
        uint256 out1 = hub.quote(curve, q);
        uint256 out2 = hub.quote(curve, 3 * q);
        uint256 recovered = (3 * q * (out2 - out1)) / (3 * out1 - out2) - 30_000e6;
        assertApproxEqAbs(recovered, 3_579e6, 1e6, "two quote probes reveal the shielded reserve to within one USDC");
    }
}
