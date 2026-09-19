// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./interfaces/IArchitexFactory.sol";
import "./interfaces/IArchitexRouter.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IFaucet {
    function faucet() external;
}

/// @title SeedPools
/// @notice Deployed by the Circle platform wallet; creates all five AMM pair contracts and
///         seeds the WETH/WBTC pool (no USDC needed — uses faucet() test tokens).
///         USDC pools must be seeded separately (see scripts/seed-usdc-pools.sh).
contract SeedPools {
    using SafeERC20 for IERC20;

    constructor(
        address factory,
        address router,
        address usdc,
        address weth,
        address wbtc,
        address arc,
        address eurc
    ) {
        IArchitexFactory f = IArchitexFactory(factory);
        IArchitexRouter  r = IArchitexRouter(router);

        // ── Create all five pairs ─────────────────────────────────────────────
        _createPairSafe(f, usdc, weth);
        _createPairSafe(f, usdc, wbtc);
        _createPairSafe(f, usdc, arc);
        _createPairSafe(f, usdc, eurc);
        _createPairSafe(f, weth, wbtc);

        // ── Seed WETH/WBTC pool using faucet() — no USDC needed ──────────────
        // faucet() mints FAUCET_UNITS * 10^decimals to msg.sender (this contract):
        //   WETH faucet: 10 * 10^18 = 10e18
        //   WBTC faucet: 1  * 10^8  = 1e8
        IFaucet(weth).faucet();
        IFaucet(wbtc).faucet();

        IERC20(weth).approve(router, type(uint256).max);
        IERC20(wbtc).approve(router, type(uint256).max);

        // Ratio: 24 WETH per WBTC (spec). Use 2.4 WETH / 0.1 WBTC to stay inside faucet amounts.
        uint256 wethAmt = 24e17;        // 2.4 WETH  (< 10 WETH faucet)
        uint256 wbtcAmt = 10_000_000;   // 0.1 WBTC  (< 1 WBTC faucet)
        r.addLiquidity(
            wbtc, weth,
            wbtcAmt, wethAmt,
            wbtcAmt * 99 / 100,
            wethAmt * 99 / 100,
            address(this),
            block.timestamp + 3600
        );
    }

    function _createPairSafe(IArchitexFactory f, address a, address b) private {
        try f.createPair(a, b) {} catch {}
    }
}
