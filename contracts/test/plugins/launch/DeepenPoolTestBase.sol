// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {LaunchPair} from "../../../launchpad/LaunchPair.sol";
import {DeepenPoolPlugin} from "../../../plugins/launch/DeepenPoolPlugin.sol";
import {MockLaunchToken} from "./LaunchPluginMocks.sol";
import {DeepenMockRouter} from "./DeepenPoolMocks.sol";
import {LaunchPluginTestBase} from "./LaunchPluginTestBase.sol";

/// @notice Shared setup for Deepen pool's unit tests: the mock launchpad (curve buys at 1e14 token units per USDC unit,
///         a 1% creator fee), a mock launch router with the real router's arithmetic, and REAL LaunchPairs routed by it.
///         Reference math here is written independently of the plugin: the split from the textbook quadratic formula,
///         the dust rule from the spec, and the two sides of a pool run simulated step by step.
abstract contract DeepenPoolTestBase is LaunchPluginTestBase {
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 internal constant POOL_TOKENS = 200_000_000e18;
    uint256 internal constant POOL_USDC = 25_000e6;
    uint256 internal constant FEE_BPS_TOTAL = 150; // the mock launchpad's 0.5% platform fee + 1% creator fee
    uint256 internal constant TOKENS_PER_UNIT = 1e14; // the mock curve's price
    uint256 internal constant MIN_RUN = 3;

    DeepenPoolPlugin internal deepen;
    DeepenMockRouter internal poolRouter;

    function setUp() public virtual override {
        super.setUp();
        poolRouter = new DeepenMockRouter(launchpad);
        launchpad.setRouter(address(poolRouter));
        deepen = new DeepenPoolPlugin(address(launchpad));
    }

    /// @dev A token whose plugin is Deepen pool with the default burn share (empty configuration data), with a real
    ///      (still empty) LaunchPair routed by the mock router.
    function _launchDeepen() internal returns (MockLaunchToken token, LaunchPair pair) {
        return _launchDeepen("");
    }

    /// @dev The same with an explicit burn share.
    function _launchDeepen(uint16 burnBps) internal returns (MockLaunchToken token, LaunchPair pair) {
        return _launchDeepen(abi.encode(burnBps));
    }

    function _launchDeepen(bytes memory data) internal returns (MockLaunchToken token, LaunchPair pair) {
        token = _newToken();
        pair = new LaunchPair(address(token), address(usdc), address(poolRouter));
        token.setPair(address(pair));
        launchpad.launch(address(token), creator, address(deepen), address(pair), data);
    }

    /// @dev Graduation as the launchpad does it: tokens and USDC straight into the pair, LP minted to 0x…dEaD.
    function _graduate(MockLaunchToken token, LaunchPair pair, uint256 tokens, uint256 usdcSeed) internal {
        token.mint(address(pair), tokens);
        usdc.mint(address(pair), usdcSeed);
        pair.mint(DEAD);
        launchpad.setGraduated(address(token), true);
    }

    function _reservesOf(LaunchPair pair) internal view returns (uint256 reserveToken, uint256 reserveUsdc) {
        (uint112 rt, uint112 ru,) = pair.getReserves();
        return (rt, ru);
    }

    function _runAs(address caller, address token) internal returns (uint256 spent, uint256 burned, uint256 liquidity) {
        vm.prank(caller);
        return deepen.run(token);
    }

    function _offeredFor(address token) internal view returns (uint256 offered) {
        (offered,,,) = deepen.previewRun(token);
    }

    // ─── Reference math (independent of the plugin) ───────────────────────────

    /// @dev The documented dust rule: `burnBps` of the offer burns, the rest deepens, and a side under MIN_RUN_USDC
    ///      gives way to the other (the burn side first).
    function _sidesRef(uint256 offer, uint256 burnBps) internal pure returns (uint256 toBurn, uint256 toDeepen) {
        toBurn = offer * burnBps / 10_000;
        toDeepen = offer - toBurn;
        if (toBurn < MIN_RUN) (toBurn, toDeepen) = (0, offer);
        else if (toDeepen < MIN_RUN) (toBurn, toDeepen) = (offer, 0);
    }

    /// @dev The textbook root (-B + sqrt(B^2 + 4AC)) / 2A of A b^2 + B b - C = 0 with A = q^2, B = 1e4 (1e4 + q) R,
    ///      C = 1e8 U R: the buy b for which b + n + n^2/R = U, n = b q / 1e4. Not clamped.
    function _refRoot(uint256 offer, uint256 reserveUsdc, uint256 feeBps) internal pure returns (uint256) {
        uint256 q = 10_000 - feeBps;
        uint256 a = q * q;
        uint256 b = 10_000 * (10_000 + q) * reserveUsdc;
        uint256 c = 1e8 * offer * reserveUsdc;
        return (Math.sqrt(b * b + 4 * a * c) - b) / (2 * a);
    }

    /// @dev The launch router's exact-in buy at given reserves (both fees rounded up on the USDC in).
    function _quoteAt(uint256 rt, uint256 ru, uint256 usdcIn) internal pure returns (uint256 out, uint256 net) {
        (uint256 platformFee, uint256 creatorFee) = _fees(usdcIn);
        net = usdcIn - platformFee - creatorFee;
        out = net * rt / (ru + net);
    }

    struct Sim {
        uint256 usdcToBurn;
        uint256 usdcToBuy;
        uint256 tokensBought; // both sides
        uint256 tokensAdded;
        uint256 usdcAdded;
        uint256 liquidity;
        uint256 burned;
        uint256 spent;
        uint256 leftover;
        uint256 reserveToken; // the pool after the run
        uint256 reserveUsdc;
    }

    /// @dev What a pool run does, step by step, from the pool's state and the split the plugin previews: the burn
    ///      side's buy, then the deepen side's buy at the reserves that leaves, then the Uniswap V2 router's optimal
    ///      amounts and the LaunchPair mint formula. `extraTokens` is anything sent to the plugin beforehand.
    function _simulate(LaunchPair pair, uint256 offer, uint256 usdcToBurn, uint256 usdcToBuy, uint256 extraTokens)
        internal
        view
        returns (Sim memory s)
    {
        (uint256 rt, uint256 ru) = _reservesOf(pair);
        uint256 supply = pair.totalSupply();
        s.usdcToBurn = usdcToBurn;
        s.usdcToBuy = usdcToBuy;
        if (usdcToBurn != 0) {
            (uint256 out, uint256 net) = _quoteAt(rt, ru, usdcToBurn);
            (rt, ru) = (rt - out, ru + net);
            s.tokensBought += out;
            s.spent += usdcToBurn;
        }
        uint256 deepenTokens;
        if (usdcToBuy != 0) {
            (uint256 out, uint256 net) = _quoteAt(rt, ru, usdcToBuy);
            (rt, ru) = (rt - out, ru + net);
            s.tokensBought += out;
            s.spent += usdcToBuy;
            deepenTokens = out;
            uint256 usdcLeft = offer - usdcToBurn - usdcToBuy;
            if (usdcLeft != 0) {
                uint256 usdcFor = out * ru / rt;
                if (usdcFor <= usdcLeft) (s.tokensAdded, s.usdcAdded) = (out, usdcFor);
                else (s.tokensAdded, s.usdcAdded) = (usdcLeft * rt / ru, usdcLeft);
                s.liquidity = Math.min(s.tokensAdded * supply / rt, s.usdcAdded * supply / ru);
                if (s.liquidity == 0) (s.tokensAdded, s.usdcAdded) = (0, 0);
            }
            s.spent += s.usdcAdded;
            (rt, ru) = (rt + s.tokensAdded, ru + s.usdcAdded);
        }
        deepenTokens; // the add can only ever take the deepen side's own tokens
        s.burned = s.tokensBought + extraTokens - s.tokensAdded;
        s.leftover = offer - s.spent;
        (s.reserveToken, s.reserveUsdc) = (rt, ru);
    }

    /// @dev The same, taking the split from the plugin's own preview (which the run uses).
    function _simulateRun(address token, LaunchPair pair, uint256 offer, uint256 extraTokens)
        internal
        view
        returns (Sim memory s)
    {
        (uint256 usdcToBurn, uint256 usdcToBuy,) = deepen.previewSplit(token, offer);
        return _simulate(pair, offer, usdcToBurn, usdcToBuy, extraTokens);
    }

    function _fees(uint256 usdcIn) internal pure returns (uint256 platformFee, uint256 creatorFee) {
        platformFee = usdcIn == 0 ? 0 : (usdcIn * 50 - 1) / 10_000 + 1;
        creatorFee = usdcIn == 0 ? 0 : (usdcIn * 100 - 1) / 10_000 + 1;
    }
}
