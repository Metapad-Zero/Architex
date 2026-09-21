// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";
import {IArchitexFeePlugin} from "../../../interfaces/IArchitexFeePlugin.sol";
import {IArchitexLaunchpadLite} from "../../../interfaces/IArchitexLaunchpadLite.sol";
import {ILaunchTokenExtensions} from "../../../interfaces/ILaunchTokenExtensions.sol";

// Minimal stand-ins for the v1.3 launchpad, launch token v2, launch pair and launch router, written against the
// committed interfaces only (the real implementations are being built in parallel). Each mock models the part of
// V13-SPEC the plugins depend on, plus knobs to make it misbehave.

/// @notice A v2 launch token reduced to what the plugins use: burn, distribute (pulls USDC from the caller) and
///         eligibleSupply (total supply minus the launchpad, pair and burn-address balances, or a forced value).
contract MockLaunchToken is ERC20, ILaunchTokenExtensions {
    using SafeERC20 for IERC20;

    address private constant DEAD = 0x000000000000000000000000000000000000dEaD;

    address public immutable usdc;
    address public immutable launchpad;
    address public pair;

    uint256 public totalDistributed;
    uint256 public burnCalls;
    uint256 public totalBurned;

    bool public eligibleForced;
    uint256 public forcedEligible;
    /// @notice Misbehaviour: distribute pulls this much less than it is asked to.
    uint256 public distributeShortfall;

    constructor(address usdc_, address launchpad_) ERC20("Launch Token", "LAUNCH") {
        usdc = usdc_;
        launchpad = launchpad_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setPair(address pair_) external {
        pair = pair_;
    }

    function forceEligibleSupply(uint256 value) external {
        eligibleForced = true;
        forcedEligible = value;
    }

    function setDistributeShortfall(uint256 shortfall) external {
        distributeShortfall = shortfall;
    }

    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
        burnCalls += 1;
        totalBurned += amount;
    }

    function distribute(uint256 amount) external {
        if (eligibleSupply() == 0) revert NoEligibleSupply();
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), amount - distributeShortfall);
        totalDistributed += amount;
        emit DividendsDistributed(msg.sender, amount);
    }

    function eligibleSupply() public view returns (uint256) {
        if (eligibleForced) return forcedEligible;
        uint256 excluded = balanceOf(launchpad) + balanceOf(DEAD) + (pair == address(0) ? 0 : balanceOf(pair));
        return totalSupply() - excluded;
    }

    function isExcluded(address account) external view returns (bool) {
        return account == launchpad || account == pair || account == DEAD || account == address(0);
    }

    function claimable(address) external pure returns (uint256) {
        return 0;
    }

    function claim() external pure returns (uint256) {
        return 0;
    }

    function claimFor(address) external pure returns (uint256) {
        return 0;
    }
}

/// @notice A launch pair reduced to getReserves (token first, USDC second, as ILaunchPair defines).
contract MockLaunchPair {
    uint112 private _reserveToken;
    uint112 private _reserveUsdc;

    function setReserves(uint112 reserveToken_, uint112 reserveUsdc_) external {
        _reserveToken = reserveToken_;
        _reserveUsdc = reserveUsdc_;
    }

    function addUsdc(uint256 amount) external {
        _reserveUsdc += uint112(amount);
    }

    function getReserves() external view returns (uint112 reserveToken, uint112 reserveUsdc, uint32 blockTimestampLast) {
        return (_reserveToken, _reserveUsdc, 0);
    }
}

