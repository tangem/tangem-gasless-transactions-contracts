// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

import {IGasOverhead} from "../interfaces/IGasOverhead.sol";

interface IArbGasInfo {
    function getCurrentTxL1GasFees() external view returns (uint256);
}

interface IGasPriceOracle {
    function getL1FeeUpperBound(uint256 _unsignedTxSize) external view returns (uint256);
}

/// @title Post-call gas reserve and L1 data fee for the configured chain type
abstract contract GasOverhead is IGasOverhead {
    IArbGasInfo private constant ARB_GAS_INFO = IArbGasInfo(0x000000000000000000000000000000000000006C);

    // Requires the Fjord upgrade
    IGasPriceOracle private constant OP_GAS_PRICE_ORACLE = IGasPriceOracle(0x420000000000000000000000000000000000000F);

    // Estimated size of the non-data transaction fields
    uint256 private constant OP_TX_OVERHEAD = 80;

    // Extra `executor` argument of the EntryPoint call
    uint256 private constant ENTRY_POINT_OVERHEAD = 32;

    /// @inheritdoc IGasOverhead
    uint256 public immutable BASE_GAS_AFTER_CALL;

    /// @inheritdoc IGasOverhead
    L1FeeMode public immutable L1_FEE_MODE;

    /// @dev Reverts on a zero reserve or if the selected oracle is missing or has another interface.
    constructor(uint256 baseGasAfterCall_, L1FeeMode l1FeeMode_) {
        require(baseGasAfterCall_ != 0, ZeroBaseGasAfterCall());

        BASE_GAS_AFTER_CALL = baseGasAfterCall_;
        L1_FEE_MODE = l1FeeMode_;

        if (l1FeeMode_ != L1FeeMode.None) {
            address oracle = l1FeeMode_ == L1FeeMode.Arbitrum
                ? address(ARB_GAS_INFO)
                : address(OP_GAS_PRICE_ORACLE);

            require(oracle.code.length != 0, L1FeeOracleNotDeployed(oracle));

            // Probe call: reverts if the oracle has another interface
            _getL1Fee();
        }
    }

    /// @notice L1 data fee in wei for the current transaction.
    /// @dev The OP Stack oracle takes the unsigned tx size and adds the signature size itself.
    function _getL1Fee() internal view returns (uint256) {
        if (L1_FEE_MODE == L1FeeMode.Arbitrum) {
            return ARB_GAS_INFO.getCurrentTxL1GasFees();
        }

        if (L1_FEE_MODE == L1FeeMode.OpStack) {
            uint256 unsignedTxSize = msg.data.length + OP_TX_OVERHEAD + ENTRY_POINT_OVERHEAD;

            return OP_GAS_PRICE_ORACLE.getL1FeeUpperBound(unsignedTxSize);
        }

        return 0;
    }
}
