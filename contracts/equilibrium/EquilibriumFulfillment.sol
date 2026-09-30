// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * PAYMENT FIXTURE. Not USDC, not a bridged representation of it, and not deployed anywhere public.
 *
 * The launch service settles its x402 quote with an EIP-3009 `transferWithAuthorization`, which is
 * what real USDC exposes. Arc testnet's USDC cannot be used on a fork rehearsal, because the payer
 * the rehearsal signs with holds none of it and minting it is not something a fork can be asked
 * for honestly. This contract implements the same authorization interface over a fixture balance so
 * the durable payment step exercises the real signature path and the real once-only nonce, while
 * the value being moved is explicitly fictional.
 *
 * The property the fulfillment layer depends on is here and is not a fixture: an authorization
 * nonce is consumed by the contract, so a second submission of the same signed authorization
 * reverts on chain no matter how many workers, restarts or retries reach it.
 */
contract EquilibriumPaymentFixture is ERC20, EIP712 {
    bytes32 private constant TRANSFER_WITH_AUTHORIZATION = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    /// Consumed authorizations, keyed exactly as EIP-3009 specifies: by payer and nonce.
    mapping(address => mapping(bytes32 => bool)) public authorizationState;

    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);

    error AuthorizationAlreadyUsed();
    error AuthorizationNotYetValid();
    error AuthorizationExpired();
    error InvalidAuthorizationSignature();

    /// `version` is the EIP-712 domain version the payment terms quote, so the two cannot drift.
    constructor(string memory name_, string memory version_, address recipient, uint256 supply)
        ERC20(name_, "USDCFIX")
        EIP712(name_, version_)
    {
        require(recipient != address(0) && supply > 0, "Invalid fixture supply");
        _mint(recipient, supply);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /**
     * Settles a signed authorization exactly once. Anyone may submit it — that is the point of the
     * scheme, and the reason the launch service can retry a settlement it is unsure about without
     * risking a second charge.
     */
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external {
        if (authorizationState[from][nonce]) revert AuthorizationAlreadyUsed();
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid();
        if (block.timestamp >= validBefore) revert AuthorizationExpired();
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(TRANSFER_WITH_AUTHORIZATION, from, to, value, validAfter, validBefore, nonce))
        );
        if (ECDSA.recover(digest, signature) != from) revert InvalidAuthorizationSignature();
        authorizationState[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }
}

/**
 * QUOTE INVENTORY FIXTURE. The quote asset a launch places alongside its tokens.
 *
 * Separate from the payment fixture because the two are separate figures in the launch record: the
 * payer's settled charge, and the quote inventory the launch deploys. Sharing one contract would
 * let a bug move one and report the other.
 */
contract EquilibriumQuoteFixture is ERC20 {
    constructor(address recipient, uint256 supply) ERC20("Equilibrium Quote Fixture", "QUOTEFIX") {
        require(recipient != address(0) && supply > 0, "Invalid fixture supply");
        _mint(recipient, supply);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}

/**
 * One atomic inventory placement per launch step.
 *
 * A step that places pool inventory and then delivers the rest of a chain allocation to its
 * recipient is two transfers, and two transfers are two chances to die in between. Split across
 * transactions there is no safe retry: whichever half is used as the marker, a crash on the other
 * side of it either loses a delivery or repeats one. In one call there is no in-between state, and
 * `placed` makes the retry a no-op rather than a second distribution.
 *
 * The figures are recorded so an observer reads back what was placed instead of inferring it from
 * balances that anything else could also have moved.
 */
contract EquilibriumDistributor {
    struct Placement {
        uint256 poolTokens;
        uint256 poolQuote;
        uint256 delivered;
        bool placed;
    }

    address public immutable operator;

    mapping(bytes32 => Placement) private placements;

    event InventoryPlaced(
        bytes32 indexed operation, address indexed holder, address indexed recipient,
        uint256 poolTokens, uint256 poolQuote, uint256 delivered
    );

    error OperatorOnly();
    error PlacementConflict();

    constructor(address operator_) {
        require(operator_ != address(0), "Invalid operator");
        operator = operator_;
    }

    function placementOf(bytes32 operation) external view returns (Placement memory) {
        return placements[operation];
    }

    /**
     * Pulls from the operator, so the launch spends only the supply and quote inventory it holds.
     * The operator approves this contract once per asset; the per-operation record is what stops a
     * second placement, not the approval.
     */
    function place(
        bytes32 operation,
        ERC20 token,
        ERC20 quote,
        address holder,
        address recipient,
        uint256 poolTokens,
        uint256 poolQuote,
        uint256 delivered
    ) external {
        if (msg.sender != operator) revert OperatorOnly();
        Placement memory existing = placements[operation];
        if (existing.placed) {
            if (existing.poolTokens != poolTokens || existing.poolQuote != poolQuote || existing.delivered != delivered) {
                revert PlacementConflict();
            }
            return;
        }
        placements[operation] = Placement(poolTokens, poolQuote, delivered, true);
        if (poolTokens > 0) require(token.transferFrom(operator, holder, poolTokens), "Token inventory transfer failed");
        if (poolQuote > 0) require(quote.transferFrom(operator, holder, poolQuote), "Quote inventory transfer failed");
        if (delivered > 0) require(token.transferFrom(operator, recipient, delivered), "Allocation delivery failed");
        emit InventoryPlaced(operation, holder, recipient, poolTokens, poolQuote, delivered);
    }
}

/**
 * The commit point for an Arc bridge leg a worker deploys across several transactions.
 *
 * Deploying a locking NTT manager and its Wormhole transceiver, wiring the two together and
 * registering the far peer cannot be done in one transaction, so a worker that dies midway leaves
 * contracts behind. Those contracts are inert: nothing refers to them, nothing has approved them
 * and they hold no custody. This registry is what makes them inert on purpose rather than by luck.
 *
 * A leg counts as existing only once it is registered against the operation that produced it. A
 * restart re-reads `legOf` and either finds the finished leg or treats the step as never having
 * happened. Registering a second, different leg for the same operation reverts, so two workers
 * racing the same step cannot leave the service with two managers that both believe they hold the
 * backing for one issuance.
 */
contract EquilibriumRouteRegistry {
    struct Leg {
        address token;
        address manager;
        address transceiver;
    }

    address public immutable operator;

    /// Keyed by the launch job's own step operation hash, which the worker persists before it acts.
    mapping(bytes32 => Leg) private legs;

    event LegRegistered(bytes32 indexed operation, address token, address manager, address transceiver);

    error OperatorOnly();
    error IncompleteLeg();
    error LegConflict();

    constructor(address operator_) {
        require(operator_ != address(0), "Invalid operator");
        operator = operator_;
    }

    function legOf(bytes32 operation) external view returns (Leg memory) {
        return legs[operation];
    }

    /**
     * Idempotent for an identical leg and refusing for any other, so the caller may retry without
     * having to know whether its previous attempt was recorded.
     */
    function registerLeg(bytes32 operation, address token, address manager, address transceiver) external {
        if (msg.sender != operator) revert OperatorOnly();
        if (token.code.length == 0 || manager.code.length == 0 || transceiver.code.length == 0) revert IncompleteLeg();
        Leg memory existing = legs[operation];
        if (existing.manager != address(0)) {
            if (existing.token != token || existing.manager != manager || existing.transceiver != transceiver) {
                revert LegConflict();
            }
            return;
        }
        legs[operation] = Leg(token, manager, transceiver);
        emit LegRegistered(operation, token, manager, transceiver);
    }
}
