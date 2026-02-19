// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

import {ITangem7702GaslessExecutor} from "./ITangem7702GaslessExecutor.sol";

interface ITangem7702GaslessEntryPoint {
    /// @notice Thrown when `executor` does not have the expected EIP-7702 delegate set.
    /// @dev The entry point compares the current delegate code address of `executor` with `expectedDelegate`.
    /// @param executor The account (EOA) expected to delegate its code via EIP-7702.
    /// @param expectedDelegate The delegate address required by this entry point.
    /// @param actualDelegate The delegate address currently set on `executor`.
    error InvalidDelegate(address executor, address expectedDelegate, address actualDelegate);

    /// @notice Executes a user-signed gasless transaction via the EIP-7702 delegated executor.
    /// @dev Reverts with {InvalidDelegate} if `executor` is not currently delegating to the required executor implementation.
    /// @param gaslessTx The gasless transaction payload signed by the `executor` account (EIP-712).
    /// @param signature The EIP-712 signature produced by the `executor` account over `gaslessTx`.
    /// @param forced If true, exceeding `feeTransferGasLimit` is reported via an event; otherwise it reverts.
    /// @param executor The EOA executing the call (an EIP-7702 delegating account).
    function executeTransaction(
        ITangem7702GaslessExecutor.GaslessTransaction calldata gaslessTx,
        bytes calldata signature,
        bool forced,
        address executor
    )
        external;

    /// @notice Executes a user-signed batch gasless transaction via the EIP-7702 delegated executor.
    /// @dev Reverts with {InvalidDelegate} if `executor` is not currently delegating to the required executor implementation.
    /// @param gaslessTx The gasless batch transaction payload signed by the `executor` account (EIP-712).
    /// @param signature The EIP-712 signature produced by the `executor` account over `gaslessTx`.
    /// @param forced If true, batch call failures and exceeding `feeTransferGasLimit` are reported via events; otherwise they revert.
    /// @param executor The EOA executing the calls (an EIP-7702 delegating account).
    function executeBatchTransaction(
        ITangem7702GaslessExecutor.GaslessBatchTransaction calldata gaslessTx,
        bytes calldata signature,
        bool forced,
        address executor
    ) 
        external;

    /// @notice Returns the delegate address that `executor` must have set via EIP-7702.
    /// @dev This value is used to validate `executor.fetchDelegate()` before forwarding calls.
    /// @return delegate The required delegate address.
    function requiredDelegateAddress() external view returns (address delegate);
}