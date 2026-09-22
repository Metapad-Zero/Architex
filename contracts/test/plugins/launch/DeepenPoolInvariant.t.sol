// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ILaunchPair} from "../../../interfaces/ILaunchPair.sol";
import {ILaunchToken} from "../../../interfaces/ILaunchToken.sol";
import {IDeepenPoolPlugin} from "../../../interfaces/plugins/IDeepenPoolPlugin.sol";
import {DeepenPoolPlugin} from "../../../plugins/launch/DeepenPoolPlugin.sol";
import {ArchitexLaunchpad} from "../../../launchpad/ArchitexLaunchpad.sol";
import {LaunchRouter} from "../../../launchpad/LaunchRouter.sol";
import {LaunchpadV13Base, BlockableUSDC} from "../../launchpad/LaunchpadV13Base.sol";

/// @notice Random trading, collections, top-ups, liquidity moves, donations and runs against the REAL launchpad, curve,
///         launch pool and router. After every call sequence: Deepen pool's USDC is exactly what its books say, it
///         holds no token and no LP of its own, every LP token it ever minted is at the burn address, and the
///         launchpad is still solvent to the unit.
contract DeepenInvariantHandler is Test {
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    ArchitexLaunchpad public pad;
    LaunchRouter public router;
    BlockableUSDC public usdc;
    DeepenPoolPlugin public deepen;
    address[] public tokens;
    address[] public actors;

    // Ghosts
    mapping(address token => uint256) public ghostCredited;
    mapping(address token => uint256) public ghostStrayTokens; // tokens sent to the plugin, not yet run
    mapping(address token => uint256) public ghostStrayLp; // LP sent to the plugin, not yet run
    mapping(address token => uint256) public ghostLockedByRuns; // LP the runs minted to the burn address
    mapping(address token => uint256) public ghostStrayLpLocked; // stray LP the runs passed on
    uint256 public violations;
    // Coverage
    uint256 public runs;
    uint256 public poolRuns;
    uint256 public sellOutRuns;
    uint256 public graduations;
    uint256 public strayRuns;

    constructor(
        ArchitexLaunchpad pad_,
        LaunchRouter router_,
        BlockableUSDC usdc_,
        DeepenPoolPlugin deepen_,
        address[] memory tokens_,
        address[] memory actors_
    ) {
        pad = pad_;
        router = router_;
        usdc = usdc_;
        deepen = deepen_;
        tokens = tokens_;
        actors = actors_;
        for (uint256 i; i < actors_.length; ++i) {
            usdc.mint(actors_[i], 50_000_000e6);
            vm.startPrank(actors_[i]);
            usdc.approve(address(pad), type(uint256).max);
            usdc.approve(address(router), type(uint256).max);
            usdc.approve(address(deepen), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _token(uint256 w) internal view returns (address) {
        return tokens[w % tokens.length];
    }

    function _actor(uint256 a) internal view returns (address) {
        return actors[a % actors.length];
    }

    // ─── Trading ──────────────────────────────────────────────────────────────

    function curveBuy(uint256 w, uint256 a, uint256 amount) external {
        address t = _token(w);
        if (pad.isGraduated(t)) return;
        address who = _actor(a);
        vm.prank(who);
        try pad.buy(t, bound(amount, 1e6, 6_000e6), 0, who, type(uint256).max) {} catch {}
    }

    function curveSell(uint256 w, uint256 a, uint256 amount) external {
        address t = _token(w);
        if (pad.isGraduated(t)) return;
        address who = _actor(a);
        uint256 held = IERC20(t).balanceOf(who);
        uint256 sold = pad.curves(t).tokensSold;
        if (held > sold) held = sold;
        if (held == 0) return;
        vm.prank(who);
        try pad.sell(t, bound(amount, 1, held), 0, who, type(uint256).max) {} catch {}
    }

    function graduate(uint256 w, uint256 a) external {
        address t = _token(w);
        if (pad.isGraduated(t)) return;
        address who = _actor(a);
        vm.prank(who);
        pad.buy(t, 1_000_000e6, 0, who, type(uint256).max);
        graduations += 1;
    }

    function poolBuy(uint256 w, uint256 a, uint256 amount) external {
        address t = _token(w);
        if (!pad.isGraduated(t)) return;
        address who = _actor(a);
        vm.prank(who);
        try router.buy(t, bound(amount, 1e6, 100_000e6), 0, who, block.timestamp) {} catch {}
    }

    function poolSell(uint256 w, uint256 a, uint256 amount) external {
        address t = _token(w);
        if (!pad.isGraduated(t)) return;
        address who = _actor(a);
        uint256 held = IERC20(t).balanceOf(who);
        if (held == 0) return;
        vm.prank(who);
        try router.sell(t, bound(amount, 1, held), 0, who, block.timestamp) {} catch {}
    }

    // ─── Fees in ──────────────────────────────────────────────────────────────

    function collect(uint256 w) external {
        address t = _token(w);
        uint256 before = deepen.usdcHeld(t) + deepen.totalUsdcSpent(t);
        pad.collectCreatorFees(t);
        ghostCredited[t] += deepen.usdcHeld(t) + deepen.totalUsdcSpent(t) - before;
    }

    /// @dev Anyone may top a configured token's pot up (Architex's fee wallet, the creator, a keeper).
    function topUp(uint256 w, uint256 a, uint256 amount) external {
        address t = _token(w);
        address who = _actor(a);
        amount = bound(amount, 0, 20_000e6);
        vm.prank(who);
        deepen.onFees(t, amount);
        ghostCredited[t] += amount;
    }

    // ─── Runs ─────────────────────────────────────────────────────────────────

    function run(uint256 w, bool tryAgain) external {
        address t = _token(w);
        (uint256 offered, bool graduated) = deepen.previewRun(t);
        if (offered == 0) return;
        ILaunchPair pair = ILaunchPair(pad.pairOf(t));
        uint256 heldBefore = deepen.usdcHeld(t);
        uint256 cap = (graduated ? _reserveUsdc(pair) : pad.virtualUsdcOf(t)) * 25 / 10_000;
        uint256 deadBefore = pair.balanceOf(DEAD);
        uint256 kBefore = _k(pair);
        uint256 strayLp = ghostStrayLp[t];
        if (ghostStrayTokens[t] != 0 || strayLp != 0) strayRuns += 1;

        (uint256 spent, uint256 burned, uint256 liquidity) = deepen.run(t);
        runs += 1;
        if (graduated) poolRuns += 1;
        else if (spent < offered) sellOutRuns += 1;

        // Per-run properties. Any failure is counted here so a handler revert can never hide it.
        if (spent > offered || spent > cap || spent > heldBefore) violations += 1;
        if (graduated && offered - spent > 4) violations += 1;
        if (IERC20(t).balanceOf(address(deepen)) != 0) violations += 1;
        if (pair.balanceOf(address(deepen)) != 0) violations += 1;
        if (usdc.allowance(address(deepen), address(pad)) != 0) violations += 1;
        if (usdc.allowance(address(deepen), address(router)) != 0) violations += 1;
        if (pair.balanceOf(DEAD) != deadBefore + liquidity + (graduated ? strayLp : 0)) violations += 1;
        if (graduated && _k(pair) < kBefore) violations += 1;
        if (!graduated && (liquidity != 0 || burned == 0)) violations += 1;
        if (deepen.usdcHeld(t) != heldBefore - spent) violations += 1;

        ghostStrayTokens[t] = 0;
        ghostLockedByRuns[t] += liquidity;
        if (graduated) {
            ghostStrayLpLocked[t] += strayLp;
            ghostStrayLp[t] = 0;
        }

        if (tryAgain) {
            try deepen.run(t) {
                violations += 1; // a second run in the same block must fail
            } catch {}
        }
    }

    /// @dev Time and blocks: runs are paced by time, so blocks alone would leave almost no budget.
    function nextBlock(uint256 blocks) external {
        uint256 n = bound(blocks, 1, 3);
        vm.roll(block.number + n);
        vm.warp(block.timestamp + n * 20 minutes);
    }

    // ─── Things anyone can do to the plugin and the pool ──────────────────────

    /// @dev Tokens sent straight to the plugin: the next run adds or burns them.
    function sendStrayTokens(uint256 w, uint256 a, uint256 amount) external {
        address t = _token(w);
        address who = _actor(a);
        uint256 held = IERC20(t).balanceOf(who);
        if (held == 0) return;
        amount = bound(amount, 1, held);
        vm.prank(who);
        IERC20(t).transfer(address(deepen), amount);
        ghostStrayTokens[t] += amount;
    }

    /// @dev LP sent straight to the plugin: the next pool run passes it to the burn address.
    function sendStrayLiquidity(uint256 w, uint256 a, uint256 amount) external {
        address t = _token(w);
        if (!pad.isGraduated(t)) return;
        address who = _actor(a);
        ILaunchPair pair = ILaunchPair(pad.pairOf(t));
        uint256 lp = pair.balanceOf(who);
        if (lp == 0) return;
        amount = bound(amount, 1, lp);
        vm.prank(who);
        pair.transfer(address(deepen), amount);
        ghostStrayLp[t] += amount;
    }

    /// @dev A third party adding liquidity of their own, at the pool's ratio.
    function addLiquidity(uint256 w, uint256 a, uint256 amount) external {
        address t = _token(w);
        if (!pad.isGraduated(t)) return;
        address who = _actor(a);
        ILaunchPair pair = ILaunchPair(pad.pairOf(t));
        (uint112 rt, uint112 ru,) = pair.getReserves();
        uint256 tokensIn = bound(amount, 1e18, 1_000_000e18);
        if (IERC20(t).balanceOf(who) < tokensIn) return;
        uint256 usdcIn = tokensIn * ru / rt;
        if (usdcIn == 0 || usdc.balanceOf(who) < usdcIn) return;
        vm.startPrank(who);
        IERC20(t).transfer(address(pair), tokensIn);
        usdc.transfer(address(pair), usdcIn);
        try pair.mint(who) {} catch {}
        vm.stopPrank();
    }

    /// @dev A third party taking their liquidity out again.
    function removeLiquidity(uint256 w, uint256 a, uint256 amount) external {
        address t = _token(w);
        if (!pad.isGraduated(t)) return;
        address who = _actor(a);
        ILaunchPair pair = ILaunchPair(pad.pairOf(t));
        uint256 lp = pair.balanceOf(who);
        if (lp == 0) return;
        vm.startPrank(who);
        pair.transfer(address(pair), bound(amount, 1, lp));
        try pair.burn(who) {} catch {}
        vm.stopPrank();
    }

    /// @dev USDC or tokens donated straight into the pair, without a sync: the next swap absorbs them.
    function donateToPair(uint256 w, uint256 a, uint256 amount, bool inUsdc) external {
        address t = _token(w);
        if (!pad.isGraduated(t)) return;
        address who = _actor(a);
        address pair = pad.pairOf(t);
        vm.startPrank(who);
        if (inUsdc) usdc.transfer(pair, bound(amount, 1, 1_000e6));
        else {
            uint256 held = IERC20(t).balanceOf(who);
            if (held != 0) IERC20(t).transfer(pair, bound(amount, 1, held));
        }
        vm.stopPrank();
    }

    /// @dev Anyone may skim whatever sits in a pair above its reserves.
    function skim(uint256 w, uint256 a) external {
        address t = _token(w);
        if (!pad.isGraduated(t)) return;
        ILaunchPair(pad.pairOf(t)).skim(_actor(a));
    }

    function _reserveUsdc(ILaunchPair pair) internal view returns (uint256) {
        (, uint112 ru,) = pair.getReserves();
        return ru;
    }

    function _k(ILaunchPair pair) internal view returns (uint256) {
        (uint112 rt, uint112 ru,) = pair.getReserves();
        return uint256(rt) * uint256(ru);
    }
}

contract DeepenPoolInvariantTest is LaunchpadV13Base {
    DeepenPoolPlugin internal deepen;
    DeepenInvariantHandler internal handler;
    address[] internal tokenList;

    function setUp() public override {
        super.setUp();
        deepen = new DeepenPoolPlugin(address(pad));

        vm.startPrank(alice);
        tokenList.push(pad.createToken("Zero", "ZERO", "", 0, address(deepen), "", 0, 0, type(uint256).max));
        tokenList.push(pad.createToken("One", "ONE", "", 100, address(deepen), "", 0, 0, type(uint256).max));
        tokenList.push(pad.createToken("Ten", "TEN", "", 1000, address(deepen), "", 0, 0, type(uint256).max));
        vm.stopPrank();
        // One token starts graduated, so pool runs happen from the first call.
        _graduate(tokenList[2]);

        address[] memory actors = new address[](3);
        actors[0] = makeAddr("trader1");
        actors[1] = makeAddr("trader2");
        actors[2] = makeAddr("keeper");
        handler = new DeepenInvariantHandler(pad, router, usdc, deepen, tokenList, actors);
        targetContract(address(handler));
    }

    /// @dev The plugin's USDC is exactly the sum of what it holds per token, and each token's ledger balances:
    ///      held + spent == everything ever credited to it.
    function invariant_usdcHeldEqualsCreditedMinusSpent() public view {
        uint256 sum;
        for (uint256 i; i < tokenList.length; ++i) {
            address t = tokenList[i];
            sum += deepen.usdcHeld(t);
            assertEq(deepen.usdcHeld(t) + deepen.totalUsdcSpent(t), handler.ghostCredited(t), "held + spent");
        }
        assertEq(usdc.balanceOf(address(deepen)), sum, "Deepen USDC == its per-token balances");
    }

    /// @dev The plugin never ends a call holding a token or an LP token of its own: what it holds is exactly what was
    ///      sent to it since its last run.
    function invariant_holdsNothingOfItsOwn() public view {
        for (uint256 i; i < tokenList.length; ++i) {
            address t = tokenList[i];
            assertEq(IERC20(t).balanceOf(address(deepen)), handler.ghostStrayTokens(t), "only strays, until the next run");
            assertEq(_pairOf(t).balanceOf(address(deepen)), handler.ghostStrayLp(t), "no LP of its own");
        }
    }

    /// @dev Every LP token the runs minted, and every stray LP they passed on, is at the burn address; the plugin's
    ///      books agree.
    function invariant_everyLpTokenIsLocked() public view {
        for (uint256 i; i < tokenList.length; ++i) {
            address t = tokenList[i];
            assertEq(deepen.totalLiquidityLocked(t), handler.ghostLockedByRuns(t), "the books count what was minted");
            assertGe(
                _pairOf(t).balanceOf(DEAD),
                deepen.totalLiquidityLocked(t) + handler.ghostStrayLpLocked(t),
                "the burn address holds at least the graduation LP plus everything the runs locked"
            );
        }
    }

    function invariant_perRunPropertiesHold() public view {
        assertEq(handler.violations(), 0, "a run broke one of its own rules");
    }

    /// @dev V13-SPEC §6.1: the launchpad is still solvent to the unit through all of it.
    function invariant_launchpadSolvent() public view {
        _assertSolvent();
    }

    function afterInvariant() public view {
        // Evidence the run exercised the interesting paths (printed with -vv).
        console2.log("runs", handler.runs());
        console2.log("pool runs", handler.poolRuns());
        console2.log("sell-out runs", handler.sellOutRuns());
        console2.log("graduations", handler.graduations());
        console2.log("runs with strays waiting", handler.strayRuns());
    }
}
