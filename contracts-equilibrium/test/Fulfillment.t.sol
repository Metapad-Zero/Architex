// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import "forge-std/Test.sol";
import "../../contracts/equilibrium/EquilibriumFulfillment.sol";
import "../../contracts/equilibrium/EquilibriumToken.sol";

/**
 * The on-chain half of durable launch fulfilment: the three guarantees the worker is allowed to
 * depend on rather than enforce itself.
 *
 * A worker can crash between any two calls, and two workers can briefly believe they own the same
 * step. What keeps that from charging twice, issuing twice or distributing twice is not the worker's
 * bookkeeping — it is that these contracts refuse. Each test below is one of those refusals.
 */
contract FulfillmentTest is Test {
    bytes32 private constant TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    EquilibriumPaymentFixture private asset;
    uint256 private payerKey = 0xA11CE;
    address private payer;
    address private payTo = address(0x4020);

    function setUp() public {
        payer = vm.addr(payerKey);
        asset = new EquilibriumPaymentFixture("USDC-FIXTURE", "2", payer, 1_000_000e6);
        vm.warp(1_800_000_000);
    }

    function authorize(uint256 key, uint256 value, uint256 validBefore, bytes32 nonce)
        internal
        view
        returns (bytes memory)
    {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("USDC-FIXTURE"),
                keccak256("2"),
                block.chainid,
                address(asset)
            )
        );
        bytes32 structHash = keccak256(abi.encode(TYPEHASH, payer, payTo, value, uint256(0), validBefore, nonce));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }

    /* ------------------------------------------------ the settlement authorization */

    function test_authorizationSettlesExactlyOnceHoweverOftenItIsSubmitted() public {
        bytes32 nonce = keccak256("job");
        bytes memory signature = authorize(payerKey, 250e6, block.timestamp + 240, nonce);
        assertFalse(asset.authorizationState(payer, nonce));

        // Anyone may submit it. That is what lets a worker retry a settlement it is unsure about.
        vm.prank(address(0xBEEF));
        asset.transferWithAuthorization(payer, payTo, 250e6, 0, block.timestamp + 240, nonce, signature);
        assertEq(asset.balanceOf(payTo), 250e6);
        assertTrue(asset.authorizationState(payer, nonce));

        for (uint256 attempt = 0; attempt < 3; attempt++) {
            vm.expectRevert(EquilibriumPaymentFixture.AuthorizationAlreadyUsed.selector);
            asset.transferWithAuthorization(payer, payTo, 250e6, 0, block.timestamp + 240, nonce, signature);
        }
        assertEq(asset.balanceOf(payTo), 250e6);
    }

    function test_authorizationSignedByAnotherKeyMovesNothing() public {
        bytes32 nonce = keccak256("job");
        bytes memory forged = authorize(0xB0B, 250e6, block.timestamp + 240, nonce);
        vm.expectRevert(EquilibriumPaymentFixture.InvalidAuthorizationSignature.selector);
        asset.transferWithAuthorization(payer, payTo, 250e6, 0, block.timestamp + 240, nonce, forged);
        assertEq(asset.balanceOf(payTo), 0);
        assertFalse(asset.authorizationState(payer, nonce));
    }

    /// The signature covers the amount, so a submission for any other amount is a different message.
    function test_authorizationCannotBeSubmittedForADifferentAmount() public {
        bytes32 nonce = keccak256("job");
        bytes memory signature = authorize(payerKey, 250e6, block.timestamp + 240, nonce);
        vm.expectRevert(EquilibriumPaymentFixture.InvalidAuthorizationSignature.selector);
        asset.transferWithAuthorization(payer, payTo, 251e6, 0, block.timestamp + 240, nonce, signature);
        assertFalse(asset.authorizationState(payer, nonce));
    }

    function test_expiredAuthorizationIsRefusedAndLeavesTheNonceUnconsumed() public {
        bytes32 nonce = keccak256("job");
        uint256 validBefore = block.timestamp + 10;
        bytes memory signature = authorize(payerKey, 250e6, validBefore, nonce);
        vm.warp(validBefore);
        vm.expectRevert(EquilibriumPaymentFixture.AuthorizationExpired.selector);
        asset.transferWithAuthorization(payer, payTo, 250e6, 0, validBefore, nonce, signature);
        assertFalse(asset.authorizationState(payer, nonce));
        assertEq(asset.balanceOf(payTo), 0);
    }

    /* ------------------------------------------------ the bridge-leg commit point */

    function test_aLegCountsOnlyOnceItIsRegisteredAndConflictingRegistrationIsRefused() public {
        EquilibriumRouteRegistry registry = new EquilibriumRouteRegistry(address(this));
        bytes32 operation = keccak256("manager:arc");
        assertEq(registry.legOf(operation).manager, address(0));

        address token = address(new EquilibriumCanonical("Equilibrium", "EQL", address(this), 1_000e6));
        address manager = address(new EquilibriumRouteRegistry(address(this)));
        address transceiver = address(new EquilibriumRouteRegistry(address(this)));
        registry.registerLeg(operation, token, manager, transceiver);
        assertEq(registry.legOf(operation).manager, manager);

        // Idempotent for the identical leg: a worker unsure whether its call landed may repeat it.
        registry.registerLeg(operation, token, manager, transceiver);
        assertEq(registry.legOf(operation).transceiver, transceiver);

        // A second, different leg is refused, so two racing workers cannot leave two managers each
        // believing it holds the backing for one issuance.
        address other = address(new EquilibriumRouteRegistry(address(this)));
        vm.expectRevert(EquilibriumRouteRegistry.LegConflict.selector);
        registry.registerLeg(operation, token, other, transceiver);
        assertEq(registry.legOf(operation).manager, manager);
    }

    function test_onlyTheOperatorRegistersAndOnlyContractsCount() public {
        EquilibriumRouteRegistry registry = new EquilibriumRouteRegistry(address(this));
        address token = address(new EquilibriumCanonical("Equilibrium", "EQL", address(this), 1_000e6));
        vm.prank(address(0xBEEF));
        vm.expectRevert(EquilibriumRouteRegistry.OperatorOnly.selector);
        registry.registerLeg(keccak256("op"), token, address(this), address(this));

        // An address with no code is a half-built leg, not a manager.
        vm.expectRevert(EquilibriumRouteRegistry.IncompleteLeg.selector);
        registry.registerLeg(keccak256("op"), token, address(0xBEEF), address(this));
    }

    /* ------------------------------------------------ the atomic inventory placement */

    function test_inventoryAndDeliveryMoveTogetherExactlyOnce() public {
        EquilibriumDistributor distributor = new EquilibriumDistributor(address(this));
        EquilibriumCanonical token = new EquilibriumCanonical("Equilibrium", "EQL", address(this), 1_000e6);
        EquilibriumQuoteFixture quote = new EquilibriumQuoteFixture(address(this), 1_000e6);
        token.approve(address(distributor), type(uint256).max);
        quote.approve(address(distributor), type(uint256).max);

        bytes32 operation = keccak256("pool:arc");
        address holder = address(0x1111);
        address recipient = address(0x2222);
        distributor.place(operation, token, quote, holder, recipient, 100e6, 10e6, 400e6);
        assertEq(token.balanceOf(holder), 100e6);
        assertEq(quote.balanceOf(holder), 10e6);
        assertEq(token.balanceOf(recipient), 400e6);

        // Repeating it is a no-op, not a second distribution.
        for (uint256 attempt = 0; attempt < 3; attempt++) {
            distributor.place(operation, token, quote, holder, recipient, 100e6, 10e6, 400e6);
        }
        assertEq(token.balanceOf(holder), 100e6);
        assertEq(token.balanceOf(recipient), 400e6);
        assertEq(distributor.placementOf(operation).delivered, 400e6);
    }

    function test_aDifferentPlacementUnderTheSameOperationIsRefused() public {
        EquilibriumDistributor distributor = new EquilibriumDistributor(address(this));
        EquilibriumCanonical token = new EquilibriumCanonical("Equilibrium", "EQL", address(this), 1_000e6);
        EquilibriumQuoteFixture quote = new EquilibriumQuoteFixture(address(this), 1_000e6);
        token.approve(address(distributor), type(uint256).max);
        quote.approve(address(distributor), type(uint256).max);
        bytes32 operation = keccak256("pool:arc");
        distributor.place(operation, token, quote, address(0x1111), address(0x2222), 100e6, 10e6, 400e6);

        vm.expectRevert(EquilibriumDistributor.PlacementConflict.selector);
        distributor.place(operation, token, quote, address(0x1111), address(0x2222), 100e6, 10e6, 401e6);
        assertEq(token.balanceOf(address(0x2222)), 400e6);
    }

    function test_onlyTheOperatorPlacesInventory() public {
        EquilibriumDistributor distributor = new EquilibriumDistributor(address(this));
        EquilibriumCanonical token = new EquilibriumCanonical("Equilibrium", "EQL", address(this), 1_000e6);
        EquilibriumQuoteFixture quote = new EquilibriumQuoteFixture(address(this), 1_000e6);
        vm.prank(address(0xBEEF));
        vm.expectRevert(EquilibriumDistributor.OperatorOnly.selector);
        distributor.place(keccak256("op"), token, quote, address(0x1111), address(0x2222), 1, 1, 1);
    }
}
