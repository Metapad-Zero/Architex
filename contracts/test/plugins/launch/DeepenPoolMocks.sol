// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {LaunchPair} from "../../../launchpad/LaunchPair.sol";
import {MockLaunchpad} from "./LaunchPluginMocks.sol";

// Stand-ins for Deepen pool's pool path. The unit tests pair them with the REAL LaunchPair (mint, swap, skim and sync
// as deployed), so only the router, and in one test the pair, is a mock.

/// @notice The launch router's exact-in buy, with the real router's arithmetic (both fees rounded up on the USDC in,
///         `net * reserveToken / (reserveUsdc + net)` out) against the token's pair, which must name this contract as
///         its router. The fees go to the launchpad (the mock just holds them). Knobs make it misbehave.
contract DeepenMockRouter {
    using SafeERC20 for IERC20;

    MockLaunchpad public immutable launchpad;
    IERC20 public immutable usdc;

    /// @notice Misbehaviour: pulls this much less than usdcIn (the pair gets correspondingly less).
    uint256 public pullShortfall;
    /// @notice Misbehaviour: reports this many more tokens than it delivered.
    uint256 public reportSkew;
    /// @notice Misbehaviour: delivers the tokens here instead of to the buyer.
    address public divertTo;

    uint256 public buyCalls;
    uint256 public lastUsdcIn;
    uint256 public lastMinOut;
    address public lastTo;
    uint256 public lastDeadline;

    constructor(MockLaunchpad launchpad_) {
        launchpad = launchpad_;
        usdc = IERC20(launchpad_.usdc());
    }

    function setPullShortfall(uint256 v) external {
        pullShortfall = v;
    }

    function setReportSkew(uint256 v) external {
        reportSkew = v;
    }

    function setDivertTo(address v) external {
        divertTo = v;
    }

    function quoteBuy(address token, uint256 usdcIn)
        public
        view
        returns (uint256 tokensOut, uint256 platformFee, uint256 creatorFee)
    {
        platformFee = _divCeil(usdcIn * launchpad.FEE_BPS(), 10_000);
        creatorFee = _divCeil(usdcIn * launchpad.creatorFeeBpsOf(token), 10_000);
        require(platformFee + creatorFee < usdcIn, "zero amount");
        uint256 net = usdcIn - platformFee - creatorFee;
        (uint112 reserveToken, uint112 reserveUsdc,) = LaunchPair(launchpad.pairOf(token)).getReserves();
        tokensOut = net * reserveToken / (uint256(reserveUsdc) + net);
        require(tokensOut != 0, "zero amount");
    }

    function buy(address token, uint256 usdcIn, uint256 minTokensOut, address to, uint256 deadline)
        external
        returns (uint256 tokensOut)
    {
        require(deadline >= block.timestamp, "expired");
        require(launchpad.isGraduated(token), "not graduated");
        buyCalls += 1;
        lastUsdcIn = usdcIn;
        lastMinOut = minTokensOut;
        lastTo = to;
        lastDeadline = deadline;

        uint256 pulled = usdcIn - pullShortfall;
        (uint256 out, uint256 platformFee, uint256 creatorFee) = quoteBuy(token, pulled);
        require(out >= minTokensOut, "slippage");
        address pair = launchpad.pairOf(token);
        usdc.safeTransferFrom(msg.sender, address(launchpad), platformFee + creatorFee);
        usdc.safeTransferFrom(msg.sender, pair, pulled - platformFee - creatorFee);
        LaunchPair(pair).swap(out, 0, divertTo == address(0) ? to : divertTo);
        tokensOut = out + reportSkew;
    }

    function _divCeil(uint256 a, uint256 b) private pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }
}

/// @notice A launch pair with LaunchPair's arithmetic whose mint credits `mintSkew` LP more than the formula (or
///         fewer, if `mintShort`): stands in for a pair that does not do what the plugin computes.
contract SkewedMintPair is ERC20 {
    using SafeERC20 for IERC20;

    address public immutable token;
    address public immutable usdc;
    address public immutable router;
    uint112 private _reserveToken;
    uint112 private _reserveUsdc;
    uint256 public mintSkew;
    bool public mintShort;

    constructor(address token_, address usdc_, address router_) ERC20("Skewed LP", "SLP") {
        token = token_;
        usdc = usdc_;
        router = router_;
    }

    function setMintSkew(uint256 skew, bool short_) external {
        mintSkew = skew;
        mintShort = short_;
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (_reserveToken, _reserveUsdc, 0);
    }

    function mint(address to) external returns (uint256 liquidity) {
        uint256 balanceToken = IERC20(token).balanceOf(address(this));
        uint256 balanceUsdc = IERC20(usdc).balanceOf(address(this));
        uint256 amountToken = balanceToken - _reserveToken;
        uint256 amountUsdc = balanceUsdc - _reserveUsdc;
        uint256 supply = totalSupply();
        if (supply == 0) {
            liquidity = Math.sqrt(amountToken * amountUsdc) - 1000;
            _mint(0x000000000000000000000000000000000000dEaD, 1000);
        } else {
            liquidity = Math.min(amountToken * supply / _reserveToken, amountUsdc * supply / _reserveUsdc);
            liquidity = mintShort ? liquidity - mintSkew : liquidity + mintSkew;
        }
        _mint(to, liquidity);
        _reserveToken = uint112(balanceToken);
        _reserveUsdc = uint112(balanceUsdc);
    }

    function sync() external {
        _reserveToken = uint112(IERC20(token).balanceOf(address(this)));
        _reserveUsdc = uint112(IERC20(usdc).balanceOf(address(this)));
    }

    function swap(uint256 tokenOut, uint256 usdcOut, address to) external {
        require(msg.sender == router, "router only");
        if (tokenOut != 0) IERC20(token).safeTransfer(to, tokenOut);
        if (usdcOut != 0) IERC20(usdc).safeTransfer(to, usdcOut);
        _reserveToken = uint112(IERC20(token).balanceOf(address(this)));
        _reserveUsdc = uint112(IERC20(usdc).balanceOf(address(this)));
    }
}
