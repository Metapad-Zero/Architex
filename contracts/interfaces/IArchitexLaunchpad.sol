// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Frozen ABI of the Architex launchpad (docs/launchpad/LAUNCHPAD-SPEC.md). The frontend is built against it.
interface IArchitexLaunchpad {
    struct Curve {
        address token;
        address creator;
        address pair; // Architex pair for (token, USDC); holds liquidity only after graduation
        uint128 virtualUsdc; // 6 decimals
        uint128 virtualTokens; // 18 decimals
        uint128 tokensSold; // 18 decimals, at most CURVE_SUPPLY
        uint64 createdAt;
        bool graduated;
        string metadataURI;
    }

    event TokenCreated(address indexed token, address indexed creator, address indexed pair, string name, string symbol, string metadataURI);
    event Trade(
        address indexed token,
        address indexed trader,
        bool isBuy,
        uint256 usdcAmount, // gross USDC paid by a buyer, or gross USDC leaving the curve on a sell
        uint256 tokenAmount,
        uint256 fee,
        uint256 virtualUsdc,
        uint256 virtualTokens
    );
    event Graduated(address indexed token, address indexed pair, uint256 usdcSeeded, uint256 tokensSeeded, uint256 liquidityLocked);
    event FeeToUpdated(address indexed feeTo);
    event FeeToSetterUpdated(address indexed feeToSetter);
    event LaunchFeeUpdated(uint256 launchFee);

    error ZeroAddress();
    error ZeroAmount();
    error Forbidden();
    error UnknownToken();
    error CurveGraduated();
    error SlippageExceeded();
    error InvalidName();
    error InvalidSymbol();
    error InvalidMetadata();
    error LaunchFeeTooHigh();

    function usdc() external view returns (address);
    function factory() external view returns (address);
    function feeTo() external view returns (address);
    function feeToSetter() external view returns (address);
    function launchFee() external view returns (uint256);

    function TOTAL_SUPPLY() external view returns (uint256);
    function CURVE_SUPPLY() external view returns (uint256);
    function POOL_SUPPLY() external view returns (uint256);
    function VIRTUAL_TOKENS_0() external view returns (uint256);
    function VIRTUAL_USDC_0() external view returns (uint256);
    function FEE_BPS() external view returns (uint256);
    function MAX_LAUNCH_FEE() external view returns (uint256);

    /// @param initialBuyUsdc gross USDC the creator spends on the curve in the same transaction (0 for none)
    function createToken(string calldata name, string calldata symbol, string calldata metadataURI, uint256 initialBuyUsdc, uint256 minTokensOut)
        external
        returns (address token);

    /// @return tokensOut tokens received @return usdcSpent gross USDC actually pulled (less than usdcIn only on the buy that sells out the curve)
    function buy(address token, uint256 usdcIn, uint256 minTokensOut, address to) external returns (uint256 tokensOut, uint256 usdcSpent);

    /// @return usdcOut USDC received after the fee
    function sell(address token, uint256 tokensIn, uint256 minUsdcOut, address to) external returns (uint256 usdcOut);

    function quoteBuy(address token, uint256 usdcIn) external view returns (uint256 tokensOut, uint256 fee, uint256 usdcSpent, bool graduates);
    function quoteSell(address token, uint256 tokensIn) external view returns (uint256 usdcOut, uint256 fee);

    function curves(address token) external view returns (Curve memory);
    function tokensLength() external view returns (uint256);
    function tokenAt(uint256 index) external view returns (address);
    function curvesPage(uint256 start, uint256 count) external view returns (Curve[] memory);

    /// @return USDC (6 decimals) per whole token, scaled by 1e18
    function spotPrice(address token) external view returns (uint256);
    /// @return spot price times CURVE_SUPPLY, in USDC (6 decimals)
    function marketCap(address token) external view returns (uint256);
    /// @return tokensSold / CURVE_SUPPLY in basis points
    function progressBps(address token) external view returns (uint256);

    function setFeeTo(address feeTo) external;
    function setFeeToSetter(address feeToSetter) external;
    function setLaunchFee(uint256 launchFee) external;
}
