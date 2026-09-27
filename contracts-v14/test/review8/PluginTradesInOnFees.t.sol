// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IArchitexFeePlugin} from "../../../contracts/interfaces/IArchitexFeePlugin.sol";
import {ArchitexV4Router} from "../../src/ArchitexV4Router.sol";
import {Review8Base} from "./Review8Base.sol";

/// @dev A creator's plugin that turns each collection into a buyback in the token's Uniswap pool, from inside onFees.
contract BuybackInOnFees is IArchitexFeePlugin {
    IERC20 internal immutable usdc;
    ArchitexV4Router internal immutable router;
    uint256 public bought;

    constructor(IERC20 usdc_, ArchitexV4Router router_) {
        usdc = usdc_;
        router = router_;
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == type(IArchitexFeePlugin).interfaceId || id == type(IERC165).interfaceId;
    }

    function onLaunch(address, address, bytes calldata) external {}

    function onFees(address token, uint256 amount) external {
        usdc.transferFrom(msg.sender, address(this), amount); // the exact pull
        usdc.approve(address(router), amount);
        bought += router.buy(token, amount, 0, address(this), type(uint256).max);
    }
}

/// @notice Claude review #8, informational (a documentation error, since corrected, and a behaviour change the claims
///         fix introduced).
///         IArchitexLaunchpadV14.collectCreatorFees says onFees runs inside the launchpad's reentrancy guard, so "a plugin
///         cannot buy, sell (on the curve or through the launch router) or collect from inside it, so buybacks must be
///         separate calls". At 217d207 that held for pool trades too, because the hook's afterSwap called the
///         launchpad's nonReentrant accrueTradeFees. Since 525c4cc a pool swap never calls the launchpad, so a plugin can
///         buy (or sell) in the token's pool from inside onFees, through the Architex router or any v4 router. The
///         exact-pull check still holds (the router pulls from the plugin, not the launchpad). Nothing is at risk; the
///         NatSpec is wrong, and a plugin author (Deepen pool v1.4) may rely on either reading.
abstract contract PluginTradesInOnFeesTest is Review8Base {
    function test_aPluginBuysInThePoolFromInsideOnFees() public {
        BuybackInOnFees plugin = new BuybackInOnFees(IERC20(address(usdc)), router);
        address token = _launch(1000, address(plugin), "", false, 0);
        _step(pad.SNIPE_BLOCKS());
        vm.prank(bob);
        pad.buy(token, 1_000_000e6, 0, bob, MAX); // graduates
        _step(hook.SNIPE_BLOCKS());

        uint256 fees = pad.pendingCreatorFees(token);
        assertGt(fees, 0);
        uint256 paid = pad.collectCreatorFees(token); // onFees buys in the pool with all of it
        assertEq(paid, fees);
        assertGt(plugin.bought(), 0, "bought in the pool from inside onFees");
        assertEq(IERC20(token).balanceOf(address(plugin)), plugin.bought());
        assertGt(hook.pendingCreator(token), 0, "the buyback itself paid pool creator fees, held for the next sync");
        _assertHookClean(token);
        _assertSolvent();
    }
}

contract PluginTradesInOnFeesUsdcLowTest is PluginTradesInOnFeesTest {
    function _usdcAt() internal pure override returns (address) {
        return address(0x0000000000000000000000000000000000001000);
    }
}

contract PluginTradesInOnFeesUsdcHighTest is PluginTradesInOnFeesTest {
    function _usdcAt() internal pure override returns (address) {
        return address(uint160(type(uint160).max - 0xfff));
    }
}
