// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import {NttManager} from "ntt/NttManager/NttManager.sol";
import {IManagerBase} from "ntt/interfaces/IManagerBase.sol";
import {TransceiverStructs} from "ntt/libraries/TransceiverStructs.sol";
import {WormholeTransceiver} from "ntt/Transceiver/WormholeTransceiver/WormholeTransceiver.sol";
import {ERC1967Proxy} from "openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IWormhole} from "wormhole-solidity-sdk/interfaces/IWormhole.sol";
import {WormholeSimulator} from "wormhole-solidity-sdk/testing/helpers/WormholeSimulator.sol";
import {toWormholeFormat} from "wormhole-solidity-sdk/Utils.sol";
import "../../contracts/equilibrium/EquilibriumToken.sol";
import "../../contracts/ArchitexFactory.sol";
import "../../contracts/ArchitexPair.sol";

/// FORK REHEARSAL: actual pinned NTT managers/transceivers and Sepolia Wormhole Core bytecode,
/// locally overridden one-key Guardian set and modeled source chain IDs. No public route proof.
contract NttRehearsalTest is Test {
    uint16 constant ARC = 71;
    uint16 constant BASE_SEPOLIA = 10004;
    uint256 constant ARC_EVM = 5042002;
    uint256 constant BASE_EVM = 84532;
    uint256 constant GUARDIAN = 0x12345;
    uint256 constant UNIT = 1e6;
    IWormhole constant CORE = IWormhole(0x4a8bc80Ed5a4067f1CCf107057b8270E0cC11A78);
    EquilibriumCanonical hub;
    EquilibriumSpoke spoke;
    NttManager hubManager;
    NttManager spokeManager;
    WormholeTransceiver hubTransceiver;
    WormholeTransceiver spokeTransceiver;
    WormholeSimulator guardian;

    function setUp() public {
        vm.createSelectFork(vm.envOr("NTT_FORK_RPC", string("https://ethereum-sepolia-rpc.publicnode.com")));
        guardian = new WormholeSimulator(address(CORE), GUARDIAN);
        vm.chainId(ARC_EVM);
        hub = new EquilibriumCanonical("Equilibrium", "EQL", address(this), 1_000_000e6);
        hubManager = manager(address(hub), IManagerBase.Mode.LOCKING, ARC);
        hubTransceiver = transceiver(hubManager);
        vm.chainId(BASE_EVM);
        spoke = new EquilibriumSpoke("Equilibrium", "EQL", address(this), 1_000_000e6);
        spokeManager = manager(address(spoke), IManagerBase.Mode.BURNING, BASE_SEPOLIA);
        spoke.setMinter(address(spokeManager));
        spokeTransceiver = transceiver(spokeManager);
        hubManager.setPeer(BASE_SEPOLIA, toWormholeFormat(address(spokeManager)), 6, 1_000_000e6);
        spokeManager.setPeer(ARC, toWormholeFormat(address(hubManager)), 6, 1_000_000e6);
        hubTransceiver.setWormholePeer(BASE_SEPOLIA, toWormholeFormat(address(spokeTransceiver)));
        spokeTransceiver.setWormholePeer(ARC, toWormholeFormat(address(hubTransceiver)));
    }
    function manager(address token, IManagerBase.Mode mode, uint16 chain) internal returns (NttManager result) {
        NttManager impl = new NttManager(token, mode, chain, 1 days, false);
        result = NttManager(address(new ERC1967Proxy(address(impl), "")));
        result.initialize();
        result.setOutboundLimit(1_000_000e6);
    }
    function transceiver(NttManager ntt) internal returns (WormholeTransceiver result) {
        WormholeTransceiver impl = new WormholeTransceiver(address(ntt), address(CORE), 0, 0, 0, address(0));
        result = WormholeTransceiver(address(new ERC1967Proxy(address(impl), "")));
        result.initialize();
        ntt.setTransceiver(address(result)); ntt.setThreshold(1);
    }
    function send(bool outbound, uint256 amount) internal returns (bytes memory vaa) {
        vm.chainId(outbound ? ARC_EVM : BASE_EVM);
        NttManager source = outbound ? hubManager : spokeManager;
        IERC20 token = IERC20(source.token());
        token.approve(address(source), amount);
        vm.recordLogs();
        source.transfer(amount, outbound ? BASE_SEPOLIA : ARC, toWormholeFormat(address(this)));
        Vm.Log[] memory logs = guardian.fetchWormholeMessageFromLog(vm.getRecordedLogs());
        assertEq(logs.length, 1);
        vaa = guardian.fetchSignedMessageFromLogs(logs[0], outbound ? ARC : BASE_SEPOLIA);
    }
    function receiveVaa(bool outbound, bytes memory vaa) internal {
        vm.chainId(outbound ? BASE_EVM : ARC_EVM);
        (outbound ? spokeTransceiver : hubTransceiver).receiveMessage(vaa);
    }
    function assertSupply(uint256 pending) internal view {
        uint256 custody = hub.balanceOf(address(hubManager));
        assertEq(hub.totalSupply() - custody + spoke.totalSupply() + pending, 1_000_000e6);
        assertEq(custody, spoke.totalSupply() + pending);
    }
    function test_fractionalRoundTripAndReplay() public {
        uint256 amount = 80e6 + 123456;
        bytes memory vaa = send(true, amount);
        assertSupply(amount); assertEq(spoke.totalSupply(), 0);
        vm.warp(block.timestamp + 20);
        receiveVaa(true, vaa); assertSupply(0); assertEq(spoke.balanceOf(address(this)), amount);
        vm.expectRevert(); spokeTransceiver.receiveMessage(vaa);
        assertSupply(0);
        bytes memory returned = send(false, amount); assertSupply(amount);
        receiveVaa(false, returned); assertSupply(0);
        assertEq(spoke.totalSupply(), 0); assertEq(hub.balanceOf(address(this)), 1_000_000e6);
    }
    function test_rejectTamperedSignatureAndUnauthorizedCredit() public {
        bytes memory vaa = send(true, 10e6);
        vaa[10] = bytes1(uint8(vaa[10]) ^ 1);
        vm.chainId(BASE_EVM); vm.expectRevert(); spokeTransceiver.receiveMessage(vaa);
        TransceiverStructs.NttManagerMessage memory message;
        vm.expectRevert(); spokeManager.attestationReceived(ARC, toWormholeFormat(address(hubManager)), message);
        assertEq(spoke.totalSupply(), 0); assertSupply(10e6);
    }
    function test_wrongPeerEvenWithAuthenticatedGuardian() public {
        bytes memory vaa = send(true, 10e6);
        IWormhole.VM memory decoded = CORE.parseVM(vaa);
        decoded.emitterAddress = bytes32(uint256(0xBAD));
        bytes memory forgedPeer = guardian.encodeAndSignMessage(decoded);
        vm.chainId(BASE_EVM); vm.expectRevert(); spokeTransceiver.receiveMessage(forgedPeer);
        assertSupply(10e6);
    }
    function test_pauseDestinationRetainsClaimThenRecovers() public {
        bytes memory vaa = send(true, 10e6);
        spokeManager.pause();
        vm.chainId(BASE_EVM); vm.expectRevert(); spokeTransceiver.receiveMessage(vaa);
        assertSupply(10e6);
        spokeManager.unpause(); receiveVaa(true, vaa); assertSupply(0);
    }
    function test_outboundRateLimitRevertsDebitAtomically() public {
        hubManager.setOutboundLimit(10e6);
        vm.chainId(ARC_EVM); hub.approve(address(hubManager), 20e6);
        vm.expectRevert(); hubManager.transfer(20e6, BASE_SEPOLIA, toWormholeFormat(address(this)));
        assertSupply(0); assertEq(hub.balanceOf(address(this)), 1_000_000e6);
    }
    function test_delayedInboundQueueAndRestartEquivalentResubmission() public {
        spokeManager.setInboundLimit(1e6, ARC);
        bytes memory vaa = send(true, 20e6);
        IWormhole.VM memory decoded = CORE.parseVM(vaa);
        (, TransceiverStructs.NttManagerMessage memory message) = TransceiverStructs.parseTransceiverAndNttManagerMessage(0x9945FF10, decoded.payload);
        bytes32 digest = TransceiverStructs.nttManagerMessageDigest(ARC, message);
        receiveVaa(true, vaa); assertSupply(20e6);
        vm.expectRevert(); spokeManager.completeInboundQueuedTransfer(digest);
        // Durable destination queue survives the client dropping its receipt and restarting.
        vm.warp(block.timestamp + 1 days + 1);
        spokeManager.completeInboundQueuedTransfer(digest); assertSupply(0);
        vm.expectRevert(); spokeManager.completeInboundQueuedTransfer(digest);
        assertEq(spoke.totalSupply(), 20e6);
    }
    function test_sharedTokenAcceptedByActualArchitexPools() public {
        bytes memory vaa = send(true, 1000e6); receiveVaa(true, vaa);
        EquilibriumCanonical quote = new EquilibriumCanonical("Rehearsal quote", "Q", address(this), 100_000e6);
        ArchitexFactory factory = new ArchitexFactory(address(this));
        address hubPool = factory.createPair(address(hub), address(quote));
        address spokePool = factory.createPair(address(spoke), address(quote));
        hub.transfer(hubPool, 500e6); quote.transfer(hubPool, 500e6); ArchitexPair(hubPool).mint(address(this));
        spoke.transfer(spokePool, 500e6); quote.transfer(spokePool, 500e6); ArchitexPair(spokePool).mint(address(this));
        assertEq(factory.getPair(address(hub), address(quote)), hubPool);
        assertGt(ArchitexPair(spokePool).balanceOf(address(this)), 0);
        // A real pair swap uses the existing representation; it does not issue another token.
        quote.transfer(spokePool, 10e6);
        uint256 input = 10e6;
        uint256 output = input * 997 * 500e6 / (500e6 * 1000 + input * 997);
        bool tokenFirst = ArchitexPair(spokePool).token0() == address(spoke);
        ArchitexPair(spokePool).swap(tokenFirst ? output : 0, tokenFirst ? 0 : output, address(this), "");
        assertSupply(0); assertEq(spoke.totalSupply(), 1000e6);
        vm.expectRevert(); factory.createPair(address(spoke), address(quote));
    }
}
