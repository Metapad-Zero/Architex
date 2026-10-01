// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Origin, ICurveEndpoint} from "./SeismicCurveHub.sol";

interface ICurveReceiver {
    function lzReceive(Origin calldata origin, bytes32 guid, bytes calldata message, address executor, bytes calldata extraData) external;
}

/**
 * LOCAL TEST ENDPOINT. NOT LayerZero, NOT a DVN, NOT a bridge. It stands in for an EndpointV2 so the
 * hub's authentication, replay and retry logic can be exercised on sanvil: a single relayer key
 * delivers packets (the trust a real deployment would place in its DVN set and executor), and the
 * GUID is computed the way EndpointV2 computes it. It authenticates nothing on any source chain and
 * proves no public route. `available` simulates a destination that cannot be reached.
 */
contract LocalTestEndpoint is ICurveEndpoint {
    uint32 public immutable eid;
    address public immutable relayer;
    bool public available = true;
    mapping(uint32 => uint64) public outboundNonce;

    event PacketSent(uint32 indexed dstEid, bytes32 indexed receiver, bytes32 guid, uint64 nonce, bytes message);

    constructor(uint32 eid_, address relayer_) {
        eid = eid_;
        relayer = relayer_;
    }

    function setAvailable(bool value) external {
        require(msg.sender == relayer, "relayer");
        available = value;
    }

    function deliver(address receiver, Origin calldata origin, bytes32 guid, bytes calldata message) external {
        require(msg.sender == relayer, "relayer");
        ICurveReceiver(receiver).lzReceive(origin, guid, message, msg.sender, "");
    }

    function send(uint32 dstEid, bytes32 receiver, bytes calldata message) external returns (bytes32 guid) {
        require(available, "destination unavailable");
        uint64 nonce = ++outboundNonce[dstEid];
        guid = keccak256(abi.encodePacked(nonce, eid, bytes32(uint256(uint160(msg.sender))), dstEid, receiver));
        emit PacketSent(dstEid, receiver, guid, nonce, message);
    }
}
