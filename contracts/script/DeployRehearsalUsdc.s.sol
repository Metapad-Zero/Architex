// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import "../TestToken.sol";

/// @notice Foundry broadcast script that deploys the mintable test USDC of the Arc Testnet rehearsal of launchpad v1.3
///         (docs/launchpad/V13-REHEARSAL.md): a TestToken named "Architex Rehearsal USD", symbol rUSDC, 6 decimals like
///         USDC, owned by the broadcaster so it can mint. The launchpad treats it exactly like USDC (DeployLaunchpad's
///         USDC override), so a curve can be bought out and graduated without 25,000 real test USDC.
///
///         The faucet is closed by default (FAUCET_UNITS = 0): only the owner creates rUSDC, so nobody else can trade on
///         the rehearsal deployment while it checks balances to the unit. FAUCET_UNITS=<whole tokens> opens it.
///         Refuses Arc mainnet (chain 5042): TestToken must never exist there.
///
/// Usage (the script holds no key):
///   forge script contracts/script/DeployRehearsalUsdc.s.sol:DeployRehearsalUsdc --rpc-url https://rpc.testnet.arc.io \
///     --broadcast --slow --interactive            # or --ledger --sender <address>
///   Drop --broadcast for a free simulation.
///
/// Logs one JSON line: {"usdc":"0x…","owner":"0x…","chainId":5042002}
contract DeployRehearsalUsdc is Script {
    uint256 constant ARC_MAINNET_CHAIN_ID = 5042;

    function run() external {
        require(block.chainid != ARC_MAINNET_CHAIN_ID, "rehearsal USDC refused on Arc mainnet");
        uint256 faucetUnits = vm.envOr("FAUCET_UNITS", uint256(0));

        vm.startBroadcast();
        // The broadcasting account, however it was given (--private-key, --interactive, --ledger): it owns the token.
        (, address owner,) = vm.readCallers();
        TestToken usdc = new TestToken("Architex Rehearsal USD", "rUSDC", 6, faucetUnits, owner);
        vm.stopBroadcast();

        require(
            usdc.owner() == owner && usdc.decimals() == 6 && usdc.totalSupply() == 0
                && keccak256(bytes(usdc.symbol())) == keccak256("rUSDC"),
            "deployed with wrong settings"
        );

        // solhint-disable-next-line no-console
        console.log(
            string.concat(
                '{"usdc":"',
                vm.toString(address(usdc)),
                '","owner":"',
                vm.toString(owner),
                '","chainId":',
                vm.toString(block.chainid),
                "}"
            )
        );
    }
}
