// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/utils/introspection/ERC165.sol";

import "../../launchpad/ArchitexLaunchpad.sol";
import "../../launchpad/LaunchPairFactory.sol";
import "../../launchpad/LaunchRouter.sol";
import "../../launchpad/LaunchPair.sol";
import "../../launchpad/LaunchToken.sol";
import "../../interfaces/IArchitexFeePlugin.sol";
import "../../interfaces/IArchitexLaunchpad.sol";
import "../../interfaces/ILaunchToken.sol";
import "../../interfaces/ILaunchPair.sol";

// ─── USDC stand-ins ───────────────────────────────────────────────────────────

/// @dev 6-decimal USDC with Arc's blocklist behaviour: transfers and approvals touching a blocked address revert.
contract BlockableUSDC is ERC20 {
    mapping(address => bool) public blocked;

    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address who, bool value) external {
        blocked[who] = value;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[from] && !blocked[to], "blocklisted");
        super._update(from, to, value);
    }

    function _approve(address owner, address spender, uint256 value, bool emitEvent) internal override {
        require(!blocked[owner] && !blocked[spender], "blocklisted");
        super._approve(owner, spender, value, emitEvent);
    }
}

// ─── Mock fee plugins (test-only; the real plugins live in contracts/plugins/launch/) ─────────────────

/// @dev A well-behaved IArchitexFeePlugin: accepts onLaunch only from the launchpad, records what it saw at that
///      moment, and pulls exactly the amount it is offered in onFees.
contract ExactPlugin is ERC165, IArchitexFeePlugin {
    IArchitexLaunchpad public immutable pad;
    IERC20 public immutable usdc;

    mapping(address => uint256) public received;
    uint256 public launches;
    uint256 public feeCalls;
    address public lastToken;
    address public lastCreator;
    bytes public lastData;
    // Observed inside onLaunch
    bool public curveRegisteredAtLaunch;
    uint256 public soldAtLaunch;
    uint256 public creatorBalanceAtLaunch;

    constructor(IArchitexLaunchpad pad_) {
        pad = pad_;
        usdc = IERC20(pad_.usdc());
    }

    function supportsInterface(bytes4 id) public view override(ERC165, IERC165) returns (bool) {
        return id == type(IArchitexFeePlugin).interfaceId || super.supportsInterface(id);
    }

    function onLaunch(address token, address creator, bytes calldata data) external {
        require(msg.sender == address(pad), "only launchpad");
        launches++;
        lastToken = token;
        lastCreator = creator;
        lastData = data;
        // Every per-token view is a plain view, callable while createToken is still running
        curveRegisteredAtLaunch = pad.pluginOf(token) == address(this) && pad.creatorOf(token) == creator
            && pad.pairOf(token) != address(0) && !pad.isGraduated(token)
            && pad.virtualUsdcOf(token) == pad.VIRTUAL_USDC_0() && pad.creatorFeeBpsOf(token) == pad.curves(token).creatorFeeBps
            && pad.curves(token).pluginHooks;
        soldAtLaunch = pad.curves(token).tokensSold;
        creatorBalanceAtLaunch = IERC20(token).balanceOf(creator);
    }

    function onFees(address token, uint256 amount) external {
        feeCalls++;
        require(usdc.transferFrom(msg.sender, address(this), amount), "pull");
        received[token] += amount;
    }
}

