// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import "../../interfaces/IArchitexLaunchpad.sol";
import "../../interfaces/ILaunchToken.sol";
import "../../interfaces/ILaunchPair.sol";
import "../../launchpad/ArchitexLaunchpad.sol";
import "../../launchpad/LaunchPairFactory.sol";
import "../../launchpad/LaunchRouter.sol";

/// @dev Stand-in for USDC. Arc's real USDC moves balances through a chain-native precompile that a
///      local fork cannot execute (reads work, transfers fail), so real-USDC behaviour is covered by
///      the live testnet rehearsal (V13-SPEC §8), not here.
contract ForkUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice The v1.3 launch suite deployed on a fork of Arc testnet: the same EVM, precompiles and block
///         parameters the contracts will meet, rather than a local Anvil chain. v1.3 no longer touches the core
///         AMM, so nothing here depends on deployed core bytecode.
///
///   ARC_TESTNET_RPC=https://rpc.testnet.arc.io forge test --match-contract LaunchpadArcFork -vv
///
///         Skipped when ARC_TESTNET_RPC is unset, so the default `forge test` stays offline.
contract LaunchpadArcForkTest is Test {
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 constant CURVE_SUPPLY = 800_000_000e18;
    uint256 constant POOL_SUPPLY = 200_000_000e18;

    bool forked;
    ForkUSDC usdc;
    ArchitexLaunchpad pad;
    LaunchPairFactory pairFactory;
    LaunchRouter router;

    address feeTo = makeAddr("feeTo");
    address setter = makeAddr("setter");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        string memory rpc = vm.envOr("ARC_TESTNET_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;

        usdc = new ForkUSDC();
        pad = new ArchitexLaunchpad(address(usdc), feeTo, setter, 1e6);
        pairFactory = new LaunchPairFactory(address(pad));
        router = new LaunchRouter(address(pad), address(pairFactory), address(usdc));
        pad.initialize(address(pairFactory), address(router));
        address[2] memory people = [alice, bob];
        for (uint256 i = 0; i < people.length; i++) {
            usdc.mint(people[i], 1_000_000e6);
            vm.startPrank(people[i]);
            usdc.approve(address(pad), type(uint256).max);
            usdc.approve(address(router), type(uint256).max);
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
        token = pad.createToken("Fork", "FORK", "", 200, alice, "", 0, 0, type(uint256).max);
    }

    function test_fork_createTokenMakesItsLaunchPair() public onlyFork {
        address token = _create();
        address pair = pad.curves(token).pair;
        assertEq(pairFactory.getPair(token), pair);
        assertEq(pairFactory.allPairsLength(), 1);
        assertGt(pair.code.length, 0);
        assertEq(ILaunchPair(pair).totalSupply(), 0, "empty until graduation");
        assertEq(pad.pendingFees(), 1e6, "launch fee accrued");
    }

    function test_fork_graduationSeedsTheLaunchPair() public onlyFork {
        address token = _create();
        ILaunchPair pair = ILaunchPair(pad.curves(token).pair);

        vm.prank(bob);
        (uint256 tokensOut,) = pad.buy(token, 30_000e6, 0, bob);
        assertEq(tokensOut, CURVE_SUPPLY);
        assertTrue(pad.curves(token).graduated);

        uint256 seeded = uint256(pad.curves(token).virtualUsdc) - pad.VIRTUAL_USDC_0();
        assertEq(usdc.balanceOf(address(pair)), seeded);
        assertEq(IERC20(token).balanceOf(address(pair)), POOL_SUPPLY);
        (uint112 reserveToken, uint112 reserveUsdc,) = pair.getReserves();
        assertEq(reserveUsdc, seeded, "reserves synced to the seed");
        assertEq(reserveToken, POOL_SUPPLY);
        assertEq(pair.balanceOf(DEAD), pair.totalSupply(), "every LP unit is locked");
        assertEq(usdc.balanceOf(address(pad)), pad.pendingFees() + pad.pendingCreatorFees(token), "only fees remain");
    }

    function test_fork_graduatedPoolTradesThroughTheLaunchRouter() public onlyFork {
        address token = _create();
        vm.prank(bob);
        pad.buy(token, 30_000e6, 0, bob);

        (uint256 quoted,,) = router.quoteBuy(token, 100e6);
        vm.prank(alice);
        uint256 got = router.buy(token, 100e6, quoted, alice, block.timestamp + 1);
        assertEq(got, quoted);
        assertEq(IERC20(token).balanceOf(alice), quoted);

        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        router.sell(token, quoted, 0, alice, block.timestamp + 1);
        uint256 back = usdc.balanceOf(alice) - before;
        assertLt(back, 100e6, "a round trip pays both fees twice");
        assertGt(back, 95e6, "and nothing more than that");
    }

    function test_fork_pairLockHolds() public onlyFork {
        address token = _create();
        address pair = pad.curves(token).pair;
        vm.prank(alice);
        pad.buy(token, 500e6, 0, alice);

        vm.startPrank(alice);
        vm.expectRevert(ILaunchToken.PairLockedUntilGraduation.selector);
        IERC20(token).transfer(pair, 1e18);
        vm.expectRevert(ILaunchRouter.NotGraduated.selector);
        router.sell(token, 1e18, 0, alice, block.timestamp + 1);
        vm.stopPrank();

        assertEq(ILaunchPair(pair).totalSupply(), 0);
        assertEq(IERC20(token).balanceOf(pair), 0);
    }

    function test_fork_sellRoundTripOnTheCurve() public onlyFork {
        vm.prank(alice);
        address token = pad.createToken("Fork", "FORK", "", 0, alice, "", 0, 0, type(uint256).max);
        vm.startPrank(alice);
        (uint256 tokens,) = pad.buy(token, 100e6, 0, alice);
        assertEq(tokens, 12585726430898500955823408);
        uint256 out = pad.sell(token, tokens, 0, alice);
        vm.stopPrank();
        assertEq(out, 99002499);
    }
}
