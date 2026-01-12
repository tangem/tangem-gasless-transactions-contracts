// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

import {ITangem7702GaslessExecutor} from "./ITangem7702GaslessExecutor.sol";

interface ITangem7702GaslessEntryPoint {
    error InvalidDelegate(address executor, address expectedDelegate, address actualDelegate);

    function executeTransaction(
        ITangem7702GaslessExecutor.GaslessTransaction calldata gaslessTx,
        bytes calldata signature,
        address feeReceiver,
        bool forced,
        address executor
    ) 
        external;

    function requiredDelegateAddress() external view returns (address);
}