/// @notice The v1.3 launchpad as far as the plugins can see it (IArchitexLaunchpadLite), plus:
///         - launch(): registers the curve (plugin included), then calls onLaunch if the plugin declares the hooks,
///           in the order createToken uses;
///         - collect(): collectCreatorFees as V13-SPEC §2.1 specifies (approve, onFees, exact-pull + zero-allowance
///           check), or a plain transfer for a plugin that does not declare the hooks;
///         - a curve buy that, like v1.2's, pulls only usdcSpent (<= usdcIn) and graduates on the sell-out buy.
contract MockLaunchpad is IArchitexLaunchpadLite {
    using SafeERC20 for IERC20;

    uint256 public constant FEE_BPS = 50;
    uint256 public constant VIRTUAL_USDC_0 = 8_333_333_333;
    uint256 private constant NO_SELL_OUT = type(uint256).max;

    struct Launch {
        address plugin;
        address creator;
        address pair;
        bool graduated;
        uint256 virtualUsdc;
        uint256 sellOutCost;
    }

    address public immutable usdc;
    address public router;
    address public pairFactory;
    /// @notice Every pair a launch registered, as the real launchpad records the pairs createToken creates.
    mapping(address pair => bool) public isLaunchPair;
    mapping(address token => Launch) private _launches;

    /// @notice Curve price: launch-token base units per USDC unit (1e14 = 100 tokens per USDC).
    uint256 public tokensPerUsdcUnit = 1e14;
    /// @notice Misbehaviour: buy reports this much more USDC spent than it pulled.
    uint256 public reportedSpendSkew;
    /// @notice Misbehaviour: buy takes the USDC but delivers no tokens.
    bool public withholdTokens;
    /// @notice During a buy, sends this much USDC (which it must hold) to the buyer.
    uint256 public donateDuringBuy;

    uint256 public buyCalls;
    uint256 public lastBuyUsdcIn;
    uint256 public lastBuyMinOut;
    address public lastBuyTo;
    uint256 public lastBuyDeadline;

    constructor(address usdc_) {
        usdc = usdc_;
    }

    // ─── Test knobs ───────────────────────────────────────────────────────────

    function setRouter(address router_) external {
        router = router_;
    }

    function setPairFactory(address pairFactory_) external {
        pairFactory = pairFactory_;
    }

    function setGraduated(address token, bool graduated) external {
        _launches[token].graduated = graduated;
    }

    function setVirtualUsdc(address token, uint256 value) external {
        _launches[token].virtualUsdc = value;
    }

    function setPair(address token, address pair) external {
        _launches[token].pair = pair;
        if (pair != address(0)) isLaunchPair[pair] = true;
    }

    /// @notice USDC that buys out the rest of the curve; a buy offering at least this is the sell-out buy.
    function setSellOutCost(address token, uint256 cost) external {
        _launches[token].sellOutCost = cost;
    }

    function setReportedSpendSkew(uint256 skew) external {
        reportedSpendSkew = skew;
    }

    function setWithholdTokens(bool withhold) external {
        withholdTokens = withhold;
    }

    function setDonateDuringBuy(uint256 amount) external {
        donateDuringBuy = amount;
    }

    // ─── Launch / collect ─────────────────────────────────────────────────────

    function register(address token, address creator, address plugin, address pair) public {
        require(_launches[token].plugin == address(0), "already launched");
        require(plugin != address(0), "zero plugin");
        _launches[token] = Launch(plugin, creator, pair, false, VIRTUAL_USDC_0, NO_SELL_OUT);
        if (pair != address(0)) isLaunchPair[pair] = true;
    }

    function launch(address token, address creator, address plugin, address pair, bytes calldata data) external {
        register(token, creator, plugin, pair);
        if (ERC165Checker.supportsInterface(plugin, type(IArchitexFeePlugin).interfaceId)) {
            IArchitexFeePlugin(plugin).onLaunch(token, creator, data);
        }
    }

    /// @notice Makes the launchpad call onLaunch on any plugin for any token (to test plugins' own checks).
    function callOnLaunch(address plugin, address token, address creator, bytes calldata data) external {
        IArchitexFeePlugin(plugin).onLaunch(token, creator, data);
    }

    function collect(address token, uint256 amount) external {
        address plugin = _launches[token].plugin;
        IERC20 usdcToken = IERC20(usdc);
        if (ERC165Checker.supportsInterface(plugin, type(IArchitexFeePlugin).interfaceId)) {
            uint256 balanceBefore = usdcToken.balanceOf(address(this));
            usdcToken.forceApprove(plugin, amount);
            IArchitexFeePlugin(plugin).onFees(token, amount);
            require(usdcToken.balanceOf(address(this)) + amount == balanceBefore, "plugin pull mismatch");
            require(usdcToken.allowance(address(this), plugin) == 0, "allowance left");
        } else {
            usdcToken.safeTransfer(plugin, amount);
        }
    }

    // ─── IArchitexLaunchpadLite ───────────────────────────────────────────────

    function pluginOf(address token) external view returns (address) {
        return _launches[token].plugin;
    }

    function creatorOf(address token) external view returns (address) {
        return _launches[token].creator;
    }

    function creatorFeeBpsOf(address token) external view returns (uint16) {
        return _launches[token].plugin == address(0) ? 0 : 100;
    }

    function pairOf(address token) external view returns (address) {
        return _launches[token].pair;
    }

    function isGraduated(address token) external view returns (bool) {
        return _launches[token].graduated;
    }

    function virtualUsdcOf(address token) external view returns (uint256) {
        return _launches[token].plugin == address(0) ? 0 : _launches[token].virtualUsdc;
    }

    function buy(address token, uint256 usdcIn, uint256 minTokensOut, address to, uint256 deadline)
        external
        returns (uint256 tokensOut, uint256 usdcSpent)
    {
        require(deadline >= block.timestamp, "expired");
        Launch storage l = _launches[token];
        require(l.plugin != address(0), "unknown token");
        require(!l.graduated, "graduated");
        require(usdcIn != 0, "zero amount");
        buyCalls += 1;
        lastBuyUsdcIn = usdcIn;
        lastBuyMinOut = minTokensOut;
        lastBuyTo = to;
        lastBuyDeadline = deadline;

        bool sellOut = usdcIn >= l.sellOutCost;
        usdcSpent = sellOut ? l.sellOutCost : usdcIn;
        tokensOut = usdcSpent * tokensPerUsdcUnit;
        require(tokensOut != 0 && tokensOut >= minTokensOut, "slippage");

        l.virtualUsdc += usdcSpent;
        if (l.sellOutCost != NO_SELL_OUT) l.sellOutCost -= usdcSpent;
        if (sellOut) l.graduated = true;

        IERC20(usdc).safeTransferFrom(msg.sender, address(this), usdcSpent);
        if (donateDuringBuy != 0) IERC20(usdc).safeTransfer(msg.sender, donateDuringBuy);
        if (!withholdTokens) MockLaunchToken(token).mint(to, tokensOut);
        usdcSpent += reportedSpendSkew;
    }

    function accrueTradeFees(address, uint256, uint256) external pure {
        revert("router only");
    }
}

