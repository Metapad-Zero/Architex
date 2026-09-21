// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../launchpad/LaunchpadV13Base.sol";
import {ILaunchFeePlugin} from "../../interfaces/plugins/ILaunchFeePlugin.sol";
import {ISplitPlugin} from "../../interfaces/plugins/ISplitPlugin.sol";
import {IBuybackBurnPlugin} from "../../interfaces/plugins/IBuybackBurnPlugin.sol";
import {IHolderDistributionPlugin} from "../../interfaces/plugins/IHolderDistributionPlugin.sol";
import {IComboPlugin} from "../../interfaces/plugins/IComboPlugin.sol";
import {SplitPlugin} from "../../plugins/launch/SplitPlugin.sol";
import {BuybackBurnPlugin} from "../../plugins/launch/BuybackBurnPlugin.sol";
import {HolderDistributionPlugin} from "../../plugins/launch/HolderDistributionPlugin.sol";
import {ComboPlugin} from "../../plugins/launch/ComboPlugin.sol";

// ═══════════════════════════════════════════════════════════════════════════════
// End-to-end fixture: the REAL launchpad, launch tokens, launch pairs, launch router and the REAL reference plugins.
// Only USDC is a stand-in (LaunchpadV13Base's BlockableUSDC, 6 decimals, with Arc's blocklist behaviour).
//
// Every trade helper recomputes the expected output and both fees from the V13-SPEC formulas (not from the contracts'
// own quotes), checks the quote against them, executes, and checks the deltas. Every collection helper checks that
// exactly the pending creator fees left the launchpad and were credited to the token by its plugin (per Combo entry,
// exactly its slice). _assertSystem() checks whole-system USDC conservation and every contract's own accounting.
//
// Time and block number are read with vm.getBlockTimestamp()/vm.getBlockNumber(): under via-IR the optimizer may
// re-read TIMESTAMP/NUMBER where the source cached them, which is wrong after a vm.warp/vm.roll in the same test.
// ═══════════════════════════════════════════════════════════════════════════════

/// @dev A plain contract wallet without ERC-165 (no supportsInterface at all). Receives USDC by transfer. Any call that
///      reaches it (a hook, say) is counted; the launchpad's ERC-165 probe is a staticcall, which cannot count.
contract E2EPlainWallet {
    uint256 public calls;

    receive() external payable {}

    fallback() external payable {
        calls++;
    }
}

/// @dev Safe-like: answers ERC-165 for IERC165, ERC721TokenReceiver and ERC1155TokenReceiver, as a Safe's
///      CompatibilityFallbackHandler does, but not for IArchitexFeePlugin. Any other call is counted.
contract E2ESafeLikeWallet {
    uint256 public calls;

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 || id == 0x150b7a02 || id == 0x4e2312e0;
    }

    receive() external payable {}

    fallback() external payable {
        calls++;
    }
}

/// @dev A bot that does everything in one transaction: buy, collect the token's creator fees to its plugin, drip and
///      claim, sell everything it bought.
contract E2ESniper {
    function curveAttack(ArchitexLaunchpad pad, HolderDistributionPlugin holder, address token, uint256 usdcIn)
        external
        returns (uint256 bought, uint256 collected, uint256 released, uint256 claimed)
    {
        IERC20(pad.usdc()).approve(address(pad), usdcIn);
        (bought,) = pad.buy(token, usdcIn, 0, address(this));
        collected = pad.collectCreatorFees(token);
        (released, claimed) = holder.dripAndClaim(token);
        pad.sell(token, bought, 0, address(this));
    }

    function poolAttack(
        ArchitexLaunchpad pad,
        LaunchRouter router,
        HolderDistributionPlugin holder,
        address token,
        uint256 usdcIn
    ) external returns (uint256 bought, uint256 collected, uint256 released, uint256 claimed) {
        IERC20(pad.usdc()).approve(address(router), usdcIn);
        bought = router.buy(token, usdcIn, 0, address(this), type(uint256).max);
        collected = pad.collectCreatorFees(token);
        (released, claimed) = holder.dripAndClaim(token);
        router.sell(token, bought, 0, address(this), type(uint256).max);
    }
}

