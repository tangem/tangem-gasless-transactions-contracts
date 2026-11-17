// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

interface IGasOverhead {
    /// @notice L1 data fee source: none, Arbitrum ArbGasInfo or OP Stack GasPriceOracle.
    enum L1FeeMode {
        None,
        Arbitrum,
        OpStack
    }

    /// @notice Gas a CALL charges the caller, set per network fork.
    struct CallGasCosts {
        uint256 coldAccountAccessCost;
        uint256 valueTransferCost;
        uint256 newAccountCost;
    }

    /// @notice Thrown when `baseGasAfterCall` is zero.
    error ZeroBaseGasAfterCall();

    /// @notice Thrown when any call gas cost is zero.
    error ZeroCallGasCost();

    /// @notice Thrown when the selected L1 fee oracle has no code.
    error L1FeeOracleNotDeployed(address oracle);
}
