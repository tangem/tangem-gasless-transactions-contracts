// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import "@openzeppelin/contracts/account/utils/EIP7702Utils.sol";
import "./Tangem7702GaslessExecutor.sol";

// keccak256("tangem.storage.Tangem7702GaslessExecutor") TODO
contract Tangem7702GaslessEntryPoint {
    using EIP7702Utils for address;

    address public requiredDelegateAddress;

    constructor(address requiredDelegateAddress_) {
        requiredDelegateAddress = requiredDelegateAddress_;
    }

    function executeTransaction(
        Tangem7702GaslessExecutor.GaslessTransaction calldata gasslessTx,
        bytes calldata signature,
        address feeReceiver,
        bool forced,
        address executor
    ) public {
        require(executor.fetchDelegate() == requiredDelegateAddress, "EntryPoint: invalid delegate");

        Tangem7702GaslessExecutor(payable(executor)).executeTransaction(
            gasslessTx,
            signature,
            feeReceiver,
            forced
        );
    }
}