/// @dev A plugin that declares the interface and then misbehaves in a chosen way.
contract MisbehavingPlugin is ERC165, IArchitexFeePlugin {
    enum Mode {
        Exact,
        PullLess,
        PullMore,
        PullNone,
        PullThenRefundOne,
        Revert,
        PullToThirdParty
    }

    IERC20 public immutable usdc;
    Mode public mode;
    bool public revertOnLaunch;
    address public constant THIRD_PARTY = address(0x7777);

    constructor(IERC20 usdc_) {
        usdc = usdc_;
    }

    function supportsInterface(bytes4 id) public view override(ERC165, IERC165) returns (bool) {
        return id == type(IArchitexFeePlugin).interfaceId || super.supportsInterface(id);
    }

    function setMode(Mode m) external {
        mode = m;
    }

    function setRevertOnLaunch(bool v) external {
        revertOnLaunch = v;
    }

    function onLaunch(address, address, bytes calldata) external view {
        require(!revertOnLaunch, "onLaunch refuses");
    }

    function onFees(address, uint256 amount) external {
        Mode m = mode;
        if (m == Mode.Exact) {
            usdc.transferFrom(msg.sender, address(this), amount);
        } else if (m == Mode.PullLess) {
            usdc.transferFrom(msg.sender, address(this), amount - 1);
        } else if (m == Mode.PullMore) {
            usdc.transferFrom(msg.sender, address(this), amount + 1);
        } else if (m == Mode.PullNone) {
            // takes nothing
        } else if (m == Mode.PullThenRefundOne) {
            usdc.transferFrom(msg.sender, address(this), amount);
            usdc.transfer(msg.sender, 1);
        } else if (m == Mode.Revert) {
            revert("plugin broken");
        } else {
            usdc.transferFrom(msg.sender, THIRD_PARTY, amount);
        }
    }
}

/// @dev Answers true to every interface id, including 0xffffffff, which ERC-165 requires to be false. The
///      launchpad must therefore treat it as a plain address: no hooks, a plain transfer.
contract LyingPlugin {
    uint256 public hookCalls;

    function supportsInterface(bytes4) external pure returns (bool) {
        return true;
    }

    function onLaunch(address, address, bytes calldata) external {
        hookCalls++;
    }

    function onFees(address, uint256) external {
        hookCalls++;
    }
}

/// @dev A plugin whose ERC-165 answer can change after launch (an upgradeable proxy, say). Credits per token only
///      through onFees, like the real plugins; anything that arrives otherwise is uncredited.
contract FlippablePlugin is IArchitexFeePlugin {
    IERC20 public immutable usdc;
    bool public declares;
    mapping(address => bool) public configured;
    mapping(address => uint256) public credited;
    uint256 public launches;
    uint256 public feeCalls;

    constructor(IERC20 usdc_, bool declares_) {
        usdc = usdc_;
        declares = declares_;
    }

    function setDeclares(bool v) external {
        declares = v;
    }

    function supportsInterface(bytes4 id) external view returns (bool) {
        if (id == 0xffffffff) return false;
        if (id == type(IERC165).interfaceId) return true;
        return declares && id == type(IArchitexFeePlugin).interfaceId;
    }

    function onLaunch(address token, address, bytes calldata) external {
        launches++;
        configured[token] = true;
    }

    function onFees(address token, uint256 amount) external {
        require(configured[token], "not configured");
        feeCalls++;
        require(usdc.transferFrom(msg.sender, address(this), amount), "pull");
        credited[token] += amount;
    }
}

/// @dev An onLaunch that costs about as much as the heaviest listed configuration (a full Combo, ~1.3M gas): it
///      writes `slots` fresh storage slots.
contract HeavyLaunchPlugin is ERC165, IArchitexFeePlugin {
    uint256 public immutable slots;
    mapping(uint256 => uint256) public store;
    uint256 public gasAtLaunch;

    constructor(uint256 slots_) {
        slots = slots_;
    }

    function supportsInterface(bytes4 id) public view override(ERC165, IERC165) returns (bool) {
        return id == type(IArchitexFeePlugin).interfaceId || super.supportsInterface(id);
    }

    function onLaunch(address, address, bytes calldata) external {
        gasAtLaunch = gasleft();
        for (uint256 i = 0; i < slots; i++) {
            store[i] = i + 1;
        }
    }

    function onFees(address, uint256 amount) external {
        IERC20(IArchitexLaunchpad(msg.sender).usdc()).transferFrom(msg.sender, address(this), amount);
    }
}

