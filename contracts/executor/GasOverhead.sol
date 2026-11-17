// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

import {IGasOverhead} from "../interfaces/IGasOverhead.sol";

interface IArbGasInfo {
    function getCurrentTxL1GasFees() external view returns (uint256);
}

interface IGasPriceOracle {
    function getL1FeeUpperBound(uint256 _unsignedTxSize) external view returns (uint256);
}

/// @title Gas reserves and L1 data fee for the configured chain type
abstract contract GasOverhead is IGasOverhead {
    IArbGasInfo private constant ARB_GAS_INFO = IArbGasInfo(0x000000000000000000000000000000000000006C);
    IGasPriceOracle private constant OP_GAS_PRICE_ORACLE = IGasPriceOracle(0x420000000000000000000000000000000000000F);

    /// @dev Estimated size of the non-data transaction fields
    uint256 private constant OP_TX_OVERHEAD = 80;

    /// @dev Extra `executor` argument of the EntryPoint call
    uint256 private constant ENTRY_POINT_OVERHEAD = 32;

    /// @dev Calldata gas per byte, priced as a non-zero byte
    uint256 private constant CALLDATA_GAS_PER_BYTE = 16;

    /// @notice Gas reserved for everything after the user call, except the fee transfer.
    uint256 public immutable BASE_GAS_AFTER_CALL;

    /// @notice Access cost of a CALL to a cold address.
    uint256 public immutable COLD_ACCOUNT_ACCESS_COST;

    /// @notice Extra gas of a CALL with value.
    uint256 public immutable VALUE_TRANSFER_COST;

    /// @notice Extra gas of a CALL with value to a new account.
    uint256 public immutable NEW_ACCOUNT_COST;

    /// @notice L1 data fee source set at deployment.
    L1FeeMode public immutable L1_FEE_MODE;

    /// @dev Reverts on zero gas values or if the selected oracle is missing or has another interface.
    constructor(uint256 baseGasAfterCall_, L1FeeMode l1FeeMode_, CallGasCosts memory callGasCosts_) {
        require(baseGasAfterCall_ != 0, ZeroBaseGasAfterCall());
        require(
            callGasCosts_.coldAccountAccessCost != 0 && callGasCosts_.valueTransferCost != 0
                && callGasCosts_.newAccountCost != 0,
            ZeroCallGasCost()
        );

        BASE_GAS_AFTER_CALL = baseGasAfterCall_;
        COLD_ACCOUNT_ACCESS_COST = callGasCosts_.coldAccountAccessCost;
        VALUE_TRANSFER_COST = callGasCosts_.valueTransferCost;
        NEW_ACCOUNT_COST = callGasCosts_.newAccountCost;
        L1_FEE_MODE = l1FeeMode_;

        if (l1FeeMode_ != L1FeeMode.None) {
            address oracle = l1FeeMode_ == L1FeeMode.Arbitrum ? address(ARB_GAS_INFO) : address(OP_GAS_PRICE_ORACLE);

            require(oracle.code.length != 0, L1FeeOracleNotDeployed(oracle));

            // Probe call: reverts if the oracle has another interface
            _getL1Fee();
        }
    }

    /// @notice Access and value gas of a CALL to `to` with `value`, assuming `to` is cold.
    /// @dev Zero codehash means the transfer creates the account.
    function _callOverhead(address to, uint256 value) internal view returns (uint256 overhead) {
        overhead = COLD_ACCOUNT_ACCESS_COST;

        if (value > 0) {
            overhead += VALUE_TRANSFER_COST;

            if (to.codehash == bytes32(0)) {
                overhead += NEW_ACCOUNT_COST;
            }
        }
    }

    /// @notice Upper bound of the calldata gas of the EntryPoint transaction.
    function _calldataGas() internal pure returns (uint256) {
        return (msg.data.length + ENTRY_POINT_OVERHEAD) * CALLDATA_GAS_PER_BYTE;
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
