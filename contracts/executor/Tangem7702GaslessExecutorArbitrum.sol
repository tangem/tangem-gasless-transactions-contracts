// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;
import {Tangem7702GaslessExecutor} from "./Tangem7702GaslessExecutor.sol";

/// @notice Interface for Arbitrum ArbGasInfo precompile
interface IArbGasInfo {
    /// @notice Get the L1 fee for the current transaction (in wei)
    function getCurrentTxL1GasFees() external view returns (uint256);
}
/// @title Tangem 7702 Gasless Executor for Arbitrum chains (Arbitrum One, Nova, Orbit)
/// @notice Uses ArbGasInfo precompile to get exact L1 fee charged for this transaction
// layout at keccak256(abi.encode(uint256(keccak256(bytes(tangem.storage.Tangem7702GaslessExecutor))) - 1)) & ~bytes32(uint256(0xff))
contract Tangem7702GaslessExecutorArbitrum is
    Tangem7702GaslessExecutor
    layout at 0x63126cb0ee213fd665c396acd692b9c0a13c8cc8bbd732af4f146bb546be9800
{
    // Arbitrum ArbGasInfo precompile
    IArbGasInfo private constant ARB_GAS_INFO = IArbGasInfo(0x000000000000000000000000000000000000006C);

    /// @inheritdoc Tangem7702GaslessExecutor
    function _getL1Fee() internal view override returns (uint256) {
        return ARB_GAS_INFO.getCurrentTxL1GasFees();
    }
}