// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

/// @notice Stands in for Arbitrum ArbGasInfo and OP Stack GasPriceOracle when its code is installed at their addresses.
contract L1FeeOracleMock {
    uint256 public l1Fee;

    uint256 public l1FeePerByte;

    function setL1Fee(uint256 fee) external {
        l1Fee = fee;
    }

    function setL1FeePerByte(uint256 fee) external {
        l1FeePerByte = fee;
    }

    /// @notice ArbGasInfo
    function getCurrentTxL1GasFees() external view returns (uint256) {
        return l1Fee;
    }

    /// @notice OP Stack GasPriceOracle
    function getL1FeeUpperBound(uint256 unsignedTxSize) external view returns (uint256) {
        return unsignedTxSize * l1FeePerByte;
    }
}