abstract contract E2EBase is LaunchpadV13Base {
    uint256 internal constant LAUNCH_FEE = 1e6; // V13-SPEC §1: 1 USDC
    uint256 internal constant PERIOD = 24 hours; // HolderDistributionPlugin.DRIP_PERIOD
    uint256 internal constant CAP_BPS = 25; // BuybackBurnPlugin.CAP_BPS
    uint256 internal constant FUNDS = 100_000_000e6; // what LaunchpadV13Base._fund mints
    /// @dev How often the site or a keeper drips a Holders stream. The latest Holders plugin covers at most
    ///      MAX_CATCH_UP (1 hour) of stream time per release and pauses an idle stream; dripping at least this often
    ///      keeps it at full speed (with the earlier version any drip releases the linear amount anyway).
    uint256 internal constant KEEPER_INTERVAL = 1 hours;

    enum Kind {
        Eoa,
        Plain,
        SafeLike,
        Split,
        Buyback,
        Holder,
        Combo
    }

    SplitPlugin internal split;
    BuybackBurnPlugin internal buyback;
    HolderDistributionPlugin internal holder;
    ComboPlugin internal combo;
    E2EPlainWallet internal plainWallet;
    E2ESafeLikeWallet internal safeWallet;

    address internal dave = makeAddr("dave");
    address internal erin = makeAddr("erin");
    address internal frank = makeAddr("frank");
    address internal keeper = makeAddr("keeper");

    // ─── Registries ───────────────────────────────────────────────────────────
    address[] internal launched;
    address[] internal usdcAccounts;
    mapping(address => bool) internal isUsdcAccount;
    mapping(address token => address[]) internal holdersOf;
    mapping(address token => mapping(address => bool)) internal isHolderOf;

    // ─── Ghosts (expected values, from the spec formulas) ─────────────────────
    uint256 internal ghostPlatformAccrued;
    uint256 internal ghostPlatformCollected;
    mapping(address token => uint256) internal ghostCreatorAccrued;
    mapping(address token => uint256) internal ghostDelivered;
    mapping(address token => mapping(address target => uint256)) internal ghostSlice;
    mapping(address token => uint256) internal ghostDonated; // delivered straight to a plugin's onFees, not collected
    mapping(address => bool) internal isCombo; // Combo deployments, whose entries _creditedBy looks through

    function setUp() public virtual override {
        usdc = new BlockableUSDC();
        (pad, pairFactory, router) = _deploySuite(address(usdc), LAUNCH_FEE);
        split = new SplitPlugin(address(pad));
        buyback = new BuybackBurnPlugin(address(pad));
        holder = new HolderDistributionPlugin(address(pad));
        combo = new ComboPlugin(address(pad));
        isCombo[address(combo)] = true;
        plainWallet = new E2EPlainWallet();
        safeWallet = new E2ESafeLikeWallet();

        address[21] memory accounts = [
            alice,
            bob,
            carol,
            mallory,
            creatorWallet,
            dave,
            erin,
            frank,
            keeper,
            feeTo,
            setter,
            address(pad),
            address(router),
            address(pairFactory),
            address(split),
            address(buyback),
            address(holder),
            address(combo),
            address(plainWallet),
            address(safeWallet),
            address(this)
        ];
        for (uint256 i; i < accounts.length; ++i) {
            _trackUsdc(accounts[i]);
        }
        _fund(alice);
        _fund(bob);
        _fund(carol);
        _fund(mallory);
        _fund(dave);
        _fund(erin);
        _fund(frank);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Registries
    // ═══════════════════════════════════════════════════════════════════════════

    function _trackUsdc(address a) internal {
        if (isUsdcAccount[a]) return;
        isUsdcAccount[a] = true;
        usdcAccounts.push(a);
    }

    function _addHolder(address token, address who) internal {
        if (isHolderOf[token][who]) return;
        isHolderOf[token][who] = true;
        holdersOf[token].push(who);
    }

    function _register(address token) internal {
        launched.push(token);
        _trackUsdc(token);
        _trackUsdc(pad.pairOf(token));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Time
    // ═══════════════════════════════════════════════════════════════════════════

    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    /// @dev Moves time forward and starts a new block.
    function _warp(uint256 dt) internal {
        vm.warp(vm.getBlockTimestamp() + dt);
        vm.roll(vm.getBlockNumber() + 1);
    }

    function _nextBlock() internal {
        vm.roll(vm.getBlockNumber() + 1);
        vm.warp(vm.getBlockTimestamp() + 2);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Launching
    // ═══════════════════════════════════════════════════════════════════════════

    /// @dev Split used by Kind.Split: carol 5, dave 3, erin 2.
    function _splitData() internal view returns (bytes memory) {
        return abi.encode(_addrs(carol, dave, erin), _uints(5, 3, 2));
    }

    /// @dev Combo used by Kind.Combo: 40% Split (carol 3, dave 1), 30% buyback, 20% holders, 10% the creator wallet.
    function _comboData() internal view returns (bytes memory) {
        return abi.encode(
            _addrs(address(split), address(buyback), address(holder), creatorWallet),
            _u16s(4000, 3000, 2000, 1000),
            _datas(abi.encode(_addrs(carol, dave), _uints(3, 1)), "", "", "")
        );
    }

    function _pluginFor(Kind kind) internal view returns (address plugin, bytes memory data) {
        if (kind == Kind.Eoa) return (creatorWallet, "");
        if (kind == Kind.Plain) return (address(plainWallet), hex"c0ffee"); // no hooks: the data is never delivered
        if (kind == Kind.SafeLike) return (address(safeWallet), hex"c0ffee");
        if (kind == Kind.Split) return (address(split), _splitData());
        if (kind == Kind.Buyback) return (address(buyback), "");
        if (kind == Kind.Holder) return (address(holder), "");
        return (address(combo), _comboData());
    }

    function _kindName(Kind kind) internal pure returns (string memory) {
        if (kind == Kind.Eoa) return "creator wallet (EOA)";
        if (kind == Kind.Plain) return "plain contract (no ERC-165)";
        if (kind == Kind.SafeLike) return "Safe-like wallet";
        if (kind == Kind.Split) return "Split";
        if (kind == Kind.Buyback) return "Buyback & burn";
        if (kind == Kind.Holder) return "Distribute to holders";
        return "Combo";
    }

    function _launch(Kind kind, uint16 bps) internal returns (address) {
        return _launch(kind, bps, 0);
    }

    function _launch(Kind kind, uint16 bps, uint256 initialBuy) internal returns (address) {
        (address plugin, bytes memory data) = _pluginFor(kind);
        return _launchWith(alice, bps, plugin, data, initialBuy);
    }

    /// @dev createToken through the real launchpad, checking the launch fee and the creator's first buy (both fees,
    ///      from the spec formulas on a fresh curve).
    function _launchWith(address creator, uint16 bps, address plugin, bytes memory data, uint256 initialBuy)
        internal
        returns (address token)
    {
        uint256 ePlatform;
        uint256 eCreator;
        uint256 eSpent;
        uint256 eTokens;
        if (initialBuy != 0) {
            (eTokens, ePlatform, eCreator, eSpent,) =
                _calcCurveBuy(VIRTUAL_USDC_0, VIRTUAL_TOKENS_0, CURVE_SUPPLY, initialBuy, bps);
        }
        uint256 pendingBefore = pad.pendingFees();
        uint256 usdcBefore = usdc.balanceOf(creator);
        vm.prank(creator);
        token = pad.createToken("E2E Token", "E2E", "ipfs://e2e", bps, plugin, data, initialBuy, 0, LAUNCH_FEE);
        _register(token);

        assertEq(pad.pluginOf(token), plugin, "plugin locked in");
        assertEq(pad.creatorFeeBpsOf(token), bps, "creator fee locked in");
        assertEq(pad.pendingFees() - pendingBefore, LAUNCH_FEE + ePlatform, "launch fee + first-buy platform fee");
        assertEq(pad.pendingCreatorFees(token), eCreator, "the creator's own first buy pays the creator fee [D3]");
        assertEq(usdcBefore - usdc.balanceOf(creator), LAUNCH_FEE + eSpent, "creator paid the launch fee + first buy");
        assertEq(IERC20(token).balanceOf(creator), eTokens);
        ghostPlatformAccrued += LAUNCH_FEE + ePlatform;
        ghostCreatorAccrued[token] += eCreator;
        if (initialBuy != 0) _addHolder(token, creator);
        _assertSolvent();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Spec math (V13-SPEC §5, §4), written from the spec, independent of the contracts' quotes
    // ═══════════════════════════════════════════════════════════════════════════

    function _calcCurveBuy(uint256 vU, uint256 vT, uint256 remaining, uint256 usdcIn, uint256 bps)
        internal
        pure
        returns (uint256 tokensOut, uint256 platformFee, uint256 creatorFee, uint256 spent, bool graduates)
    {
        uint256 k = vU * vT;
        platformFee = _divCeil(usdcIn * FEE_BPS, BPS);
        creatorFee = _divCeil(usdcIn * bps, BPS);
        require(platformFee + creatorFee < usdcIn, "fees eat the whole input");
        uint256 net = usdcIn - platformFee - creatorFee;
        tokensOut = vT - _divCeil(k, vU + net);
        if (tokensOut >= remaining) {
            // Exact fill: gross = net + ceil(net*(50+c)/(1e4-(50+c))), capped at usdcIn; totalFee split
            // platform = ceil(totalFee*50/(50+c)), creator = the rest.
            uint256 f = FEE_BPS + bps;
            net = _divCeil(k, vT - remaining) - vU;
            uint256 gross = net + _divCeil(net * f, BPS - f);
            spent = gross < usdcIn ? gross : usdcIn;
            uint256 totalFee = spent - net;
            platformFee = _divCeil(totalFee * FEE_BPS, f);
            creatorFee = totalFee - platformFee;
            tokensOut = remaining;
            graduates = true;
        } else {
            spent = usdcIn;
        }
    }

    function _expCurveBuy(address token, uint256 usdcIn)
        internal
        view
        returns (uint256 tokensOut, uint256 platformFee, uint256 creatorFee, uint256 spent, bool graduates)
    {
        IArchitexLaunchpad.Curve memory c = pad.curves(token);
        return _calcCurveBuy(
            c.virtualUsdc, c.virtualTokens, CURVE_SUPPLY - uint256(c.tokensSold), usdcIn, c.creatorFeeBps
        );
    }

    function _expCurveSell(address token, uint256 tokensIn)
        internal
        view
        returns (uint256 gross, uint256 platformFee, uint256 creatorFee, uint256 out)
    {
        IArchitexLaunchpad.Curve memory c = pad.curves(token);
        uint256 k = uint256(c.virtualUsdc) * uint256(c.virtualTokens);
        gross = uint256(c.virtualUsdc) - _divCeil(k, uint256(c.virtualTokens) + tokensIn);
        platformFee = _divCeil(gross * FEE_BPS, BPS);
        creatorFee = _divCeil(gross * c.creatorFeeBps, BPS);
        out = gross - platformFee - creatorFee;
    }

    function _reserves(address token) internal view returns (uint256 reserveToken, uint256 reserveUsdc) {
        (uint112 rt, uint112 ru,) = _pairOf(token).getReserves();
        return (rt, ru);
    }

    function _expPoolBuy(address token, uint256 usdcIn)
        internal
        view
        returns (uint256 tokensOut, uint256 platformFee, uint256 creatorFee, uint256 net)
    {
        (uint256 rt, uint256 ru) = _reserves(token);
        platformFee = _divCeil(usdcIn * FEE_BPS, BPS);
        creatorFee = _divCeil(usdcIn * pad.creatorFeeBpsOf(token), BPS);
        net = usdcIn - platformFee - creatorFee;
        tokensOut = net * rt / (ru + net);
    }

    function _expPoolSell(address token, uint256 tokensIn)
        internal
        view
        returns (uint256 gross, uint256 platformFee, uint256 creatorFee, uint256 out)
    {
        (uint256 rt, uint256 ru) = _reserves(token);
        gross = tokensIn * ru / (rt + tokensIn);
        platformFee = _divCeil(gross * FEE_BPS, BPS);
        creatorFee = _divCeil(gross * pad.creatorFeeBpsOf(token), BPS);
        out = gross - platformFee - creatorFee;
    }

    /// @dev Both fees never round in the trader's favour (V13-SPEC §1, §6.4). On a normal trade each fee is exactly the
    ///      rounded-up share of the gross; on the exact-fill buy the total is at least the exact total share and the
    ///      platform fee at least its exact share (the creator fee is "the rest", V13-SPEC §5).
    function _assertFeeRounding(uint256 gross, uint256 platformFee, uint256 creatorFee, uint256 bps, bool exactFill)
        internal
        pure
    {
        assertGe(platformFee * BPS, gross * FEE_BPS, "platform fee >= its exact share");
        assertGe((platformFee + creatorFee) * BPS, gross * (FEE_BPS + bps), "fees >= their exact share");
        if (!exactFill) {
            assertEq(platformFee, _divCeil(gross * FEE_BPS, BPS), "platform = ceil(gross*50/1e4)");
            assertEq(creatorFee, _divCeil(gross * bps, BPS), "creator = ceil(gross*c/1e4)");
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Checked trades
    // ═══════════════════════════════════════════════════════════════════════════

    /// @dev Expected outcome of one trade, from the spec formulas.
    struct Exp {
        uint256 tokens; // tokens out (buy) or in (sell)
        uint256 platform;
        uint256 creator;
        uint256 gross; // USDC paid (buy: usdcSpent) or leaving the curve/pool (sell)
        uint256 out; // USDC to the seller
        uint256 net; // USDC reaching the curve/pool on a buy
        bool graduates;
    }

    /// @dev State before a trade.
    struct Snap {
        uint256 pending;
        uint256 creatorPending;
        uint256 usdc;
        uint256 tokens;
        uint256 reserveToken;
        uint256 reserveUsdc;
        uint256 virtualUsdc;
    }

    function _snap(address who, address token) internal view returns (Snap memory s) {
        s.pending = pad.pendingFees();
        s.creatorPending = pad.pendingCreatorFees(token);
        s.usdc = usdc.balanceOf(who);
        s.tokens = IERC20(token).balanceOf(who);
        (s.reserveToken, s.reserveUsdc) = _reserves(token);
        s.virtualUsdc = pad.virtualUsdcOf(token);
    }

    /// @dev Both fees accrued exactly as expected, to the traded token; the ghosts follow.
    function _assertAccrued(Snap memory s, address token, Exp memory e, string memory what) internal {
        assertEq(pad.pendingFees() - s.pending, e.platform, string.concat(what, ": platform fee accrued"));
        assertEq(pad.pendingCreatorFees(token) - s.creatorPending, e.creator, string.concat(what, ": creator fee accrued"));
        ghostPlatformAccrued += e.platform;
        ghostCreatorAccrued[token] += e.creator;
    }

    function _buy(address who, address token, uint256 usdcIn) internal returns (uint256 tokensOut) {
        if (pad.isGraduated(token)) return _poolBuy(who, token, usdcIn);
        (tokensOut,) = _curveBuy(who, token, usdcIn);
    }

    function _sell(address who, address token, uint256 tokensIn) internal returns (uint256 usdcOut) {
        if (pad.isGraduated(token)) return _poolSell(who, token, tokensIn);
        return _curveSell(who, token, tokensIn);
    }

    function _curveBuyExp(address token, uint256 usdcIn) internal view returns (Exp memory e) {
        (e.tokens, e.platform, e.creator, e.gross, e.graduates) = _expCurveBuy(token, usdcIn);
        e.net = e.gross - e.platform - e.creator;
        (uint256 qTokens, uint256 qPlatform, uint256 qCreator, uint256 qSpent, bool qGrad) = pad.quoteBuy(token, usdcIn);
        assertEq(qTokens, e.tokens, "curve quoteBuy tokens");
        assertEq(qPlatform, e.platform, "curve quoteBuy platform fee");
        assertEq(qCreator, e.creator, "curve quoteBuy creator fee");
        assertEq(qSpent, e.gross, "curve quoteBuy spent");
        assertEq(qGrad, e.graduates, "curve quoteBuy graduates");
        _assertFeeRounding(e.gross, e.platform, e.creator, pad.creatorFeeBpsOf(token), e.graduates);
    }

    function _curveBuy(address who, address token, uint256 usdcIn) internal returns (uint256 tokensOut, uint256 spent) {
        Exp memory e = _curveBuyExp(token, usdcIn);
        Snap memory s = _snap(who, token);
        uint256 seed = s.virtualUsdc + e.net - VIRTUAL_USDC_0;
        _expectCurveTrade(token, who, true, e);
        if (e.graduates) _expectGraduated(token, seed);
        vm.prank(who);
        (tokensOut, spent) = pad.buy(token, usdcIn, e.tokens, who);

        assertEq(tokensOut, e.tokens, "curve buy tokens out");
        assertEq(spent, e.gross, "curve buy usdcSpent");
        assertLe(spent, usdcIn, "never more than offered");
        assertEq(pad.virtualUsdcOf(token), s.virtualUsdc + e.net, "the net reached the curve");
        assertEq(s.usdc - usdc.balanceOf(who), e.gross, "curve buy: pulled exactly usdcSpent");
        assertEq(IERC20(token).balanceOf(who) - s.tokens, e.tokens, "curve buy: tokens delivered");
        _assertAccrued(s, token, e, "curve buy");
        _addHolder(token, who);
        if (e.graduates) _assertGraduated(token, seed);
    }

    function _curveSellExp(address token, uint256 tokensIn) internal view returns (Exp memory e) {
        e.tokens = tokensIn;
        (e.gross, e.platform, e.creator, e.out) = _expCurveSell(token, tokensIn);
        _checkSellQuote(token, tokensIn, e, false);
        _assertFeeRounding(e.gross, e.platform, e.creator, pad.creatorFeeBpsOf(token), false);
    }

    function _curveSell(address who, address token, uint256 tokensIn) internal returns (uint256 usdcOut) {
        Exp memory e = _curveSellExp(token, tokensIn);
        Snap memory s = _snap(who, token);
        _expectCurveTrade(token, who, false, e);
        vm.prank(who);
        usdcOut = pad.sell(token, tokensIn, e.out, who);
        _verifyCurveSell(who, token, usdcOut, e, s);
    }

    function _verifyCurveSell(address who, address token, uint256 usdcOut, Exp memory e, Snap memory s) internal {
        assertEq(usdcOut, e.out, "curve sell out");
        assertEq(pad.virtualUsdcOf(token), s.virtualUsdc - e.gross, "the gross left the curve");
        assertEq(usdc.balanceOf(who) - s.usdc, e.out, "curve sell: seller got gross - fees");
        assertEq(s.tokens - IERC20(token).balanceOf(who), e.tokens, "curve sell: tokens pulled");
        _assertAccrued(s, token, e, "curve sell");
    }

    function _poolBuy(address who, address token, uint256 usdcIn) internal returns (uint256 tokensOut) {
        Exp memory e;
        e.gross = usdcIn;
        (e.tokens, e.platform, e.creator, e.net) = _expPoolBuy(token, usdcIn);
        _checkPoolBuyQuote(token, usdcIn, e);
        _assertFeeRounding(usdcIn, e.platform, e.creator, pad.creatorFeeBpsOf(token), false);
        Snap memory s = _snap(who, token);
        _expectPoolTrade(token, who, true, e);

        vm.prank(who);
        tokensOut = router.buy(token, usdcIn, e.tokens, who, _now());

        assertEq(tokensOut, e.tokens, "router buy = quote");
        (uint256 rtAfter, uint256 ruAfter) = _reserves(token);
        assertEq(ruAfter, s.reserveUsdc + e.net, "only the net reaches the pool");
        assertEq(rtAfter, s.reserveToken - e.tokens);
        assertEq(s.usdc - usdc.balanceOf(who), usdcIn, "router buy: exact in");
        assertEq(IERC20(token).balanceOf(who) - s.tokens, e.tokens);
        assertEq(usdc.balanceOf(address(router)), 0, "the router keeps nothing");
        _assertAccrued(s, token, e, "router buy");
        _addHolder(token, who);
    }

    function _poolSellExp(address token, uint256 tokensIn) internal view returns (Exp memory e) {
        e.tokens = tokensIn;
        (e.gross, e.platform, e.creator, e.out) = _expPoolSell(token, tokensIn);
        _checkSellQuote(token, tokensIn, e, true);
        _assertFeeRounding(e.gross, e.platform, e.creator, pad.creatorFeeBpsOf(token), false);
    }

    function _poolSell(address who, address token, uint256 tokensIn) internal returns (uint256 usdcOut) {
        Exp memory e = _poolSellExp(token, tokensIn);
        Snap memory s = _snap(who, token);
        _expectPoolTrade(token, who, false, e);
        vm.prank(who);
        usdcOut = router.sell(token, tokensIn, e.out, who, _now());
        _verifyPoolSell(who, token, usdcOut, e, s);
    }

    function _verifyPoolSell(address who, address token, uint256 usdcOut, Exp memory e, Snap memory s) internal {
        assertEq(usdcOut, e.out, "router sell = quote");
        (uint256 rtAfter, uint256 ruAfter) = _reserves(token);
        assertEq(ruAfter, s.reserveUsdc - e.gross, "the gross left the pool");
        assertEq(rtAfter, s.reserveToken + e.tokens);
        assertEq(usdc.balanceOf(who) - s.usdc, e.out, "router sell: seller got gross - fees");
        assertEq(s.tokens - IERC20(token).balanceOf(who), e.tokens);
        assertEq(usdc.balanceOf(address(router)), 0, "the router keeps nothing");
        assertEq(IERC20(token).balanceOf(address(router)), 0);
        _assertAccrued(s, token, e, "router sell");
    }

    /// @dev The quote (launchpad on the curve, router in the pool) equals the spec's expectation.
    function _checkSellQuote(address token, uint256 tokensIn, Exp memory e, bool pool) internal view {
        (uint256 qOut, uint256 qPlatform, uint256 qCreator) =
            pool ? router.quoteSell(token, tokensIn) : pad.quoteSell(token, tokensIn);
        assertEq(qOut, e.out, "quoteSell out");
        assertEq(qPlatform, e.platform, "quoteSell platform fee");
        assertEq(qCreator, e.creator, "quoteSell creator fee");
    }

    function _checkPoolBuyQuote(address token, uint256 usdcIn, Exp memory e) internal view {
        (uint256 qTokens, uint256 qPlatform, uint256 qCreator) = router.quoteBuy(token, usdcIn);
        assertEq(qTokens, e.tokens, "router quoteBuy tokens");
        assertEq(qPlatform, e.platform, "router quoteBuy platform fee");
        assertEq(qCreator, e.creator, "router quoteBuy creator fee");
    }

    /// @dev The launchpad's Trade event: gross USDC, tokens, both fees, and the curve's new virtual reserves.
    function _expectCurveTrade(address token, address trader, bool isBuy, Exp memory e) internal {
        IArchitexLaunchpad.Curve memory c = pad.curves(token);
        uint256 vU = isBuy ? uint256(c.virtualUsdc) + e.net : uint256(c.virtualUsdc) - e.gross;
        uint256 vT = isBuy ? uint256(c.virtualTokens) - e.tokens : uint256(c.virtualTokens) + e.tokens;
        vm.expectEmit(true, true, false, true, address(pad));
        emit Trade(token, trader, isBuy, e.gross, e.tokens, e.platform, e.creator, vU, vT);
    }

    /// @dev The router's PoolTrade, then the launchpad's PoolFeesAccrued with the same two fees.
    function _expectPoolTrade(address token, address trader, bool isBuy, Exp memory e) internal {
        vm.expectEmit(true, true, false, true, address(router));
        emit LaunchRouter.PoolTrade(token, trader, isBuy, e.gross, e.tokens, e.platform, e.creator);
        vm.expectEmit(true, false, false, true, address(pad));
        emit IArchitexLaunchpad.PoolFeesAccrued(token, e.platform, e.creator);
    }

    function _expectGraduated(address token, uint256 seed) internal {
        vm.expectEmit(true, true, false, true, address(pad));
        emit IArchitexLaunchpad.Graduated(token, pad.pairOf(token), seed, POOL_SUPPLY, Math.sqrt(POOL_SUPPLY * seed) - 1000);
    }

    /// @dev Buys the rest of the curve with a large offer (the exact-fill buy), graduating the token.
    function _graduateVia(address who, address token) internal returns (uint256 tokensOut, uint256 spent) {
        (tokensOut, spent) = _curveBuy(who, token, 1_000_000e6);
        assertTrue(pad.isGraduated(token), "graduated");
    }

    /// @dev V13-SPEC §5 graduation, as v1.2, into the launch pair: POOL_SUPPLY tokens and exactly the curve's real USDC
    ///      (virtualUsdc - VIRTUAL_USDC_0, ~25,000 USDC), LP minted to the burn address, the launchpad keeps nothing.
    function _assertGraduated(address token, uint256 seed) internal view {
        LaunchPair pair = _pairOf(token);
        IArchitexLaunchpad.Curve memory c = pad.curves(token);
        (uint256 rt, uint256 ru) = _reserves(token);
        assertTrue(c.graduated && ILaunchToken(token).graduated(), "graduated on both");
        assertEq(pairFactory.getPair(token), address(pair), "the factory's launch pair");
        assertEq(pair.token(), token);
        assertEq(pair.usdc(), address(usdc));
        assertEq(pair.router(), address(router), "swaps only through the launch router");
        assertEq(pair.factory(), address(pairFactory));
        assertEq(uint256(c.tokensSold), CURVE_SUPPLY, "the whole curve sold");
        assertEq(rt, POOL_SUPPLY, "pool seeded with POOL_SUPPLY tokens");
        assertEq(ru, seed, "pool seeded with exactly the curve's USDC");
        assertEq(uint256(c.virtualUsdc) - VIRTUAL_USDC_0, seed, "seed = virtualUsdc - VIRTUAL_USDC_0");
        assertEq(usdc.balanceOf(address(pair)), seed);
        assertEq(IERC20(token).balanceOf(address(pair)), POOL_SUPPLY);
        assertApproxEqAbs(seed, 25_000e6, 1e6, "a curve raises ~25,000 USDC");
        uint256 lp = Math.sqrt(POOL_SUPPLY * seed);
        assertEq(pair.totalSupply(), lp, "first mint: sqrt(tokens * usdc)");
        assertEq(pair.balanceOf(DEAD), lp, "all graduation LP locked at the burn address");
        assertEq(IERC20(token).balanceOf(address(pad)), 0, "the launchpad keeps no tokens");
        // The pool opens at the curve's final price.
        assertApproxEqRel(ru * uint256(c.virtualTokens), uint256(c.virtualUsdc) * rt, 1e12, "price continuity");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Checked collections
    // ═══════════════════════════════════════════════════════════════════════════

    /// @dev What `target` has been credited for `token`, from its own accounting (a plain address: its USDC balance).
    function _creditedBy(address target, address token) internal view returns (uint256) {
        if (target == address(split)) return split.totalReceived(token);
        if (target == address(buyback)) return buyback.usdcHeld(token) + buyback.totalUsdcSpent(token);
        if (target == address(holder)) return holder.unreleased(token) + holder.totalDistributed(token);
        if (isCombo[target]) {
            (address[] memory targets,,) = IComboPlugin(target).allocationOf(token);
            uint256 sum = usdc.balanceOf(target);
            for (uint256 i; i < targets.length; ++i) {
                sum += _creditedBy(targets[i], token);
            }
            return sum;
        }
        return usdc.balanceOf(target);
    }

    function _hookCalls(address target) internal view returns (uint256) {
        if (target == address(plainWallet)) return plainWallet.calls();
        if (target == address(safeWallet)) return safeWallet.calls();
        return 0;
    }

    /// @dev collectCreatorFees(token), by a keeper: exactly the pending creator fees leave the launchpad and are
    ///      credited to the token by its plugin (onFees with an exact pull), or transferred to a plain address. For a
    ///      Combo, each entry is credited exactly its previewSplit slice.
    function _collect(address token) internal returns (uint256 amount) {
        address plugin = pad.pluginOf(token);
        bool hooks = pad.curves(token).pluginHooks;
        uint256 owed = pad.pendingCreatorFees(token);
        uint256 padBefore = usdc.balanceOf(address(pad));
        uint256 creditedBefore = _creditedBy(plugin, token);
        uint256 hookCallsBefore = _hookCalls(plugin);

        address[] memory targets;
        uint256[] memory entryBefore;
        uint256[] memory slices;
        if (plugin == address(combo)) {
            (targets,,) = combo.allocationOf(token);
            slices = combo.previewSplit(token, owed);
            entryBefore = new uint256[](targets.length);
            for (uint256 i; i < targets.length; ++i) {
                entryBefore[i] = _creditedBy(targets[i], token);
            }
        }

        if (owed != 0) {
            vm.expectEmit(true, true, false, true, address(pad));
            emit IArchitexLaunchpad.CreatorFeesCollected(token, plugin, owed);
            if (hooks && (_isReference(plugin) || isCombo[plugin])) {
                vm.expectEmit(true, true, false, true, plugin);
                emit ILaunchFeePlugin.FeesReceived(token, address(pad), owed);
            }
        }
        vm.recordLogs();
        vm.prank(keeper);
        amount = pad.collectCreatorFees(token);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(amount, owed, "collected exactly the pending creator fees");
        assertEq(pad.pendingCreatorFees(token), 0, "nothing left pending");
        assertEq(padBefore - usdc.balanceOf(address(pad)), owed, "exactly that left the launchpad");
        assertEq(usdc.allowance(address(pad), plugin), 0, "no allowance left behind");
        assertEq(_creditedBy(plugin, token) - creditedBefore, owed, "the plugin was credited exactly the fees");
        assertEq(_hookCalls(plugin), hookCallsBefore, "a plain address gets no hook call");
        if (owed == 0) {
            for (uint256 i; i < logs.length; ++i) {
                assertTrue(logs[i].emitter != plugin, "nothing to collect: the plugin is not called");
            }
        }
        if (plugin == address(combo)) {
            uint256 sum;
            for (uint256 i; i < targets.length; ++i) {
                uint256 got = _creditedBy(targets[i], token) - entryBefore[i];
                assertEq(got, slices[i], "each Combo entry got exactly its slice");
                ghostSlice[token][targets[i]] += got;
                sum += got;
            }
            assertEq(sum, owed, "slices sum to the amount");
            assertEq(usdc.balanceOf(address(combo)), 0, "the Combo keeps nothing");
        }
        ghostDelivered[token] += amount;
    }

    /// @dev Anyone may deliver fees straight to a plugin's onFees with their own USDC; the plugin pulls exactly that
    ///      and credits it to the token (LaunchFeePluginBase). Used to fund a plugin when the creator fee is 0.
    function _donate(address plugin, address token, address from, uint256 amount) internal {
        uint256 before = _creditedBy(plugin, token);
        vm.startPrank(from);
        usdc.approve(plugin, amount);
        IArchitexFeePlugin(plugin).onFees(token, amount);
        vm.stopPrank();
        assertEq(_creditedBy(plugin, token) - before, amount, "a direct delivery is credited exactly");
        assertEq(usdc.allowance(from, plugin), 0, "and pulled exactly");
        ghostDonated[token] += amount;
    }

    function _collectFees() internal returns (uint256 amount) {
        uint256 owed = pad.pendingFees();
        uint256 before = usdc.balanceOf(feeTo);
        vm.prank(keeper);
        amount = pad.collectFees();
        assertEq(amount, owed, "all platform fees");
        assertEq(usdc.balanceOf(feeTo) - before, owed, "platform fees reach feeTo");
        assertEq(pad.pendingFees(), 0);
        ghostPlatformCollected += amount;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Checked plugin actions
    // ═══════════════════════════════════════════════════════════════════════════

    /// @dev State of a buyback before a run.
    struct RunSnap {
        uint256 held;
        uint256 cap;
        uint256 supply;
        uint256 dead;
        uint256 usdc;
        uint256 spent;
        uint256 burned;
        uint256 seed;
        bool graduated;
    }

    /// @dev What a run should do, from the spec formulas: offer min(held, cap), buy on the curve or in the pool.
    function _runExpectation(address token) internal view returns (Exp memory e, RunSnap memory r) {
        r.graduated = pad.isGraduated(token);
        r.held = buyback.usdcHeld(token);
        uint256 reserve;
        if (r.graduated) (, reserve) = _reserves(token);
        else reserve = pad.virtualUsdcOf(token);
        r.cap = reserve * CAP_BPS / BPS;
        uint256 offer = r.held < r.cap ? r.held : r.cap;
        (uint256 pOffer, bool pGrad) = buyback.previewRun(token);
        assertEq(pOffer, offer, "previewRun = min(held, cap)");
        assertEq(pGrad, r.graduated);
        if (r.graduated) {
            (e.tokens, e.platform, e.creator, e.net) = _expPoolBuy(token, offer);
            e.gross = offer;
        } else {
            (e.tokens, e.platform, e.creator, e.gross, e.graduates) = _expCurveBuy(token, offer);
            e.net = e.gross - e.platform - e.creator;
            r.seed = pad.virtualUsdcOf(token) + e.net - VIRTUAL_USDC_0;
        }
        r.supply = IERC20(token).totalSupply();
        r.dead = IERC20(token).balanceOf(DEAD);
        r.usdc = usdc.balanceOf(address(buyback));
        r.spent = buyback.totalUsdcSpent(token);
        r.burned = buyback.totalTokensBurned(token);
    }

    /// @dev The events of a run, in order: the buyback's own trade (with both fees), BuybackRun, the burn.
    function _expectRunEvents(address token, Exp memory e, bool graduated) internal {
        if (graduated) _expectPoolTrade(token, address(buyback), true, e);
        else _expectCurveTrade(token, address(buyback), true, e);
        vm.expectEmit(true, true, false, true, address(buyback));
        emit IBuybackBurnPlugin.BuybackRun(token, keeper, graduated, e.gross, e.tokens);
        vm.expectEmit(true, true, false, true, token);
        emit IERC20.Transfer(address(buyback), address(0), e.tokens);
    }

    /// @dev buyback.run(token) by a keeper: spends min(held, 0.25% of the USDC-side reserve) (less on the curve's
    ///      sell-out buy), buys through the launchpad on the curve or the router in the pool, pays both fees like any
    ///      trade, and burns every token bought (supply falls; nobody, not even the burn address, receives them).
    function _run(address token) internal returns (uint256 spent, uint256 burned) {
        (Exp memory e, RunSnap memory r) = _runExpectation(token);
        Snap memory s = _snap(address(buyback), token);
        _expectRunEvents(token, e, r.graduated);
        vm.prank(keeper);
        (spent, burned) = buyback.run(token);

        assertEq(spent, e.gross, "run spent");
        assertEq(burned, e.tokens, "run burned exactly what it bought");
        assertLe(spent, r.cap, "a run spends at most 0.25% of the USDC-side reserve");
        assertEq(IERC20(token).totalSupply(), r.supply - burned, "a true burn: total supply falls");
        assertEq(IERC20(token).balanceOf(address(buyback)), 0, "the plugin keeps no tokens");
        assertEq(IERC20(token).balanceOf(DEAD), r.dead, "not parked at the burn address");
        assertEq(buyback.usdcHeld(token), r.held - spent, "held falls by the spend");
        assertEq(r.usdc - usdc.balanceOf(address(buyback)), spent, "exactly the spend left the plugin");
        assertEq(buyback.totalUsdcSpent(token) - r.spent, spent);
        assertEq(buyback.totalTokensBurned(token) - r.burned, burned);
        assertEq(usdc.allowance(address(buyback), address(pad)), 0, "no allowance left to the launchpad");
        assertEq(usdc.allowance(address(buyback), address(router)), 0, "no allowance left to the router");
        assertEq(buyback.nextRunBlock(token), vm.getBlockNumber() + 1, "once per block");
        _assertAccrued(s, token, e, "the buyback's own trade");
        if (e.graduates) _assertGraduated(token, r.seed);
    }

    /// @dev holder.drip(token) by a keeper: releases exactly releasable(), which goes into the token's dividends.
    function _drip(address token) internal returns (uint256 released) {
        uint256 expected = holder.releasable(token);
        uint256 unreleasedBefore = holder.unreleased(token);
        uint256 distributedBefore = holder.totalDistributed(token);
        uint256 tokenDistributedBefore = ILaunchToken(token).totalDistributed();
        vm.prank(keeper);
        released = holder.drip(token);
        assertEq(released, expected, "drip releases what releasable() said");
        assertLe(released, unreleasedBefore, "never more than unreleased");
        assertEq(holder.unreleased(token), unreleasedBefore - released);
        assertEq(holder.totalDistributed(token) - distributedBefore, released);
        assertEq(ILaunchToken(token).totalDistributed() - tokenDistributedBefore, released, "into the dividends");
        assertEq(holder.releasable(token), 0, "nothing more in the same block");
        assertEq(usdc.allowance(address(holder), token), 0);
    }

    /// @dev A keeper dripping every KEEPER_INTERVAL for `duration` (each drip checked by _drip).
    function _dripEvery(address token, uint256 duration) internal returns (uint256 released) {
        for (uint256 t; t < duration; t += KEEPER_INTERVAL) {
            _warp(KEEPER_INTERVAL);
            released += _drip(token);
        }
    }

    function _claim(address token, address who) internal returns (uint256 amount) {
        uint256 owed = ILaunchToken(token).claimable(who);
        uint256 before = usdc.balanceOf(who);
        vm.prank(who);
        amount = ILaunchToken(token).claim();
        assertEq(amount, owed);
        assertEq(usdc.balanceOf(who) - before, owed);
        assertEq(ILaunchToken(token).claimable(who), 0);
    }

    function _releaseAll(address token) internal {
        (address[] memory payees,) = split.payeesOf(token);
        for (uint256 i; i < payees.length; ++i) {
            uint256 owed = split.releasable(token, payees[i]);
            if (owed == 0) continue;
            uint256 before = usdc.balanceOf(payees[i]);
            vm.prank(mallory); // anyone may release; the payee is paid
            assertEq(split.release(token, payees[i]), owed);
            assertEq(usdc.balanceOf(payees[i]) - before, owed);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Whole-system accounting
    // ═══════════════════════════════════════════════════════════════════════════

    /// @dev Every USDC unit ever minted sits with a tracked actor or contract.
    function _assertUsdcConserved() internal view {
        uint256 sum;
        for (uint256 i; i < usdcAccounts.length; ++i) {
            sum += usdc.balanceOf(usdcAccounts[i]);
        }
        assertEq(sum, usdc.totalSupply(), "USDC conservation: minted == sum of every balance");
    }

    /// @dev USDC conservation, plus every contract's balance equals its own accounting, plus the fee ghosts.
    function _assertSystem() internal view {
        _assertSolvent(); // launchpad: pendingFees + Σ pendingCreatorFees + Σ live curve floats
        assertEq(usdc.balanceOf(address(router)), 0, "router holds nothing");
        assertEq(usdc.balanceOf(address(combo)), 0, "Combo holds nothing");
        assertEq(usdc.balanceOf(address(pairFactory)), 0);
        assertEq(ghostPlatformAccrued, ghostPlatformCollected + pad.pendingFees(), "platform fees: accrued = collected + pending");

        uint256 splitHeld;
        uint256 buybackHeld;
        uint256 holderHeld;
        for (uint256 i; i < launched.length; ++i) {
            address t = launched[i];
            (uint256 rt, uint256 ru) = _reserves(t);
            assertEq(usdc.balanceOf(pad.pairOf(t)), ru, "pool USDC == its reserve");
            assertEq(IERC20(t).balanceOf(pad.pairOf(t)), rt, "pool tokens == its reserve");
            if (split.isConfigured(t)) {
                splitHeld += split.usdcHeld(t);
                assertEq(split.usdcHeld(t), split.totalReceived(t) - split.totalReleased(t));
            }
            if (buyback.isConfigured(t)) buybackHeld += buyback.usdcHeld(t);
            if (holder.isConfigured(t)) {
                holderHeld += holder.unreleased(t);
                assertEq(holder.totalDistributed(t), ILaunchToken(t).totalDistributed(), "only the plugin distributes");
            }
            _assertDividendPool(t);
            _assertTokenSupply(t);
            assertEq(ghostCreatorAccrued[t], ghostDelivered[t] + pad.pendingCreatorFees(t), "creator fees: accrued = delivered + pending");
            address plugin = pad.pluginOf(t);
            if (plugin == address(split) || plugin == address(buyback) || plugin == address(holder)) {
                assertEq(_creditedBy(plugin, t), ghostDelivered[t] + ghostDonated[t], "plugin credited == delivered");
            } else if (plugin == address(combo)) {
                (address[] memory targets,, bool[] memory isPlugin) = combo.allocationOf(t);
                for (uint256 j; j < targets.length; ++j) {
                    if (isPlugin[j] && _isReference(targets[j])) {
                        assertEq(_creditedBy(targets[j], t), ghostSlice[t][targets[j]], "entry credited == its slices");
                    }
                }
            }
        }
        assertEq(usdc.balanceOf(address(split)), splitHeld, "Split USDC == its per-token balances");
        assertEq(usdc.balanceOf(address(buyback)), buybackHeld, "Buyback USDC == its per-token balances");
        assertEq(usdc.balanceOf(address(holder)), holderHeld, "Holder plugin USDC == its per-token unreleased");
        _assertUsdcConserved();
    }

    function _isReference(address a) internal view returns (bool) {
        return a == address(split) || a == address(buyback) || a == address(holder);
    }

    /// @dev The token's USDC is exactly its unclaimed dividends; holders' claimable never exceeds it and falls short by
    ///      at most one unit per holder; the four excluded accounts never earn.
    function _assertDividendPool(address t) internal view {
        ILaunchToken lt = ILaunchToken(t);
        uint256 claimedSum;
        uint256 claimableSum;
        address[] storage hs = holdersOf[t];
        for (uint256 j; j < hs.length; ++j) {
            claimedSum += lt.claimed(hs[j]);
            claimableSum += lt.claimable(hs[j]);
        }
        uint256 pool = usdc.balanceOf(t);
        assertEq(pool, lt.totalDistributed() - claimedSum, "token USDC == distributed - claimed");
        assertLe(claimableSum, pool, "claims never exceed the pool");
        assertLe(pool - claimableSum, hs.length + 1, "rounding dust: at most a unit per holder");
        assertEq(lt.claimable(address(pad)), 0, "the curve inventory never earns");
        assertEq(lt.claimable(pad.pairOf(t)), 0, "the launch pair never earns");
        assertEq(lt.claimable(DEAD), 0, "the burn address never earns");
        assertEq(lt.claimable(address(0)), 0, "address(0) never earns");
        assertEq(
            lt.eligibleSupply() == 0 ? 0 : lt.eligibleSupply(),
            _eligible(t),
            "eligible = supply - launchpad - pair - dead"
        );
    }

    /// @dev Every token is with a known holder, the curve inventory, the pool or the burn address; the plugins keep
    ///      none (a buyback burns what it buys in the same call).
    function _assertTokenSupply(address t) internal view {
        IERC20 tok = IERC20(t);
        uint256 sum = tok.balanceOf(address(pad)) + tok.balanceOf(pad.pairOf(t)) + tok.balanceOf(DEAD);
        address[] storage hs = holdersOf[t];
        for (uint256 j; j < hs.length; ++j) {
            sum += tok.balanceOf(hs[j]);
        }
        assertEq(sum, tok.totalSupply(), "every token accounted for");
        assertEq(tok.balanceOf(address(buyback)) + tok.balanceOf(address(split)) + tok.balanceOf(address(holder))
            + tok.balanceOf(address(combo)), 0, "plugins hold no tokens");
    }

    function _eligible(address t) internal view returns (uint256 e) {
        IERC20 tok = IERC20(t);
        e = tok.totalSupply() - tok.balanceOf(address(pad)) - tok.balanceOf(pad.pairOf(t)) - tok.balanceOf(DEAD);
        if (e < 1e18) e = 0;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Array helpers
    // ═══════════════════════════════════════════════════════════════════════════

    function _addrs(address a) internal pure returns (address[] memory r) {
        r = new address[](1);
        r[0] = a;
    }

    function _addrs(address a, address b) internal pure returns (address[] memory r) {
        r = new address[](2);
        (r[0], r[1]) = (a, b);
    }

    function _addrs(address a, address b, address c) internal pure returns (address[] memory r) {
        r = new address[](3);
        (r[0], r[1], r[2]) = (a, b, c);
    }

    function _addrs(address a, address b, address c, address d) internal pure returns (address[] memory r) {
        r = new address[](4);
        (r[0], r[1], r[2], r[3]) = (a, b, c, d);
    }

    function _addrs(address a, address b, address c, address d, address e) internal pure returns (address[] memory r) {
        r = new address[](5);
        (r[0], r[1], r[2], r[3], r[4]) = (a, b, c, d, e);
    }

    function _uints(uint256 a) internal pure returns (uint256[] memory r) {
        r = new uint256[](1);
        r[0] = a;
    }

    function _uints(uint256 a, uint256 b) internal pure returns (uint256[] memory r) {
        r = new uint256[](2);
        (r[0], r[1]) = (a, b);
    }

    function _uints(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory r) {
        r = new uint256[](3);
        (r[0], r[1], r[2]) = (a, b, c);
    }

    function _u16s(uint16 a) internal pure returns (uint16[] memory r) {
        r = new uint16[](1);
        r[0] = a;
    }

    function _u16s(uint16 a, uint16 b) internal pure returns (uint16[] memory r) {
        r = new uint16[](2);
        (r[0], r[1]) = (a, b);
    }

    function _u16s(uint16 a, uint16 b, uint16 c) internal pure returns (uint16[] memory r) {
        r = new uint16[](3);
        (r[0], r[1], r[2]) = (a, b, c);
    }

    function _u16s(uint16 a, uint16 b, uint16 c, uint16 d) internal pure returns (uint16[] memory r) {
        r = new uint16[](4);
        (r[0], r[1], r[2], r[3]) = (a, b, c, d);
    }

    function _u16s(uint16 a, uint16 b, uint16 c, uint16 d, uint16 e) internal pure returns (uint16[] memory r) {
        r = new uint16[](5);
        (r[0], r[1], r[2], r[3], r[4]) = (a, b, c, d, e);
    }

    function _datas(bytes memory a) internal pure returns (bytes[] memory r) {
        r = new bytes[](1);
        r[0] = a;
    }

    function _datas(bytes memory a, bytes memory b) internal pure returns (bytes[] memory r) {
        r = new bytes[](2);
        (r[0], r[1]) = (a, b);
    }

    function _datas(bytes memory a, bytes memory b, bytes memory c) internal pure returns (bytes[] memory r) {
        r = new bytes[](3);
        (r[0], r[1], r[2]) = (a, b, c);
    }

    function _datas(bytes memory a, bytes memory b, bytes memory c, bytes memory d)
        internal
        pure
        returns (bytes[] memory r)
    {
        r = new bytes[](4);
        (r[0], r[1], r[2], r[3]) = (a, b, c, d);
    }

    function _datas(bytes memory a, bytes memory b, bytes memory c, bytes memory d, bytes memory e)
        internal
        pure
        returns (bytes[] memory r)
    {
        r = new bytes[](5);
        (r[0], r[1], r[2], r[3], r[4]) = (a, b, c, d, e);
    }
}