/// @dev supportsInterface burns every unit of gas it is given. ERC165Checker caps the probe at 30k gas, so the
///      launchpad treats it as a plain address rather than getting stuck.
contract GasGuzzlerPlugin {
    uint256 public hookCalls;

    function supportsInterface(bytes4) external view returns (bool) {
        uint256 x;
        while (gasleft() > 0) {
            x++;
        }
        return x > 0;
    }

    function onLaunch(address, address, bytes calldata) external {
        hookCalls++;
    }

    function onFees(address, uint256) external {
        hookCalls++;
    }
}

/// @dev Has the hook functions but does not declare them through ERC-165 (no supportsInterface at all).
contract HooklessRecorder {
    uint256 public hookCalls;

    function onLaunch(address, address, bytes calldata) external {
        hookCalls++;
    }

    function onFees(address, uint256) external {
        hookCalls++;
    }
}

/// @dev Tries to re-enter the launchpad (and the router) from inside onLaunch and onFees, records the revert
///      selector of each attempt, and otherwise behaves (pulls exactly).
contract ReentrantPlugin is ERC165, IArchitexFeePlugin {
    IArchitexLaunchpad public immutable pad;
    LaunchRouter public immutable router;
    IERC20 public immutable usdc;
    address public graduatedToken; // a graduated token to try a router trade on
    bytes4[] public errors;
    bool public anyReentrySucceeded;

    constructor(IArchitexLaunchpad pad_, LaunchRouter router_) {
        pad = pad_;
        router = router_;
        usdc = IERC20(pad_.usdc());
        IERC20(pad_.usdc()).approve(address(pad_), type(uint256).max);
        IERC20(pad_.usdc()).approve(address(router_), type(uint256).max);
    }

    function supportsInterface(bytes4 id) public view override(ERC165, IERC165) returns (bool) {
        return id == type(IArchitexFeePlugin).interfaceId || super.supportsInterface(id);
    }

    function setGraduatedToken(address t) external {
        graduatedToken = t;
    }

    function errorsLength() external view returns (uint256) {
        return errors.length;
    }

    function _attempt(address token) internal {
        try pad.buy(token, 1e6, 0, address(this)) {
            anyReentrySucceeded = true;
        } catch (bytes memory e) {
            errors.push(bytes4(e));
        }
        try pad.sell(token, 1, 0, address(this)) {
            anyReentrySucceeded = true;
        } catch (bytes memory e) {
            errors.push(bytes4(e));
        }
        try pad.collectCreatorFees(token) {
            anyReentrySucceeded = true;
        } catch (bytes memory e) {
            errors.push(bytes4(e));
        }
        try pad.collectFees() {
            anyReentrySucceeded = true;
        } catch (bytes memory e) {
            errors.push(bytes4(e));
        }
        try pad.createToken("Re", "RE", "", 0, address(this), "", 0, 0, type(uint256).max) {
            anyReentrySucceeded = true;
        } catch (bytes memory e) {
            errors.push(bytes4(e));
        }
        if (graduatedToken != address(0)) {
            try router.buy(graduatedToken, 1e6, 0, address(this), block.timestamp) {
                anyReentrySucceeded = true;
            } catch (bytes memory e) {
                errors.push(bytes4(e));
            }
        }
    }

    function onLaunch(address token, address, bytes calldata) external {
        _attempt(token);
    }

    function onFees(address token, uint256 amount) external {
        _attempt(token);
        require(usdc.transferFrom(msg.sender, address(this), amount), "pull");
    }
}

/// @dev A minimal "distribute to holders" plugin: pulls exactly, then distributes through the token's dividends.
contract DistributePlugin is ERC165, IArchitexFeePlugin {
    IERC20 public immutable usdc;

    constructor(IERC20 usdc_) {
        usdc = usdc_;
    }

    function supportsInterface(bytes4 id) public view override(ERC165, IERC165) returns (bool) {
        return id == type(IArchitexFeePlugin).interfaceId || super.supportsInterface(id);
    }

    function onLaunch(address, address, bytes calldata) external {}

    function onFees(address token, uint256 amount) external {
        require(usdc.transferFrom(msg.sender, address(this), amount), "pull");
        usdc.approve(token, amount);
        ILaunchToken(token).distribute(amount);
    }
}

// ─── Shared fixture ───────────────────────────────────────────────────────────

