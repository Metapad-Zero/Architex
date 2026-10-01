// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// The packet origin a LayerZero V2 endpoint hands to an OApp, reproduced so the local test endpoint
/// and a future real endpoint present the same shape.
struct Origin {
    uint32 srcEid;
    bytes32 sender;
    uint64 nonce;
}

/// Outbound side of whatever endpoint the hub is wired to. The local test endpoint implements it; a
/// LayerZero EndpointV2 would be reached through an OApp sender instead.
interface ICurveEndpoint {
    function send(uint32 dstEid, bytes32 receiver, bytes calldata message) external returns (bytes32 guid);
}

/**
 * LOCAL PROTOTYPE (49TH-44): a Seismic hub that sells a fixed curve allocation of one asset on one
 * deterministic curve, with reserves and sold supply in shielded storage.
 *
 * Money enters only as an authenticated deposit message from a registered peer: one credit per
 * message GUID and per (source domain, deposit id), to the recipient and asset the message names, in
 * six-decimal atoms after normalisation. There is no public mint and no caller-supplied amount that
 * can create a balance. A buyer spends their credited quote balance with an encrypted (type 0x4A)
 * call; the amount, minimum output and resulting holdings stay in shielded storage. Tokens leave as a
 * public outbound message whose record survives an unavailable destination and is retried at most
 * once to success.
 *
 * Curve: virtual constant product. With public virtual reserves X0 (quote) and Y0 (token), shielded
 * collected quote R and shielded sold supply S, a buy of q quote returns
 *     out = floor((Y0 - S) * q / (X0 + R + q))
 * Rounding is floor, against the buyer; the dust stays in the curve. Multiplication and division
 * cost constant gas, so the arithmetic itself does not leak q through gas. Graduation fires once,
 * keyed by the curve id (the hash of asset, quote asset and parameters, never a source domain id),
 * when R reaches the public threshold, and closes the curve to further buys.
 *
 * Supply model: the hub holds a FIXED allocation of an existing fixed-issuance asset (the curve's
 * inventory) and never mints. A mintable-issuance curve would need a minter role on the canonical
 * token and would change the conservation identity; that is a separate, explicit decision.
 */
