// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @title A creator-fee plugin for the Architex launchpad v1.3 (docs/launchpad/V13-SPEC.md §2.1).
/// @notice A token's plugin is fixed at launch. The launchpad calls these hooks only if the plugin declares
///         this interface through ERC-165; any other address (a wallet, a Safe) just receives USDC.
interface IArchitexFeePlugin is IERC165 {
    /// @notice Called once inside createToken, after the curve is registered and before the creator's first buy.
    /// @dev Listed plugins accept this only from the launchpad or from the token's registered plugin (a Combo),
    ///      because launch-token addresses are predictable. Configuration is write-once per token.
    /// @param data The creator's configuration for this plugin (format defined by each plugin).
    function onLaunch(address token, address creator, bytes calldata data) external;

    /// @notice Delivers `amount` of `token`'s creator fees. The plugin MUST pull exactly `amount` USDC from
    ///         msg.sender with transferFrom. Credits are therefore always backed by USDC received in the same call.
    function onFees(address token, uint256 amount) external;
}