abstract contract LaunchpadV13Base is Test {
    uint256 internal constant TOTAL_SUPPLY = 1_000_000_000e18;
    uint256 internal constant CURVE_SUPPLY = 800_000_000e18;
    uint256 internal constant POOL_SUPPLY = 200_000_000e18;
    uint256 internal constant VIRTUAL_TOKENS_0 = 1_066_666_667e18;
    uint256 internal constant VIRTUAL_USDC_0 = 8_333_333_333;
    uint256 internal constant FEE_BPS = 50;
    uint256 internal constant BPS = 10_000;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    BlockableUSDC internal usdc;
    ArchitexLaunchpad internal pad;
    LaunchPairFactory internal pairFactory;
    LaunchRouter internal router;

    address internal feeTo = makeAddr("feeTo");
    address internal setter = makeAddr("setter");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal mallory = makeAddr("mallory");
    address internal creatorWallet = makeAddr("creatorWallet");

    event Trade(
        address indexed token,
        address indexed trader,
        bool isBuy,
        uint256 usdcAmount,
        uint256 tokenAmount,
        uint256 platformFee,
        uint256 creatorFee,
        uint256 virtualUsdc,
        uint256 virtualTokens
    );

    function setUp() public virtual {
        usdc = new BlockableUSDC();
        (pad, pairFactory, router) = _deploySuite(address(usdc), 0);
        _fund(alice);
        _fund(bob);
        _fund(carol);
        _fund(mallory);
    }

    /// @dev The v1.3 deploy order (V13-SPEC §5), with this test contract as the deployer.
    function _deploySuite(address usdc_, uint256 launchFee)
        internal
        returns (ArchitexLaunchpad p, LaunchPairFactory f, LaunchRouter r)
    {
        p = new ArchitexLaunchpad(usdc_, feeTo, setter, launchFee);
        f = new LaunchPairFactory(address(p));
        r = new LaunchRouter(address(p), address(f), usdc_);
        p.initialize(address(f), address(r));
    }

    function _fund(address who) internal {
        usdc.mint(who, 100_000_000e6);
        vm.startPrank(who);
        usdc.approve(address(pad), type(uint256).max);
        usdc.approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    /// @dev alice launches; fees go to `plugin`.
    function _create(uint16 creatorFeeBps, address plugin) internal returns (address token) {
        vm.prank(alice);
        token = pad.createToken("Vector", "VEC", "", creatorFeeBps, plugin, "", 0, 0, type(uint256).max);
    }

    /// @dev alice launches with no creator fee, paying the creator wallet.
    function _create() internal returns (address token) {
        return _create(0, creatorWallet);
    }

    /// @dev bob buys out the curve (graduating it).
    function _graduate(address token) internal {
        vm.prank(bob);
        pad.buy(token, 1_000_000e6, 0, bob);
        assertTrue(pad.isGraduated(token), "graduated");
    }

    function _float(address token) internal view returns (uint256) {
        IArchitexLaunchpad.Curve memory c = pad.curves(token);
        return c.graduated ? 0 : uint256(c.virtualUsdc) - VIRTUAL_USDC_0;
    }

    /// @dev What the launchpad owes: platform fees, every token's creator fees, every live curve's float.
    function _owed() internal view returns (uint256 owed) {
        owed = pad.pendingFees();
        uint256 n = pad.tokensLength();
        for (uint256 i = 0; i < n; i++) {
            address t = pad.tokenAt(i);
            owed += pad.pendingCreatorFees(t) + _float(t);
        }
    }

    /// @dev V13-SPEC §6.1: USDC held == pendingFees + Σ pendingCreatorFees + Σ live floats, to the unit.
    function _assertSolvent() internal view {
        assertEq(usdc.balanceOf(address(pad)), _owed(), "USDC held == fees + creator fees + curve floats");
    }

    function _divCeil(uint256 a, uint256 b) internal pure returns (uint256) {
        return (a + b - 1) / b;
    }

    function _pairOf(address token) internal view returns (LaunchPair) {
        return LaunchPair(pad.pairOf(token));
    }
}