/// @notice The launch router's exact-in buy, for graduated tokens only: pulls usdcIn into the pair, mints tokens.
contract MockLaunchRouter {
    using SafeERC20 for IERC20;

    MockLaunchpad public immutable launchpad;
    uint256 public tokensPerUsdcUnit = 1e14;
    /// @notice Misbehaviour: pulls this much less than usdcIn.
    uint256 public pullShortfall;

    uint256 public buyCalls;
    uint256 public lastUsdcIn;
    uint256 public lastMinOut;
    address public lastTo;
    uint256 public lastDeadline;

    constructor(MockLaunchpad launchpad_) {
        launchpad = launchpad_;
    }

    function setPullShortfall(uint256 shortfall) external {
        pullShortfall = shortfall;
    }

    function buy(address token, uint256 usdcIn, uint256 minTokensOut, address to, uint256 deadline)
        external
        returns (uint256 tokensOut)
    {
        require(deadline >= block.timestamp, "expired");
        require(launchpad.isGraduated(token), "not graduated");
        require(usdcIn != 0, "zero amount");
        buyCalls += 1;
        lastUsdcIn = usdcIn;
        lastMinOut = minTokensOut;
        lastTo = to;
        lastDeadline = deadline;

        uint256 pulled = usdcIn - pullShortfall;
        address pair = launchpad.pairOf(token);
        IERC20(launchpad.usdc()).safeTransferFrom(msg.sender, pair, pulled);
        MockLaunchPair(pair).addUsdc(pulled);
        tokensOut = pulled * tokensPerUsdcUnit;
        require(tokensOut >= minTokensOut, "slippage");
        MockLaunchToken(token).mint(to, tokensOut);
    }
}

/// @notice Declares IArchitexFeePlugin; takes any configuration from anyone and pulls exactly what it is sent.
///         Stands in for a well-behaved third-party (custom) plugin.
contract RecordingPlugin is IArchitexFeePlugin {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    mapping(address token => bytes) public launchData;
    mapping(address token => uint256) public received;
    uint256 public launchCalls;

    constructor(address usdc_) {
        usdc = IERC20(usdc_);
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IArchitexFeePlugin).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    function onLaunch(address token, address, bytes calldata data) external {
        launchData[token] = data;
        launchCalls += 1;
    }

    function onFees(address token, uint256 amount) external {
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        received[token] += amount;
    }
}

/// @notice Declares IArchitexFeePlugin but pulls `shortfall` less than asked, then optionally sends `refund` back.
contract ShortPullPlugin is IArchitexFeePlugin {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    uint256 public shortfall;
    uint256 public refund;

    constructor(address usdc_, uint256 shortfall_, uint256 refund_) {
        usdc = IERC20(usdc_);
        shortfall = shortfall_;
        refund = refund_;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IArchitexFeePlugin).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    function onLaunch(address, address, bytes calldata) external {}

    function onFees(address, uint256 amount) external {
        if (amount > shortfall) usdc.safeTransferFrom(msg.sender, address(this), amount - shortfall);
        if (refund != 0) usdc.safeTransfer(msg.sender, refund);
    }
}

/// @notice Declares IArchitexFeePlugin and, on onFees, re-enters its caller's onFees for the same token.
contract ReentrantPlugin is IArchitexFeePlugin {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;

    constructor(address usdc_) {
        usdc = IERC20(usdc_);
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IArchitexFeePlugin).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    function onLaunch(address, address, bytes calldata) external {}

    function onFees(address token, uint256 amount) external {
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        usdc.forceApprove(msg.sender, amount);
        IArchitexFeePlugin(msg.sender).onFees(token, amount);
    }
}

/// @notice An arbitrary contract a creator can register as a token's plugin ("custom address"). It can call
///         onLaunch on other plugins for the tokens it is registered for — exactly what a Combo does.
contract ConfiguringContract {
    function configure(address plugin, address token, address creator, bytes calldata data) external {
        IArchitexFeePlugin(plugin).onLaunch(token, creator, data);
    }
}
