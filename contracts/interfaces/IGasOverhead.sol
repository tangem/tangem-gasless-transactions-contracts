// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

interface IGasOverhead {
    /// @notice L1 data fee source: none, Arbitrum ArbGasInfo or OP Stack GasPriceOracle.
    enum L1FeeMode {
        None,
        Arbitrum,
        OpStack
    }

    error ZeroBaseGasAfterCall();

    /// @param oracle Oracle address without code.
    error L1FeeOracleNotDeployed(address oracle);

    /// @notice Gas reserved for everything after the user call, except the fee transfer.
    function BASE_GAS_AFTER_CALL() external view returns (uint256);

    /// @notice L1 data fee source set at deployment.
    function L1_FEE_MODE() external view returns (L1FeeMode);
}
