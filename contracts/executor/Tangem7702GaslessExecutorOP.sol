// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;
import {Tangem7702GaslessExecutor} from "./Tangem7702GaslessExecutor.sol";

/// @notice Interface for OP Stack GasPriceOracle predeploy
interface IGasPriceOracle {
    function getL1FeeUpperBound(uint256 _unsignedTxSize) external view returns (uint256);
}

/// @title Tangem 7702 Gasless Executor for OP Stack chains (Base, Optimism, Mode, etc.)
/// @notice Uses GasPriceOracle.getL1FeeUpperBound for gas-efficient L1 fee estimation
/// @dev Requires Fjord upgrade (Base: July 2024, OP Mainnet: July 2024)
// layout at keccak256(abi.encode(uint256(keccak256(bytes(tangem.storage.Tangem7702GaslessExecutor))) - 1)) & ~bytes32(uint256(0xff))
contract Tangem7702GaslessExecutorOP is
    Tangem7702GaslessExecutor
    layout at 0x63126cb0ee213fd665c396acd692b9c0a13c8cc8bbd732af4f146bb546be9800
{
    // OP Stack GasPriceOracle (Base, Optimism, etc.)
    IGasPriceOracle private constant OP_GAS_PRICE_ORACLE = IGasPriceOracle(0x420000000000000000000000000000000000000F);
    
    // Transaction overhead (non-data, non-signature fields)
    // Conservative estimate: ~80 bytes for typical transaction
    uint256 private constant TX_OVERHEAD = 80;

    // Entry point overhead: 32 bytes for extra "executor" parameter in the initial call data when called via entry point
    uint256 private constant ENTRY_POINT_OVERHEAD = 32;

    /// @inheritdoc Tangem7702GaslessExecutor
    function _getL1Fee() internal view override returns (uint256) {
        // getL1FeeUpperBound expects: msg.data + other fields (NOT signature)
        // It adds 68 bytes internally for signature
        uint256 unsignedTxSize = msg.data.length + TX_OVERHEAD + ENTRY_POINT_OVERHEAD;

        return OP_GAS_PRICE_ORACLE.getL1FeeUpperBound(unsignedTxSize);
    }

    // Tangem7702GaslessExecutorOP.sol
    /// @inheritdoc Tangem7702GaslessExecutor
    function _baseGasAfterCall() internal pure override returns (uint256) {
        return 18000; // GasPriceOracle predeploy can be expensive when cold (~11k gas)
    }
}