contract SeismicCurveHub {
    struct Curve {
        bytes32 asset;
        bytes32 quoteAsset;
        uint256 virtualQuote;
        uint256 virtualToken;
        uint256 allocation;
        uint256 graduationQuote;
        bool exists;
        bool graduated;
    }

    struct Outbound {
        bytes32 curveId;
        address owner;
        uint32 dstEid;
        bytes32 to;
        uint256 amount;
        bool sent;
        bytes32 guid;
    }

    uint8 public constant DEPOSIT = 1;
    uint8 public constant WITHDRAWAL = 2;
    uint8 public constant ATOM_DECIMALS = 6;

    address public immutable owner;
    ICurveEndpoint public immutable endpoint;
    uint32 public immutable localEid;

    mapping(uint32 => bytes32) public peers;
    mapping(bytes32 => bool) public consumedGuid;
    mapping(bytes32 => bool) public consumedDeposit;
    mapping(bytes32 => Curve) public curves;

    /// Quote credited by authenticated deposits, per quote asset. Public: every deposit is public on its spoke anyway.
    mapping(bytes32 => uint256) public totalCredited;
    /// Tokens that left the hub in outbound messages, per curve. Public: the egress amount is public on the destination.
    mapping(bytes32 => uint256) public totalWithdrawn;
    /// Tokens debited into outbound records that have not been sent yet, per curve.
    mapping(bytes32 => uint256) public pendingOutbound;

    mapping(bytes32 => suint256) private reserve;
    mapping(bytes32 => suint256) private sold;
    mapping(bytes32 => suint256) private quoteHeld;
    mapping(bytes32 => suint256) private tokensHeld;
    mapping(address => mapping(bytes32 => suint256)) private quoteBalance;
    mapping(address => mapping(bytes32 => suint256)) private tokenBalance;

    mapping(bytes32 => Outbound) public outbound;
    uint64 public outboundNonce;

    event PeerSet(uint32 indexed eid, bytes32 peer);
    event CurveOpened(bytes32 indexed curveId, bytes32 indexed asset, bytes32 indexed quoteAsset);
    event Credited(bytes32 indexed guid, uint32 indexed srcEid, bytes32 depositId, address indexed recipient);
    event Bought(bytes32 indexed curveId, address indexed buyer);
    event Graduated(bytes32 indexed curveId);
    event WithdrawalQueued(bytes32 indexed id, bytes32 indexed curveId, uint32 dstEid, bytes32 to, uint256 amount);
    event WithdrawalSent(bytes32 indexed id, bytes32 guid);

    error NotOwner();
    error NotEndpoint();
    error UnknownPeer();
    error GuidMismatch();
    error Replayed();
    error BadMessage();
    error UnknownCurve();
    error CurveClosed();
    error Expired();
    error Insufficient();
    error Slippage();
    error SoldOut();
    error AlreadySent();

    constructor(ICurveEndpoint endpoint_, uint32 localEid_) {
        owner = msg.sender;
        endpoint = endpoint_;
        localEid = localEid_;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function setPeer(uint32 eid, bytes32 peer) external onlyOwner {
        peers[eid] = peer;
        emit PeerSet(eid, peer);
    }

    function curveIdOf(bytes32 asset, bytes32 quoteAsset, uint256 virtualQuote, uint256 virtualToken, uint256 allocation, uint256 graduationQuote)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(asset, quoteAsset, virtualQuote, virtualToken, allocation, graduationQuote));
    }

    function openCurve(bytes32 asset, bytes32 quoteAsset, uint256 virtualQuote, uint256 virtualToken, uint256 allocation, uint256 graduationQuote)
        external
        onlyOwner
        returns (bytes32 curveId)
    {
        if (virtualQuote == 0 || allocation == 0 || allocation > virtualToken || graduationQuote == 0) revert BadMessage();
        curveId = curveIdOf(asset, quoteAsset, virtualQuote, virtualToken, allocation, graduationQuote);
        if (curves[curveId].exists) revert Replayed();
        curves[curveId] = Curve(asset, quoteAsset, virtualQuote, virtualToken, allocation, graduationQuote, true, false);
        emit CurveOpened(curveId, asset, quoteAsset);
    }

    /// The GUID a LayerZero V2 endpoint assigns: keccak256(nonce, srcEid, sender, dstEid, receiver).
    function guidOf(Origin calldata origin) public view returns (bytes32) {
        return keccak256(abi.encodePacked(origin.nonce, origin.srcEid, origin.sender, localEid, bytes32(uint256(uint160(address(this))))));
    }

    /**
     * An authenticated deposit: only the endpoint may deliver, only from the registered peer for the
     * source domain, once per GUID and once per source deposit id. The message names the asset, the
     * amount with its source decimals, and the recipient; nothing else can credit a balance.
     */
    function lzReceive(Origin calldata origin, bytes32 guid, bytes calldata message, address, bytes calldata) external {
        if (msg.sender != address(endpoint)) revert NotEndpoint();
        bytes32 peer = peers[origin.srcEid];
        if (peer == bytes32(0) || peer != origin.sender) revert UnknownPeer();
        if (guid != guidOf(origin)) revert GuidMismatch();
        if (consumedGuid[guid]) revert Replayed();
        consumedGuid[guid] = true;
        _credit(origin.srcEid, guid, abi.decode(message, (Deposit)));
    }

    struct Deposit {
        uint8 kind;
        bytes32 depositId;
        bytes32 quoteAsset;
        uint256 amount;
        uint8 decimals;
        address recipient;
    }

    function _credit(uint32 srcEid, bytes32 guid, Deposit memory d) internal {
        if (d.kind != DEPOSIT || d.recipient == address(0) || d.amount == 0) revert BadMessage();
        bytes32 depositKey = keccak256(abi.encode(srcEid, d.depositId));
        if (consumedDeposit[depositKey]) revert Replayed();
        consumedDeposit[depositKey] = true;
        uint256 atoms = normalize(d.amount, d.decimals);
        totalCredited[d.quoteAsset] += atoms;
        // The amount is public in the message already; shielding it here hides only later spending.
        quoteBalance[d.recipient][d.quoteAsset] += suint256(atoms);
        quoteHeld[d.quoteAsset] += suint256(atoms);
        emit Credited(guid, srcEid, d.depositId, d.recipient);
    }

    /// Six-decimal atoms. A source amount with dust below one atom is refused rather than rounded away.
    function normalize(uint256 amount, uint8 decimals) public pure returns (uint256) {
        if (decimals == ATOM_DECIMALS) return amount;
        if (decimals < ATOM_DECIMALS) return amount * 10 ** (ATOM_DECIMALS - decimals);
        uint256 scale = 10 ** (decimals - ATOM_DECIMALS);
        if (amount % scale != 0) revert BadMessage();
        return amount / scale;
    }

    /**
     * Spend part of a credited quote balance on the curve. Call with a Seismic (0x4A) transaction:
     * quoteIn and minOut are shielded parameters and are only private if the calldata is encrypted.
     * A revert discloses which check failed; that bit is inherent to any on-chain slippage check.
     */
    function buy(bytes32 curveId, suint256 quoteIn, suint256 minOut, uint256 deadline) external {
        if (block.timestamp > deadline) revert Expired();
        Curve storage c = curves[curveId];
        if (!c.exists) revert UnknownCurve();
        if (c.graduated) revert CurveClosed();
        suint256 balance = quoteBalance[msg.sender][c.quoteAsset];
        if (!bool(quoteIn > suint256(0) && quoteIn <= balance)) revert Insufficient();
        suint256 tokenSide = suint256(c.virtualToken) - sold[curveId];
        suint256 out = (tokenSide * quoteIn) / (suint256(c.virtualQuote) + reserve[curveId] + quoteIn);
        if (!bool(out >= minOut && out > suint256(0))) revert Slippage();
        if (!bool(sold[curveId] + out <= suint256(c.allocation))) revert SoldOut();
        quoteBalance[msg.sender][c.quoteAsset] = balance - quoteIn;
        quoteHeld[c.quoteAsset] -= quoteIn;
        reserve[curveId] += quoteIn;
        sold[curveId] += out;
        tokensHeld[curveId] += out;
        tokenBalance[msg.sender][curveId] += out;
        emit Bought(curveId, msg.sender);
        if (bool(reserve[curveId] >= suint256(c.graduationQuote))) {
            c.graduated = true;
            emit Graduated(curveId);
        }
    }

    /**
     * Move tokens out to a destination domain. The amount is public: the destination must mint or
     * release it in public. The record is written before sending, so an unavailable destination leaves
     * it pending with the tokens debited and accounted, and `retry` sends the same payload once.
     */
    function withdraw(bytes32 curveId, uint256 amount, uint32 dstEid, bytes32 to) external returns (bytes32 id) {
        if (!curves[curveId].exists) revert UnknownCurve();
        if (peers[dstEid] == bytes32(0)) revert UnknownPeer();
        if (amount == 0 || to == bytes32(0)) revert BadMessage();
        suint256 shieldedAmount = suint256(amount);
        if (!bool(shieldedAmount <= tokenBalance[msg.sender][curveId])) revert Insufficient();
        tokenBalance[msg.sender][curveId] -= shieldedAmount;
        tokensHeld[curveId] -= shieldedAmount;
        pendingOutbound[curveId] += amount;
        id = keccak256(abi.encode(address(this), ++outboundNonce));
        outbound[id] = Outbound(curveId, msg.sender, dstEid, to, amount, false, bytes32(0));
        emit WithdrawalQueued(id, curveId, dstEid, to, amount);
        _trySend(id);
    }

    function retry(bytes32 id) external {
        Outbound storage o = outbound[id];
        if (o.owner == address(0)) revert BadMessage();
        if (o.sent) revert AlreadySent();
        if (!_trySend(id)) revert Insufficient();
    }

    function _trySend(bytes32 id) internal returns (bool) {
        Outbound storage o = outbound[id];
        bytes memory payload = abi.encode(WITHDRAWAL, id, curves[o.curveId].asset, o.amount, ATOM_DECIMALS, o.to);
        try endpoint.send(o.dstEid, peers[o.dstEid], payload) returns (bytes32 guid) {
            o.sent = true;
            o.guid = guid;
            pendingOutbound[o.curveId] -= o.amount;
            totalWithdrawn[o.curveId] += o.amount;
            emit WithdrawalSent(id, guid);
            return true;
        } catch {
            return false;
        }
    }

    /// The caller's own balances. Use a signed read; an unsigned eth_call has msg.sender zero.
    function myQuoteBalance(bytes32 quoteAsset) external view returns (uint256) {
        return uint256(quoteBalance[msg.sender][quoteAsset]);
    }

    function myTokenBalance(bytes32 curveId) external view returns (uint256) {
        return uint256(tokenBalance[msg.sender][curveId]);
    }

    /// Operator-only executable quote. Anyone allowed to call this can reconstruct the reserve exactly.
    function quote(bytes32 curveId, uint256 quoteIn) external view onlyOwner returns (uint256) {
        Curve storage c = curves[curveId];
        return uint256((suint256(c.virtualToken) - sold[curveId]) * suint256(quoteIn) / (suint256(c.virtualQuote) + reserve[curveId] + suint256(quoteIn)));
    }

    /**
     * One public bit per curve: sold supply equals tokens held on the hub plus tokens pending and sent
     * out, sold supply is within the allocation, and every credited quote atom is either still held
     * by a depositor or in some curve's reserve (single-curve quote assets in this prototype).
     */
    function conserved(bytes32 curveId) external view returns (bool) {
        Curve storage c = curves[curveId];
        sbool tokens = sold[curveId] == tokensHeld[curveId] + suint256(pendingOutbound[curveId] + totalWithdrawn[curveId]);
        sbool cap = sold[curveId] <= suint256(c.allocation);
        sbool quotes = suint256(totalCredited[c.quoteAsset]) == quoteHeld[c.quoteAsset] + reserve[curveId];
        return bool(tokens && cap && quotes);
    }
}
