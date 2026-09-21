// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./E2EBase.sol";

/// @notice Theme 9: gas of every user- and keeper-facing call, logged, each asserted under 15,000,000 (Arc's per-tx
///         limit is ~30M; this keeps a 2x margin). Each figure is the call's execution gas measured with every account
///         it touches cooled first (vm.cool, as at the start of a real transaction), plus the 21,000 intrinsic gas and
///         16 gas per calldata byte (an upper bound). Storage slots already written earlier in the same test are
///         priced as re-writes of a dirty slot, so a real transaction can cost up to ~2,900 gas more per such slot.
contract GasE2ETest is E2EBase {
    uint256 internal constant LIMIT = 15_000_000;

    address[20] internal payees20;

    function setUp() public override {
        super.setUp();
        for (uint256 i; i < 20; ++i) {
            payees20[i] = makeAddr(string.concat("gas payee ", vm.toString(i)));
        }
    }

    function _cool(address token) internal {
        vm.cool(address(pad));
        vm.cool(address(router));
        vm.cool(address(pairFactory));
        vm.cool(address(usdc));
        vm.cool(address(split));
        vm.cool(address(buyback));
        vm.cool(address(holder));
        vm.cool(address(combo));
        if (token != address(0)) {
            vm.cool(token);
            vm.cool(pad.pairOf(token));
        }
    }

    function _report(string memory label, uint256 executionGas, uint256 calldataBytes) internal pure returns (uint256 total) {
        total = executionGas + 21_000 + 16 * calldataBytes;
        console2.log(string.concat(label, ": "), total);
        assertLt(total, LIMIT, label);
    }

    function _split20Data() internal view returns (bytes memory) {
        address[] memory p = new address[](20);
        uint256[] memory s = new uint256[](20);
        for (uint256 i; i < 20; ++i) {
            p[i] = payees20[i];
            s[i] = i + 1;
        }
        return abi.encode(p, s);
    }

    /// @dev The heaviest listed configuration: a 5-entry Combo holding a 20-payee Split, Buyback, Holders and two
    ///      plain addresses.
    function _heaviestComboData() internal view returns (bytes memory) {
        return abi.encode(
            _addrs(address(split), address(buyback), address(holder), creatorWallet, address(safeWallet)),
            _u16s(3000, 2000, 2000, 2000, 1000),
            _datas(_split20Data(), "", "", "", "")
        );
    }

    function _gasCreate(string memory label, address plugin, bytes memory data, uint256 initialBuy)
        internal
        returns (address token)
    {
        _cool(address(0));
        bytes memory cd = abi.encodeCall(
            IArchitexLaunchpad.createToken,
            ("Gas Token", "GAS", "ipfs://gas", 1000, plugin, data, initialBuy, 0, LAUNCH_FEE)
        );
        vm.prank(alice);
        uint256 g = gasleft();
        token = pad.createToken("Gas Token", "GAS", "ipfs://gas", 1000, plugin, data, initialBuy, 0, LAUNCH_FEE);
        uint256 used = g - gasleft();
        _register(token);
        _report(label, used, cd.length);
    }

    function _gasCollect(string memory label, address token) internal {
        assertGt(pad.pendingCreatorFees(token), 0);
        _cool(token);
        uint256 g = gasleft();
        pad.collectCreatorFees(token);
        _report(label, g - gasleft(), 36);
    }

    function test_gas_createToken_everyPlugin() public {
        _gasCreate("createToken, creator wallet (EOA)", creatorWallet, "", 0);
        _gasCreate("createToken, plain contract", address(plainWallet), "", 0);
        _gasCreate("createToken, Safe-like wallet", address(safeWallet), "", 0);
        _gasCreate("createToken, Split (3 payees)", address(split), _splitData(), 0);
        _gasCreate("createToken, Split (20 payees)", address(split), _split20Data(), 0);
        _gasCreate("createToken, Buyback & burn", address(buyback), "", 0);
        _gasCreate("createToken, Holders", address(holder), "", 0);
        _gasCreate("createToken, Combo (4 entries)", address(combo), _comboData(), 0);
        _gasCreate("createToken, Combo (5 entries, 20-payee Split)", address(combo), _heaviestComboData(), 0);
        _gasCreate("createToken, Combo (heaviest) + first buy", address(combo), _heaviestComboData(), 1_000e6);
        _gasCreate("createToken, Combo (heaviest) + sell-out first buy", address(combo), _heaviestComboData(), 40_000e6);
    }

    function test_gas_tradesCollectionsAndPluginActions() public {
        address[] memory t = new address[](7);
        t[0] = _launch(Kind.Eoa, 1000, 0);
        t[1] = _launch(Kind.SafeLike, 1000, 0);
        t[2] = _launch(Kind.Split, 1000, 0);
        t[3] = _launch(Kind.Buyback, 1000, 0);
        t[4] = _launch(Kind.Holder, 1000, 0);
        t[5] = _launch(Kind.Combo, 1000, 0);
        t[6] = _launchWith(alice, 1000, address(combo), _heaviestComboData(), 0);

        // Curve buy and sell with no dividend stream (a first-time buyer, then a partial sell).
        _cool(t[4]);
        vm.prank(bob);
        uint256 g = gasleft();
        pad.buy(t[4], 5_000e6, 0, bob, _now());
        _report("curve buy (no stream)", g - gasleft(), 164);
        uint256 half = IERC20(t[4]).balanceOf(bob) / 2;
        _cool(t[4]);
        vm.prank(bob);
        g = gasleft();
        pad.sell(t[4], half, 0, bob, _now());
        _report("curve sell (no stream)", g - gasleft(), 164);

        // Collection into each plugin. For Holders the first delivery starts the token's stream.
        for (uint256 i; i < t.length; ++i) {
            if (i != 4) _curveBuy(carol, t[i], 5_000e6);
        }
        _gasCollect("collect -> creator wallet (transfer)", t[0]);
        _gasCollect("collect -> Safe-like wallet (transfer)", t[1]);
        _gasCollect("collect -> Split.onFees", t[2]);
        _gasCollect("collect -> Buyback.onFees", t[3]);
        _gasCollect("collect -> Holders.onFees (starts the stream)", t[4]);
        _gasCollect("collect -> Combo.onFees (4 entries)", t[5]);
        _gasCollect("collect -> Combo.onFees (5 entries, 20-payee Split)", t[6]);

        // With the stream running: trades, transfers and claims pay for the accrual.
        _warp(6 hours);
        _cool(t[4]);
        vm.prank(carol);
        g = gasleft();
        pad.buy(t[4], 1_000e6, 0, carol, _now());
        _report("curve buy (stream running)", g - gasleft(), 164);
        _cool(t[4]);
        vm.prank(bob);
        g = gasleft();
        pad.sell(t[4], half / 2, 0, bob, _now());
        _report("curve sell (stream running)", g - gasleft(), 164);
        _warp(1 hours);
        _cool(t[4]);
        vm.prank(bob);
        g = gasleft();
        IERC20(t[4]).transfer(dave, 1_000e18);
        _report("LaunchToken.transfer (stream running)", g - gasleft(), 68);
        _addHolder(t[4], dave);
        _gasCollect("collect -> Holders.onFees (into a running stream)", t[4]);
        _warp(1 hours);
        _cool(t[4]);
        vm.prank(carol);
        g = gasleft();
        ILaunchToken(t[4]).claim();
        _report("LaunchToken.claim (stream running)", g - gasleft(), 4);
        _cool(t[4]);
        vm.prank(mallory);
        g = gasleft();
        ILaunchToken(t[4]).claimFor(bob);
        _report("LaunchToken.claimFor", g - gasleft(), 36);

        // Keeper actions.
        _cool(t[3]);
        vm.prank(keeper);
        g = gasleft();
        buyback.run(t[3]);
        _report("Buyback.run (curve, first run)", g - gasleft(), 36);

        _cool(t[2]);
        g = gasleft();
        split.release(t[2], carol);
        _report("Split.release", g - gasleft(), 68);

        // The graduating buy (the exact fill, the pool seeding and the LP mint).
        _cool(t[3]);
        vm.prank(dave);
        g = gasleft();
        pad.buy(t[3], 1_000_000e6, 0, dave, _now());
        _report("graduating buy (exact fill + seed + LP mint)", g - gasleft(), 164);
        assertTrue(pad.isGraduated(t[3]));

        // Router buy and sell in the pool.
        _cool(t[3]);
        vm.prank(erin);
        g = gasleft();
        router.buy(t[3], 2_000e6, 0, erin, _now());
        _report("router buy", g - gasleft(), 164);
        uint256 some = IERC20(t[3]).balanceOf(dave) / 4;
        _cool(t[3]);
        vm.prank(dave);
        g = gasleft();
        router.sell(t[3], some, 0, dave, _now());
        _report("router sell", g - gasleft(), 164);

        _collect(t[3]);
        _warp(RUN_INTERVAL);
        _cool(t[3]);
        vm.prank(keeper);
        g = gasleft();
        buyback.run(t[3]);
        _report("Buyback.run (pool, through the router)", g - gasleft(), 36);

        // The Holders token graduates with its stream running; pool trades pay for the accrual too.
        _curveBuy(frank, t[4], 1_000_000e6);
        _warp(1 hours);
        _cool(t[4]);
        vm.prank(erin);
        g = gasleft();
        router.buy(t[4], 2_000e6, 0, erin, _now());
        _report("router buy (stream running)", g - gasleft(), 164);
        uint256 quarter = IERC20(t[4]).balanceOf(frank) / 4;
        _cool(t[4]);
        vm.prank(frank);
        g = gasleft();
        router.sell(t[4], quarter, 0, frank, _now());
        _report("router sell (stream running)", g - gasleft(), 164);

        // The heaviest curve sell-out: a run that crosses graduation.
        address x = _launch(Kind.Buyback, 500, 0);
        (,,, uint256 fullCost,) = _expCurveBuy(x, 1e15);
        _curveBuy(bob, x, fullCost - 40e6);
        _collect(x);
        _cool(x);
        vm.prank(keeper);
        g = gasleft();
        buyback.run(x);
        _report("Buyback.run that graduates the token", g - gasleft(), 36);
        assertTrue(pad.isGraduated(x));

        _cool(address(0));
        g = gasleft();
        pad.collectFees();
        _report("collectFees", g - gasleft(), 4);
    }
}
