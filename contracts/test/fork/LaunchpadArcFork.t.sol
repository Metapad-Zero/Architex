// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import "../../interfaces/IArchitexFactory.sol";
import "../../interfaces/IArchitexPair.sol";
import "../../interfaces/IArchitexRouter.sol";
import "../../interfaces/IArchitexLaunchpad.sol";
import "../../interfaces/ILaunchToken.sol";
import "../../launchpad/ArchitexLaunchpad.sol";

/// @dev Stand-in for USDC. Arc's real USDC moves balances through a chain-native precompile that a
///      local fork cannot execute (reads work, transfers fail), so real-USDC behaviour is covered by
///      the live smoke test in docs/launchpad/TESTNET-DEPLOY.md, not here.
contract ForkUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice The launchpad against the factory, pair and router bytecode that is actually deployed on
///         Arc testnet, rather than a fresh local build of the same source.
///
///   ARC_TESTNET_RPC=https://rpc.testnet.arc.io forge test --match-contract LaunchpadArcFork -vv
///
///         Skipped when ARC_TESTNET_RPC is unset, so the default `forge test` stays offline.
contract LaunchpadArcForkTest is Test {
    address constant FACTORY = 0x6362f5A0fc007AB7D1e61f99D3F4eB04360D060a;
    address constant ROUTER = 0xCB417BbB2C3cE02296229ca89B639bb3Af2538E2;
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 constant CURVE_SUPPLY = 800_000_000e18;
    uint256 constant POOL_SUPPLY = 200_000_000e18;

    bool forked;
    ForkUSDC usdc;
    ArchitexLaunchpad pad;
    IArchitexRouter router = IArchitexRouter(ROUTER);

    address feeTo = makeAddr("feeTo");
    address setter = makeAddr("setter");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        string memory rpc = vm.envOr("ARC_TESTNET_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;

        assertGt(FACTORY.code.length, 0, "factory is not deployed on this chain");
        assertEq(router.factory(), FACTORY, "router is wired to a different factory");

        usdc = new ForkUSDC();
        pad = new ArchitexLaunchpad(address(usdc), FACTORY, feeTo, setter, 1e6);
        address[2] memory people = [alice, bob];
        for (uint256 i = 0; i < people.length; i++) {
            usdc.mint(people[i], 1_000_000e6);
            vm.startPrank(people[i]);
            usdc.approve(address(pad), type(uint256).max);
            usdc.approve(ROUTER, type(uint256).max);
            vm.stopPrank();
        }
    }

    modifier onlyFork() {
        if (!forked) {
            vm.skip(true);
            return;
        }
        _;
    }

    function _create() internal returns (address token) {
        vm.prank(alice);
        token = pad.createToken("Fork", "FORK", "", 0, 0);
    }

    function test_fork_deployedFactoryCreatesThePair() public onlyFork {
        uint256 pairsBefore = IArchitexFactory(FACTORY).allPairsLength();
        address token = _create();
        address pair = pad.curves(token).pair;
        assertEq(IArchitexFactory(FACTORY).getPair(token, address(usdc)), pair);
        assertEq(IArchitexFactory(FACTORY).allPairsLength(), pairsBefore + 1);
        assertGt(pair.code.length, 0);
        assertEq(IArchitexPair(pair).totalSupply(), 0, "empty until graduation");
        assertEq(pad.pendingFees(), 1e6, "launch fee accrued");
    }

    function test_fork_graduationSeedsTheDeployedPair() public onlyFork {
        address token = _create();
        IArchitexPair pair = IArchitexPair(pad.curves(token).pair);

        vm.prank(bob);
        (uint256 tokensOut, uint256 spent) = pad.buy(token, 10_000e6, 0, bob);
        assertEq(tokensOut, CURVE_SUPPLY);
        assertEq(spent, 8793969841);
        assertTrue(pad.curves(token).graduated);

        assertEq(usdc.balanceOf(address(pair)), 8749999991);
        assertEq(IERC20(token).balanceOf(address(pair)), POOL_SUPPLY);
        (uint112 r0, uint112 r1,) = pair.getReserves();
        (uint256 rUsdc, uint256 rToken) = pair.token0() == address(usdc) ? (r0, r1) : (r1, r0);
        assertEq(rUsdc, 8749999991, "reserves synced to the seed");
        assertEq(rToken, POOL_SUPPLY);
        assertEq(pair.balanceOf(DEAD), pair.totalSupply(), "every LP unit is locked");
        assertEq(usdc.balanceOf(address(pad)), pad.pendingFees(), "only fees remain");
    }

    function test_fork_graduatedPoolTradesThroughTheDeployedRouter() public onlyFork {
        address token = _create();
        vm.prank(bob);
        pad.buy(token, 10_000e6, 0, bob);

        address[] memory buyPath = new address[](2);
        buyPath[0] = address(usdc);
        buyPath[1] = token;
        uint256[] memory quoted = router.getAmountsOut(100e6, buyPath);
        vm.prank(alice);
        uint256[] memory got = router.swapExactTokensForTokens(100e6, quoted[1], buyPath, alice, block.timestamp + 1);
        assertEq(got[1], quoted[1]);
        assertEq(IERC20(token).balanceOf(alice), quoted[1]);

        address[] memory sellPath = new address[](2);
        sellPath[0] = token;
        sellPath[1] = address(usdc);
        vm.startPrank(alice);
        IERC20(token).approve(ROUTER, type(uint256).max);
        uint256 before = usdc.balanceOf(alice);
        router.swapExactTokensForTokens(quoted[1], 0, sellPath, alice, block.timestamp + 1);
        vm.stopPrank();
        uint256 back = usdc.balanceOf(alice) - before;
        assertLt(back, 100e6, "a round trip pays the pool fee twice");
        assertGt(back, 99e6, "and nothing more than that");
    }

    function test_fork_pairLockHoldsAgainstTheDeployedRouter() public onlyFork {
        address token = _create();
        address pair = pad.curves(token).pair;
        vm.prank(alice);
        (uint256 tokens,) = pad.buy(token, 500e6, 0, alice);

        vm.startPrank(alice);
        IERC20(token).approve(ROUTER, type(uint256).max);
        vm.expectRevert();
        router.addLiquidity(token, address(usdc), tokens / 2, 100e6, 0, 0, alice, block.timestamp + 1);

        address[] memory path = new address[](2);
        path[0] = token;
        path[1] = address(usdc);
        vm.expectRevert();
        router.swapExactTokensForTokens(1e18, 0, path, alice, block.timestamp + 1);

        vm.expectRevert(ILaunchToken.PairLockedUntilGraduation.selector);
        IERC20(token).transfer(pair, 1e18);
        vm.stopPrank();

        assertEq(IArchitexPair(pair).totalSupply(), 0);
        assertEq(IERC20(token).balanceOf(pair), 0);
    }

    function test_fork_sellRoundTripOnTheCurve() public onlyFork {
        address token = _create();
        vm.startPrank(alice);
        (uint256 tokens,) = pad.buy(token, 100e6, 0, alice);
        assertEq(tokens, 35188152739604558463877487);
        uint256 out = pad.sell(token, tokens, 0, alice);
        vm.stopPrank();
        assertEq(out, 99002499);
    }
}
