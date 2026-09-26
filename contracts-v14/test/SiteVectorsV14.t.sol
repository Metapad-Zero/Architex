// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IArchitexLaunchpadV14} from "../src/interfaces/IArchitexLaunchpadV14.sol";
import {IArchitexLaunchHook} from "../src/interfaces/IArchitexLaunchHook.sol";
import {V14Base} from "./V14Base.sol";

/// @notice Prints the reference vectors the site's v1.4 code is tested against (src/lib/__tests__/fixtures/
///         v14-vectors.json): the snipe schedule, curve buys with the snipe fee, pool keys and ids with USDC on either
///         side, the price a pool opens at and its first bid, router quotes against the fees the hook took, the bid each
///         buy in a pool's snipe window places (above the graduation price, and after a crash under it), the fees the
///         hook holds until a sync, and raw event logs to decode.
///         Every number comes from the contracts themselves, with USDC at Arc's own address. Regenerate with
///         FOUNDRY_PROFILE=v14 forge test --match-contract SiteVectorsV14 -vv | sed -n 's/.*VEC //p'
contract SiteVectorsV14 is V14Base {
    using PoolIdLibrary for PoolKey;

    address internal constant ARC_USDC = 0x3600000000000000000000000000000000000000;

    function _usdcAt() internal pure override returns (address) {
        return ARC_USDC;
    }

    // ─── JSON ─────────────────────────────────────────────────────────────────

    function _q(string memory s) internal pure returns (string memory) {
        return string.concat('"', s, '"');
    }

    function _n(uint256 v) internal pure returns (string memory) {
        return _q(vm.toString(v));
    }

    function _a(address v) internal pure returns (string memory) {
        return _q(vm.toString(v));
    }

    function _b(bool v) internal pure returns (string memory) {
        return v ? "true" : "false";
    }

    function _emit(string memory json) internal pure {
        console.log(string.concat("VEC ", json));
    }

    // ─── Fixture ──────────────────────────────────────────────────────────────

    /// @dev Launches until a token sorts on the wanted side of USDC (about one in five sorts below 0x36…).
    function _launchSide(bool below, uint16 creatorFeeBps, bool openPool) internal returns (address token) {
        for (uint256 i; i < 64; ++i) {
            token = _launch(creatorFeeBps, creatorWallet, "", openPool, 0);
            if ((token < ARC_USDC) == below) return token;
        }
        revert("no token on that side");
    }

    function _curve(address token) internal view returns (IArchitexLaunchpadV14.Curve memory) {
        return pad.curves(token);
    }

    function _slot0(PoolId id) internal view returns (uint160 sqrtP, int24 tick) {
        bytes32 data = manager.extsload(keccak256(abi.encodePacked(PoolId.unwrap(id), bytes32(uint256(6)))));
        assembly ("memory-safe") {
            sqrtP := and(data, 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF)
            tick := signextend(2, shr(160, data))
        }
    }

    function _curveBuyVector(address token) internal view returns (string memory) {
        return _curveBuyVectorFor(token, 0);
    }

    function _curveBuyVectorFor(address token, uint256 usdcIn) internal view returns (string memory) {
        IArchitexLaunchpadV14.Curve memory c = _curve(token);
        string memory head = string.concat(
            '{"k":"cb14","c":',
            vm.toString(uint256(c.creatorFeeBps)),
            ',"s":',
            vm.toString(pad.snipeBpsOf(token)),
            ',"vu":',
            _n(c.virtualUsdc),
            ',"vt":',
            _n(c.virtualTokens),
            ',"sold":',
            _n(c.tokensSold),
            ',"in":',
            _n(usdcIn)
        );
        try pad.quoteBuy(token, usdcIn) returns (
            uint256 tokensOut, uint256 pf, uint256 cf, uint256 sf, uint256 spent, bool graduates
        ) {
            return string.concat(
                head,
                ',"r":[',
                string.concat(_n(tokensOut), ",", _n(pf), ",", _n(cf), ",", _n(sf), ",", _n(spent), ",", _b(graduates)),
                "]}"
            );
        } catch (bytes memory reason) {
            return string.concat(head, ',"e":', _q(vm.toString(bytes4(reason))), "}");
        }
    }

    function _logs(string memory step) internal view {
        Vm.Log[] memory entries = vm.getRecordedLogs();
        for (uint256 i; i < entries.length; ++i) {
            Vm.Log memory log = entries[i];
            if (log.emitter != address(pad) && log.emitter != address(hook)) continue;
            string memory topics = "";
            for (uint256 t; t < log.topics.length; ++t) {
                topics = string.concat(topics, t == 0 ? "" : ",", _q(vm.toString(log.topics[t])));
            }
            _emit(
                string.concat(
                    '{"k":"log","step":',
                    _q(step),
                    ',"emitter":',
                    log.emitter == address(pad) ? '"launchpad"' : '"hook"',
                    ',"topics":[',
                    topics,
                    '],"data":',
                    _q(vm.toString(log.data)),
                    "}"
                )
            );
        }
    }

    /// @dev Router quotes against what the hook took: buys a block apart inside the pool's snipe window (so each pays a
    ///      lower surcharge, and places it as a bid inside the buy), sells, the same after the window, then a sync of the
    ///      fees the hook holds.
    function _poolTrades(address token, uint256 s) internal {
        uint256[4] memory buys = [uint256(1e6), 250e6, 7_500e6, 40_000e6];
        uint256[3] memory sells = [uint256(1_000e18), 2_500_000e18, 60_000_000e18];
        PoolKey memory key = hook.poolKeyOf(token);
        for (uint256 w; w < 2; ++w) {
            if (w == 1) _step(hook.SNIPE_BLOCKS());
            for (uint256 b; b < buys.length; ++b) {
                if (w == 0) vm.roll(vm.getBlockNumber() + 1 + b);
                _poolBuy(token, key, buys[b], string.concat(vm.toString(s), "-", vm.toString(w), "-", vm.toString(b)));
            }
            for (uint256 b; b < sells.length; ++b) {
                (uint160 before,) = _slot0(key.toId());
                uint256 quoted = router.quoteSell(token, sells[b]);
                vm.recordLogs();
                vm.prank(bob);
                uint256 got = router.sell(token, sells[b], 0, bob, MAX);
                (uint160 afterP,) = _slot0(key.toId());
                _emit(
                    string.concat(
                        '{"k":"pq","side":"sell","token":',
                        _a(token),
                        ',"usdcIs0":',
                        _b(address(usdc) < token),
                        ',"c":250,"s":0,"in":',
                        _n(sells[b]),
                        ',"quote":',
                        _n(quoted),
                        ',"out":',
                        _n(got),
                        ',"sqrtBefore":',
                        string.concat(_n(before), ',"sqrtAfter":', _n(afterP), "}")
                    )
                );
                _logs(string.concat("pool sell ", vm.toString(s), "-", vm.toString(w), "-", vm.toString(b)));
            }
            if (w == 0) _crashThenBuy(token, key, s);
        }
        // The pool's fees wait as the hook's claims until a sync books them in the launchpad.
        _emit(
            string.concat(
                '{"k":"pending","token":',
                _a(token),
                ',"hookPlatform":',
                _n(hook.pendingPlatform(token)),
                ',"hookCreator":',
                _n(hook.pendingCreator(token)),
                ',"padCreator":',
                _n(pad.pendingCreatorFees(token)),
                "}"
            )
        );
        vm.recordLogs();
        pad.syncPoolFees(token);
        _logs(string.concat("sync ", vm.toString(s)));
    }

    /// @dev Still inside the window: a dump that takes the price well under the graduation price, then a buy whose bid
    ///      follows the price down (it is placed from the cheaper of the tick before it and the graduation tick).
    function _crashThenBuy(address token, PoolKey memory key, uint256 s) internal {
        vm.roll(vm.getBlockNumber() + 1);
        vm.recordLogs();
        vm.prank(bob);
        router.sell(token, 300_000_000e18, 0, bob, MAX);
        _logs(string.concat("pool crash-sell ", vm.toString(s), "-0"));
        vm.roll(vm.getBlockNumber() + 1);
        (, int24 tickBefore) = _slot0(key.toId());
        (, IArchitexLaunchHook.Launch memory l) = hook.launchOf(token);
        uint256 snipe = hook.snipeBpsOf(token);
        uint256 heldBefore = hook.lockHeld(token);
        uint256 bidsBefore = hook.bidCount(token);
        vm.recordLogs();
        vm.prank(carol);
        router.buy(token, 2_000e6, 0, carol, MAX);
        _emit(
            string.concat(
                string.concat('{"k":"crash","token":', _a(token), ',"usdcIs0":', _b(l.usdcIs0)),
                string.concat(',"graduationTick":', vm.toString(int256(l.graduationTick)), ',"tickBefore":', vm.toString(int256(tickBefore))),
                string.concat(',"s":', vm.toString(snipe), ',"in":', _n(2_000e6)),
                string.concat(',"heldBefore":', _n(heldBefore), ',"heldAfter":', _n(hook.lockHeld(token))),
                string.concat(',"bidsBefore":', _n(bidsBefore), ',"bidsAfter":', _n(hook.bidCount(token)), "}")
            )
        );
        _logs(string.concat("pool crash-buy ", vm.toString(s), "-0"));
    }

    /// @dev One router buy: its quote and result, the price and tick before it (a window buy's bid is placed from the
    ///      cheaper of that tick and the graduation tick), and the hook's held rounding and bid count either side of it.
    function _poolBuy(address token, PoolKey memory key, uint256 usdcIn, string memory step) internal {
        (uint160 before, int24 tickBefore) = _slot0(key.toId());
        uint256 snipe = hook.snipeBpsOf(token);
        uint256 heldBefore = hook.lockHeld(token);
        uint256 bidsBefore = hook.bidCount(token);
        uint256 quoted = router.quoteBuy(token, usdcIn);
        vm.recordLogs();
        vm.prank(carol);
        uint256 got = router.buy(token, usdcIn, 0, carol, MAX);
        (uint160 afterP,) = _slot0(key.toId());
        _emit(
            string.concat(
                string.concat('{"k":"pq","side":"buy","token":', _a(token), ',"usdcIs0":', _b(address(usdc) < token)),
                string.concat(',"c":250,"s":', vm.toString(snipe), ',"in":', _n(usdcIn), ',"quote":', _n(quoted), ',"out":', _n(got)),
                string.concat(',"sqrtBefore":', _n(before), ',"sqrtAfter":', _n(afterP), ',"tickBefore":', vm.toString(int256(tickBefore))),
                string.concat(',"heldBefore":', _n(heldBefore), ',"heldAfter":', _n(hook.lockHeld(token))),
                string.concat(',"bidsBefore":', _n(bidsBefore), ',"bidsAfter":', _n(hook.bidCount(token)), "}")
            )
        );
        _logs(string.concat("pool buy ", step));
    }

    /// @dev A pool as it opened: its tick, its graduation tick (the first bid is placed from it), the curve it came from,
    ///      the curve's snipe fees that became that bid, and the hook's bid count and held rounding after.
    function _gradVector(address token, uint256 snipeHeld, string memory step) internal {
        IArchitexLaunchpadV14.Curve memory c = _curve(token);
        (, IArchitexLaunchHook.Launch memory l) = hook.launchOf(token);
        (uint160 sqrtP, int24 tick) = _slot0(hook.poolKeyOf(token).toId());
        _emit(
            string.concat(
                string.concat('{"k":"grad","step":', _q(step), ',"token":', _a(token), ',"usdcIs0":', _b(l.usdcIs0)),
                string.concat(',"sqrtPriceX96":', _n(sqrtP), ',"tick":', vm.toString(int256(tick))),
                string.concat(',"graduationTick":', vm.toString(int256(l.graduationTick)), ',"vu":', _n(c.virtualUsdc), ',"vt":', _n(c.virtualTokens)),
                string.concat(',"snipeHeld":', _n(snipeHeld), ',"bids":', _n(hook.bidCount(token)), ',"held":', _n(hook.lockHeld(token)), "}")
            )
        );
    }

    // ─── Vectors ──────────────────────────────────────────────────────────────

    function test_printVectors() public {
        _emit(
            string.concat(
                '{"k":"suite","usdc":',
                _a(address(usdc)),
                ',"launchpad":',
                _a(address(pad)),
                ',"hook":',
                _a(address(hook)),
                ',"router":',
                _a(address(router)),
                ',"poolManager":',
                _a(POOL_MANAGER),
                "}"
            )
        );

        // The curve's snipe schedule, block by block, at no creator fee and at the 10% cap (where the total binds).
        uint16[2] memory scheduleFees = [uint16(0), 1000];
        for (uint256 f; f < scheduleFees.length; ++f) {
            address token = _launch(scheduleFees[f], creatorWallet, "", false, 0);
            uint256 created = _curve(token).createdBlock;
            for (uint256 i; i <= 21; ++i) {
                _emit(
                    string.concat(
                        '{"k":"snipe","c":',
                        vm.toString(uint256(scheduleFees[f])),
                        ',"open":',
                        _n(created),
                        ',"block":',
                        _n(vm.getBlockNumber()),
                        ',"bps":',
                        vm.toString(pad.snipeBpsOf(token)),
                        "}"
                    )
                );
                vm.roll(vm.getBlockNumber() + 1);
            }
        }

        // Curve buys with the snipe fee: quotes at several blocks, fees and amounts, then executed buys that move the
        // curve, and sell-out buys inside the window (the exact-fill split with three fees).
        uint16[4] memory fees = [uint16(0), 37, 250, 1000];
        uint256[5] memory amounts = [uint256(1), 1e6, 123_456_789, 5_000e6, 60_000e6];
        uint256[5] memory offsets = [uint256(0), 1, 7, 19, 20];
        for (uint256 f; f < fees.length; ++f) {
            address token = _launch(fees[f], creatorWallet, "", false, 0);
            for (uint256 o; o < offsets.length; ++o) {
                vm.roll(_curve(token).createdBlock + offsets[o]);
                for (uint256 a; a < amounts.length; ++a) {
                    _emit(_curveBuyVectorFor(token, amounts[a]));
                }
                // An executed buy moves the curve for the next offset's quotes.
                vm.prank(carol);
                pad.buy(token, 2_345e6, 0, carol, MAX);
            }
        }
        for (uint256 f; f < fees.length; ++f) {
            address token = _launch(fees[f], creatorWallet, "", false, 0);
            vm.roll(_curve(token).createdBlock + 3);
            vm.prank(bob);
            pad.buy(token, 20_000e6, 0, bob, MAX);
            _emit(_curveBuyVectorFor(token, 60_000e6));
            _emit(_curveBuyVectorFor(token, 1_000_000e6));
        }

        // Pool keys and ids, and the price each pool opens at, with USDC on either side of the token.
        bool[2] memory sides = [true, false];
        for (uint256 s; s < sides.length; ++s) {
            address token = _launchSide(sides[s], 250, s == 0);
            PoolKey memory key = hook.poolKeyOf(token);
            _emit(
                string.concat(
                    '{"k":"key","token":',
                    _a(token),
                    ',"currency0":',
                    _a(Currency.unwrap(key.currency0)),
                    ',"currency1":',
                    _a(Currency.unwrap(key.currency1)),
                    ',"fee":',
                    vm.toString(uint256(key.fee)),
                    ',"tickSpacing":',
                    vm.toString(int256(key.tickSpacing)),
                    ',"hooks":',
                    _a(address(key.hooks)),
                    ',"poolId":',
                    _q(vm.toString(PoolId.unwrap(key.toId()))),
                    "}"
                )
            );
            // A sniped curve buy, so graduation turns the curve's snipe fees into the pool's first bid.
            vm.roll(_curve(token).createdBlock + 2);
            vm.prank(carol);
            pad.buy(token, 500e6, 0, carol, MAX);
            uint256 snipeHeld = pad.pendingSnipe(token);
            _step(pad.SNIPE_BLOCKS());
            vm.recordLogs();
            vm.prank(bob);
            pad.buy(token, 1_000_000e6, 0, bob, MAX);
            _logs(string.concat("graduate ", vm.toString(s)));
            _gradVector(token, snipeHeld, string.concat("graduate ", vm.toString(s)));
            _poolTrades(token, s);
        }

        // A launch's own events, raw: creation with an open pool and a first buy, a sniped curve buy, a curve sell,
        // and the graduation (its sell-out Trade, the hook's PoolOpened and BidLocked, and Graduated).
        vm.recordLogs();
        vm.prank(dave);
        address logged = pad.createToken("Log Token", "LOG", "ipfs://bafkreilog", 125, creatorWallet, "", true, 50e6, 0, MAX);
        _logs("create");
        vm.roll(vm.getBlockNumber() + 2);
        vm.recordLogs();
        vm.prank(carol);
        pad.buy(logged, 300e6, 0, carol, MAX);
        _logs("sniped buy");
        uint256 toSell = IERC20(logged).balanceOf(carol) / 3;
        vm.recordLogs();
        vm.prank(carol);
        pad.sell(logged, toSell, 0, carol, MAX);
        _logs("sell");
        uint256 loggedSnipe = pad.pendingSnipe(logged);
        vm.roll(vm.getBlockNumber() + 30);
        vm.recordLogs();
        vm.prank(bob);
        pad.buy(logged, 1_000_000e6, 0, bob, MAX);
        _logs("graduation");
        _gradVector(logged, loggedSnipe, "graduation");
    }
}
