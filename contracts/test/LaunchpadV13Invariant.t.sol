// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "./launchpad/LaunchpadV13Base.sol";

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Launchpad solvency (V13-SPEC §6.1-6.5) under random curve trades, pool trades,
//    graduations, dividend activity and fee collections across five tokens with different plugins.
// ═══════════════════════════════════════════════════════════════════════════════

contract SolvencyHandler is Test {
    ArchitexLaunchpad public pad;
    LaunchRouter public router;
    BlockableUSDC public usdc;
    MisbehavingPlugin public flaky;
    address[] public tokens;
    address[] public actors;

    // Ghosts
    bool public ghostPoolKFell;
    bool public ghostFeeMismatch;
    bool public ghostPullCheckFailed;
    uint256 public ghostCollectReverts;
    uint256 public ghostPoolTrades;
    uint256 public ghostGraduations;
    mapping(address => uint256) public ghostPluginPaid; // what each token's collections moved out

    constructor(
        ArchitexLaunchpad _pad,
        LaunchRouter _router,
        BlockableUSDC _usdc,
        MisbehavingPlugin _flaky,
        address[] memory _tokens,
        address[] memory _actors
    ) {
        pad = _pad;
        router = _router;
        usdc = _usdc;
        flaky = _flaky;
        tokens = _tokens;
        actors = _actors;
        for (uint256 i = 0; i < _actors.length; i++) {
            usdc.mint(_actors[i], 10_000_000_000e6);
            vm.startPrank(_actors[i]);
            usdc.approve(address(_pad), type(uint256).max);
            usdc.approve(address(_router), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _token(uint256 w) internal view returns (address) {
        return tokens[w % tokens.length];
    }

    function _actor(uint256 a) internal view returns (address) {
        return actors[a % actors.length];
    }

    function curveBuy(uint256 w, uint256 a, uint256 amount) external {
        address t = _token(w);
        if (pad.isGraduated(t)) return;
        address who = _actor(a);
        amount = bound(amount, 1, 6_000e6);
        vm.prank(who);
        try pad.buy(t, amount, 0, who) {} catch {}
    }

    function curveSell(uint256 w, uint256 a, uint256 amount) external {
        address t = _token(w);
        if (pad.isGraduated(t)) return;
        address who = _actor(a);
        uint256 held = IERC20(t).balanceOf(who);
        uint256 sold = pad.curves(t).tokensSold;
        if (held > sold) held = sold;
        if (held == 0) return;
        amount = bound(amount, 1, held);
        vm.prank(who);
        try pad.sell(t, amount, 0, who) {} catch {}
    }

    function graduate(uint256 w, uint256 a) external {
        address t = _token(w);
        if (pad.isGraduated(t)) return;
        address who = _actor(a);
        vm.prank(who);
        pad.buy(t, 1_000_000e6, 0, who);
        ghostGraduations++;
    }

    function _poolK(address t) internal view returns (uint256) {
        (uint112 rt, uint112 ru,) = ILaunchPair(pad.pairOf(t)).getReserves();
        return uint256(rt) * uint256(ru);
    }

    function poolBuy(uint256 w, uint256 a, uint256 amount) external {
        address t = _token(w);
        if (!pad.isGraduated(t)) return;
        address who = _actor(a);
        amount = bound(amount, 1, 60_000e6);
        uint256 kBefore = _poolK(t);
        uint256 feesBefore = pad.pendingFees();
        uint256 creatorBefore = pad.pendingCreatorFees(t);
        try router.quoteBuy(t, amount) returns (uint256, uint256 qPlatform, uint256 qCreator) {
            vm.prank(who);
            router.buy(t, amount, 0, who, block.timestamp);
            ghostPoolTrades++;
            if (pad.pendingFees() - feesBefore != qPlatform || pad.pendingCreatorFees(t) - creatorBefore != qCreator) {
                ghostFeeMismatch = true;
            }
            if (_poolK(t) < kBefore) ghostPoolKFell = true;
        } catch {}
    }

    function poolSell(uint256 w, uint256 a, uint256 amount) external {
        address t = _token(w);
        if (!pad.isGraduated(t)) return;
        address who = _actor(a);
        uint256 held = IERC20(t).balanceOf(who);
        if (held == 0) return;
        amount = bound(amount, 1, held);
        uint256 kBefore = _poolK(t);
        uint256 feesBefore = pad.pendingFees();
        uint256 creatorBefore = pad.pendingCreatorFees(t);
        try router.quoteSell(t, amount) returns (uint256, uint256 qPlatform, uint256 qCreator) {
            vm.prank(who);
            router.sell(t, amount, 0, who, block.timestamp);
            ghostPoolTrades++;
            if (pad.pendingFees() - feesBefore != qPlatform || pad.pendingCreatorFees(t) - creatorBefore != qCreator) {
                ghostFeeMismatch = true;
            }
            if (_poolK(t) < kBefore) ghostPoolKFell = true;
        } catch {}
    }

    function transferTokens(uint256 w, uint256 a, uint256 b, uint256 amount) external {
        address t = _token(w);
        address from = _actor(a);
        uint256 held = IERC20(t).balanceOf(from);
        if (held == 0) return;
        amount = bound(amount, 1, held);
        vm.prank(from);
        IERC20(t).transfer(_actor(b), amount);
    }

    function distribute(uint256 w, uint256 a, uint256 amount) external {
        address t = _token(w);
        address who = _actor(a);
        amount = bound(amount, 1, 5_000e6);
        vm.startPrank(who);
        usdc.approve(t, amount);
        try ILaunchToken(t).distribute(amount) {} catch {}
        vm.stopPrank();
    }

    function claim(uint256 w, uint256 a) external {
        vm.prank(_actor(a));
        ILaunchToken(_token(w)).claim();
    }

    function collectFees() external {
        pad.collectFees();
    }

    function collectCreatorFees(uint256 w) external {
        address t = _token(w);
        uint256 owed = pad.pendingCreatorFees(t);
        uint256 padBefore = usdc.balanceOf(address(pad));
        try pad.collectCreatorFees(t) returns (uint256 paid) {
            if (paid != owed || padBefore - usdc.balanceOf(address(pad)) != owed) ghostPullCheckFailed = true;
            ghostPluginPaid[t] += paid;
        } catch {
            ghostCollectReverts++;
            // A failed collection leaves the fees accrued
            if (pad.pendingCreatorFees(t) != owed) ghostPullCheckFailed = true;
        }
    }

    function setFlakyMode(uint8 m) external {
        flaky.setMode(MisbehavingPlugin.Mode(m % 7));
    }
}

contract LaunchpadV13SolvencyInvariant is LaunchpadV13Base {
    SolvencyHandler handler;
    ExactPlugin exact;
    MisbehavingPlugin flaky;
    DistributePlugin distributor;
    LyingPlugin liar;
    address[] tokenList;

    function setUp() public override {
        super.setUp();
        exact = new ExactPlugin(pad);
        flaky = new MisbehavingPlugin(IERC20(address(usdc)));
        distributor = new DistributePlugin(IERC20(address(usdc)));
        liar = new LyingPlugin();

        vm.startPrank(alice);
        tokenList.push(pad.createToken("Zero", "ZERO", "", 0, creatorWallet, "", 0, 0));
        tokenList.push(pad.createToken("Max", "MAX", "", 1000, address(exact), "", 0, 0));
        tokenList.push(pad.createToken("Flaky", "FLKY", "", 333, address(flaky), "", 0, 0));
        tokenList.push(pad.createToken("Share", "SHARE", "", 50, address(distributor), "", 0, 0));
        tokenList.push(pad.createToken("Liar", "LIAR", "", 777, address(liar), "", 0, 0));
        vm.stopPrank();
        // One token starts graduated so pool trades run from the first call
        _graduate(tokenList[1]);

        address[] memory actors = new address[](3);
        actors[0] = makeAddr("trader1");
        actors[1] = makeAddr("trader2");
        actors[2] = makeAddr("trader3");
        handler = new SolvencyHandler(pad, router, usdc, flaky, tokenList, actors);
        targetContract(address(handler));
    }

    /// @notice §6.1: USDC held == pendingFees + Σ pendingCreatorFees + Σ live floats, to the unit.
    function invariant_solvencyToTheUnit() public view {
        _assertSolvent();
    }

    /// @notice The curves keep their shape, and a graduated curve left nothing behind.
    function invariant_curves() public view {
        for (uint256 i = 0; i < tokenList.length; i++) {
            address t = tokenList[i];
            IArchitexLaunchpad.Curve memory c = pad.curves(t);
            assertEq(uint256(c.virtualTokens) + uint256(c.tokensSold), VIRTUAL_TOKENS_0);
            assertLe(uint256(c.tokensSold), CURVE_SUPPLY);
            assertGe(uint256(c.virtualUsdc), VIRTUAL_USDC_0);
            if (c.graduated) {
                assertEq(IERC20(t).balanceOf(address(pad)), 0);
                assertEq(uint256(c.tokensSold), CURVE_SUPPLY);
                LaunchPair pair = LaunchPair(c.pair);
                assertGe(pair.balanceOf(DEAD), 1000);
                assertEq(pair.balanceOf(DEAD), pair.totalSupply(), "no one added liquidity here");
            } else {
                assertEq(IERC20(t).balanceOf(address(pad)), TOTAL_SUPPLY - uint256(c.tokensSold));
                assertEq(LaunchPair(c.pair).totalSupply(), 0, "the pool stays empty until graduation");
                assertEq(IERC20(t).balanceOf(c.pair), 0);
            }
        }
    }

    /// @notice §6.2/§6.5: every plugin credit is backed; pool trades pay exactly the quoted fees; k never falls.
    function invariant_feesAndPools() public view {
        assertFalse(handler.ghostFeeMismatch(), "a pool trade accrued other fees than quoted");
        assertFalse(handler.ghostPoolKFell(), "a pool trade lowered k");
        assertFalse(handler.ghostPullCheckFailed(), "a collection moved other than exactly what was owed");
        assertEq(exact.received(tokenList[1]), usdc.balanceOf(address(exact)), "credits == USDC received");
        assertEq(handler.ghostPluginPaid(tokenList[1]), exact.received(tokenList[1]));
        assertEq(handler.ghostPluginPaid(tokenList[4]), usdc.balanceOf(address(liar)));
        assertEq(liar.hookCalls(), 0);
    }

    /// @notice The router and the pair factory never hold anything.
    function invariant_routerHoldsNothing() public view {
        assertEq(usdc.balanceOf(address(router)), 0);
        for (uint256 i = 0; i < tokenList.length; i++) {
            assertEq(IERC20(tokenList[i]).balanceOf(address(router)), 0);
        }
        assertEq(usdc.allowance(address(pad), address(exact)), 0);
        assertEq(usdc.allowance(address(pad), address(flaky)), 0);
        assertEq(usdc.allowance(address(pad), address(distributor)), 0);
    }

    function afterInvariant() public view {
        // Evidence the run exercised the interesting paths (printed with -vv)
        console.log("pool trades", handler.ghostPoolTrades());
        console.log("graduations", handler.ghostGraduations());
        console.log("failed collections", handler.ghostCollectReverts());
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Dividends (V13-SPEC §6.6): Σ claimable + Σ claimed ≤ Σ distributed, excluded accounts never accrue,
//    through curve and pool trades (pulls), transfers, burns, sends to DEAD, distributions and claims.
// ═══════════════════════════════════════════════════════════════════════════════

contract DividendHandler is Test {
    ArchitexLaunchpad public pad;
    LaunchRouter public router;
    BlockableUSDC public usdc;
    ILaunchToken public token;
    address[] public actors;

    uint256 public ghostDistributions;
    uint256 public ghostNoEligibleSupply;
    uint256 public ghostBurned;

    constructor(ArchitexLaunchpad _pad, LaunchRouter _router, BlockableUSDC _usdc, address _token, address[] memory _actors) {
        pad = _pad;
        router = _router;
        usdc = _usdc;
        token = ILaunchToken(_token);
        actors = _actors;
        for (uint256 i = 0; i < _actors.length; i++) {
            usdc.mint(_actors[i], 10_000_000_000e6);
            vm.startPrank(_actors[i]);
            usdc.approve(address(_pad), type(uint256).max);
            usdc.approve(address(_router), type(uint256).max);
            usdc.approve(_token, type(uint256).max);
            vm.stopPrank();
        }
    }

    function actorsLength() external view returns (uint256) {
        return actors.length;
    }

    function _actor(uint256 a) internal view returns (address) {
        return actors[a % actors.length];
    }

    function buy(uint256 a, uint256 amount) external {
        address who = _actor(a);
        if (pad.isGraduated(address(token))) {
            amount = bound(amount, 1, 50_000e6);
            vm.prank(who);
            try router.buy(address(token), amount, 0, who, block.timestamp) {} catch {}
        } else {
            amount = bound(amount, 1, 5_000e6);
            vm.prank(who);
            try pad.buy(address(token), amount, 0, who) {} catch {}
        }
    }

    function sell(uint256 a, uint256 amount) external {
        address who = _actor(a);
        uint256 held = token.balanceOf(who);
        if (held == 0) return;
        amount = bound(amount, 1, held);
        bool pool = pad.isGraduated(address(token)); // read before the prank, which the next call consumes
        vm.prank(who);
        if (pool) {
            try router.sell(address(token), amount, 0, who, block.timestamp) {} catch {}
        } else {
            try pad.sell(address(token), amount, 0, who) {} catch {}
        }
    }

    function graduate(uint256 a) external {
        if (pad.isGraduated(address(token))) return;
        address who = _actor(a);
        vm.prank(who);
        pad.buy(address(token), 1_000_000e6, 0, who);
    }

    function transfer(uint256 a, uint256 b, uint256 amount) external {
        address from = _actor(a);
        uint256 held = token.balanceOf(from);
        if (held == 0) return;
        amount = bound(amount, 0, held);
        vm.prank(from);
        token.transfer(_actor(b), amount);
    }

    function sendToDead(uint256 a, uint256 amount) external {
        address from = _actor(a);
        uint256 held = token.balanceOf(from);
        if (held == 0) return;
        amount = bound(amount, 1, held);
        vm.prank(from);
        token.transfer(0x000000000000000000000000000000000000dEaD, amount);
    }

    function burn(uint256 a, uint256 amount) external {
        address from = _actor(a);
        uint256 held = token.balanceOf(from);
        if (held == 0) return;
        amount = bound(amount, 1, held);
        vm.prank(from);
        token.burn(amount);
        ghostBurned += amount;
    }

    function distribute(uint256 a, uint256 amount) external {
        amount = bound(amount, 0, 20_000e6);
        vm.prank(_actor(a));
        try token.distribute(amount) {
            ghostDistributions++;
        } catch (bytes memory err) {
            if (bytes4(err) == ILaunchTokenExtensions.NoEligibleSupply.selector) ghostNoEligibleSupply++;
        }
    }

    /// @dev Creator fees collected to the DistributePlugin, which distributes them through the token.
    function collect() external {
        try pad.collectCreatorFees(address(token)) returns (uint256 paid) {
            if (paid > 0) ghostDistributions++;
        } catch {}
    }

    function claim(uint256 a) external {
        vm.prank(_actor(a));
        token.claim();
    }

    function claimFor(uint256 caller, uint256 a) external {
        vm.prank(_actor(caller));
        token.claimFor(_actor(a));
    }
}

contract LaunchTokenDividendInvariant is LaunchpadV13Base {
    DividendHandler handler;
    ILaunchToken token;
    address[] actors;

    function setUp() public override {
        super.setUp();
        DistributePlugin plugin = new DistributePlugin(IERC20(address(usdc)));
        vm.prank(alice);
        token = ILaunchToken(pad.createToken("Dividend", "DIV", "", 500, address(plugin), "", 0, 0));
        actors.push(makeAddr("holder1"));
        actors.push(makeAddr("holder2"));
        actors.push(makeAddr("holder3"));
        actors.push(makeAddr("holder4"));
        handler = new DividendHandler(pad, router, usdc, address(token), actors);
        targetContract(address(handler));
    }

    function _sums() internal view returns (uint256 claimable, uint256 claimed, uint256 balances) {
        for (uint256 i = 0; i < actors.length; i++) {
            claimable += token.claimable(actors[i]);
            claimed += token.claimed(actors[i]);
            balances += token.balanceOf(actors[i]);
        }
    }

    /// @notice Σ claimable + Σ claimed ≤ Σ distributed, and the rounding loss is bounded.
    function invariant_neverOverCredits() public view {
        (uint256 claimable, uint256 claimed,) = _sums();
        uint256 distributed = token.totalDistributed();
        assertLe(claimable + claimed, distributed, "credited more than was distributed");
        // Floors lose < 1 unit per distribution and < 1 unit per account
        assertLe(distributed - (claimable + claimed), handler.ghostDistributions() + actors.length + 1, "dust bound");
    }

    /// @notice The token holds exactly what has been distributed and not yet claimed, which covers every claim.
    function invariant_usdcBacksEveryClaim() public view {
        (uint256 claimable, uint256 claimed,) = _sums();
        uint256 held = usdc.balanceOf(address(token));
        assertEq(held, token.totalDistributed() - claimed);
        assertGe(held, claimable);
    }

    /// @notice Excluded accounts never accrue, and eligible supply is exactly the actors' balances.
    function invariant_exclusions() public view {
        address pair = pad.pairOf(address(token));
        address[4] memory excluded = [address(pad), pair, DEAD, address(0)];
        for (uint256 i = 0; i < excluded.length; i++) {
            assertTrue(token.isExcluded(excluded[i]));
            assertEq(token.claimable(excluded[i]), 0);
            assertEq(token.claimed(excluded[i]), 0);
        }
        (,, uint256 balances) = _sums();
        // eligible supply == the non-excluded holders' balances (reported as 0 while under one whole token)
        assertEq(token.eligibleSupply(), balances < token.MIN_ELIGIBLE_SUPPLY() ? 0 : balances);
        assertEq(
            token.totalSupply(),
            balances + token.balanceOf(address(pad)) + token.balanceOf(pair) + token.balanceOf(DEAD),
            "every token is somewhere"
        );
        assertEq(token.totalSupply(), TOTAL_SUPPLY - handler.ghostBurned());
    }

    function afterInvariant() public view {
        console.log("distributions", handler.ghostDistributions());
        console.log("refused (no eligible supply)", handler.ghostNoEligibleSupply());
        console.log("graduated", pad.isGraduated(address(token)));
    }
}
