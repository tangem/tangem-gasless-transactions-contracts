// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

import {EIP7702Utils} from "@openzeppelin/contracts/account/utils/EIP7702Utils.sol";

import {ITangem7702GaslessEntryPoint} from "./interfaces/ITangem7702GaslessEntryPoint.sol";
import {ITangem7702GaslessExecutor} from "./interfaces/ITangem7702GaslessExecutor.sol";

contract Tangem7702GaslessEntryPoint is ITangem7702GaslessEntryPoint {
    using EIP7702Utils for address;

    /// @inheritdoc ITangem7702GaslessEntryPoint
    address public immutable requiredDelegateAddress;

    /// @notice Deploys the entry point and sets the required EIP-7702 delegate address.
    /// @dev The entry point will only forward calls for `executor` accounts whose current delegate equals `requiredDelegateAddress_`.
    /// @param requiredDelegateAddress_ The delegate address that `executor.fetchDelegate()` must return for calls to be forwarded.
    constructor(address requiredDelegateAddress_) {
        requiredDelegateAddress = requiredDelegateAddress_;
    }

    /// @inheritdoc ITangem7702GaslessEntryPoint
    function executeTransaction(
        ITangem7702GaslessExecutor.GaslessTransaction calldata gaslessTx,
        bytes calldata signature,
        bool forced,
        address executor
    ) 
        external
    {
        address actualDelegate = executor.fetchDelegate();

        require(
            actualDelegate == requiredDelegateAddress,
            InvalidDelegate(executor, requiredDelegateAddress, actualDelegate)
        );

        ITangem7702GaslessExecutor(payable(executor)).executeTransaction(gaslessTx, signature, forced);
    }

    /// @inheritdoc ITangem7702GaslessEntryPoint
    function executeBatchTransaction(
        ITangem7702GaslessExecutor.GaslessBatchTransaction calldata gaslessTx,
        bytes calldata signature,
        bool forced,
        address executor
    )
        external
    {
        address actualDelegate = executor.fetchDelegate();

        require(
            actualDelegate == requiredDelegateAddress,
            InvalidDelegate(executor, requiredDelegateAddress, actualDelegate)
        );

        ITangem7702GaslessExecutor(payable(executor)).executeBatchTransaction(gaslessTx, signature, forced);
    }
}