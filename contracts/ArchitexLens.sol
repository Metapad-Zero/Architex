// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./interfaces/IArchitexLens.sol";
import "./interfaces/IArchitexFactory.sol";
import "./interfaces/IArchitexPair.sol";

/// @title Architex Lens
/// @notice Read-only batch views for the frontend. One eth_call loads a full screen.
///         Never reverts on unknown or non-ERC20 tokens; metadata falls back to ("","",18).
contract ArchitexLens is IArchitexLens {
    /// @inheritdoc IArchitexLens
    address public immutable factory;
    /// @inheritdoc IArchitexLens
    address public immutable router;

    constructor(address _factory, address _router) {
        factory = _factory;
        router  = _router;
    }

    // ─── Pair views ───────────────────────────────────────────────────────────

    /// @inheritdoc IArchitexLens
    function pairsLength() external view returns (uint256) {
        return IArchitexFactory(factory).allPairsLength();
    }

    /// @inheritdoc IArchitexLens
    function pairs(uint256 start, uint256 count) external view returns (PairInfo[] memory result) {
        uint256 total = IArchitexFactory(factory).allPairsLength();
        if (start >= total) return new PairInfo[](0);
        uint256 end = start + count;
        if (end > total) end = total;
        uint256 len = end - start;
        result = new PairInfo[](len);
        for (uint256 i; i < len; ++i) {
            address pair = IArchitexFactory(factory).allPairs(start + i);
            result[i] = _pairInfo(pair);
        }
    }

    /// @inheritdoc IArchitexLens
    function pairsByAddress(address[] calldata pairAddrs) external view returns (PairInfo[] memory result) {
        result = new PairInfo[](pairAddrs.length);
        for (uint256 i; i < pairAddrs.length; ++i) {
            result[i] = _pairInfo(pairAddrs[i]);
        }
    }

    function _pairInfo(address pair) internal view returns (PairInfo memory info) {
        IArchitexPair p = IArchitexPair(pair);
        (uint112 r0, uint112 r1, uint32 ts) = p.getReserves();
        info = PairInfo({
            pair: pair,
            token0: p.token0(),
            token1: p.token1(),
            reserve0: r0,
            reserve1: r1,
            blockTimestampLast: ts,
            totalSupply: p.totalSupply()
        });
    }

    // ─── Token meta ───────────────────────────────────────────────────────────

    /// @inheritdoc IArchitexLens
    /// @dev try/catch so a non-ERC20 address returns ("", "", 18) instead of reverting.
    function tokenMeta(address[] calldata tokens) external view returns (TokenMeta[] memory result) {
        result = new TokenMeta[](tokens.length);
        for (uint256 i; i < tokens.length; ++i) {
            address t = tokens[i];
            string memory sym;
            string memory nm;
            uint8 dec = 18;

            try ITokenMeta(t).symbol() returns (string memory s) { sym = s; } catch {}
            try ITokenMeta(t).name()   returns (string memory n) { nm  = n; } catch {}
            try ITokenMeta(t).decimals() returns (uint8 d)       { dec = d; } catch {}

            result[i] = TokenMeta({ token: t, symbol: sym, name: nm, decimals: dec });
        }
    }

    // ─── Balances & allowances ────────────────────────────────────────────────

    /// @inheritdoc IArchitexLens
    function balances(address owner, address[] calldata tokens) external view returns (uint256[] memory result) {
        result = new uint256[](tokens.length);
        for (uint256 i; i < tokens.length; ++i) {
            result[i] = IERC20(tokens[i]).balanceOf(owner);
        }
    }

    /// @inheritdoc IArchitexLens
    function allowances(address owner, address spender, address[] calldata tokens)
        external
        view
        returns (uint256[] memory result)
    {
        result = new uint256[](tokens.length);
        for (uint256 i; i < tokens.length; ++i) {
            result[i] = IERC20(tokens[i]).allowance(owner, spender);
        }
    }

    // ─── Positions ────────────────────────────────────────────────────────────

    /// @inheritdoc IArchitexLens
    function positions(address owner, uint256 start, uint256 count)
        external
        view
        returns (Position[] memory result)
    {
        uint256 total = IArchitexFactory(factory).allPairsLength();
        if (start >= total) return new Position[](0);
        uint256 end = start + count;
        if (end > total) end = total;

        // Two-pass: first count, then fill (avoids dynamic array push).
        uint256 found;
        for (uint256 i = start; i < end; ++i) {
            address pair = IArchitexFactory(factory).allPairs(i);
            if (IArchitexPair(pair).balanceOf(owner) > 0) ++found;
        }

        result = new Position[](found);
        uint256 idx;
        for (uint256 i = start; i < end; ++i) {
            address pair = IArchitexFactory(factory).allPairs(i);
            uint256 lpBal = IArchitexPair(pair).balanceOf(owner);
            if (lpBal == 0) continue;
            IArchitexPair p = IArchitexPair(pair);
            (uint112 r0, uint112 r1,) = p.getReserves();
            result[idx++] = Position({
                pair: pair,
                token0: p.token0(),
                token1: p.token1(),
                lpBalance: lpBal,
                lpTotalSupply: p.totalSupply(),
                reserve0: r0,
                reserve1: r1,
                routerAllowance: IERC20(pair).allowance(owner, router)
            });
        }
    }
}

// ─── Minimal interface for metadata ──────────────────────────────────────────
interface ITokenMeta {
    function symbol()   external view returns (string memory);
    function name()     external view returns (string memory);
    function decimals() external view returns (uint8);
}
