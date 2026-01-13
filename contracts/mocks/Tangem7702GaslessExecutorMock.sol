// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

import {ITangem7702GaslessExecutorMock} from "../interfaces/ITangem7702GaslessExecutorMock.sol";

contract Tangem7702GaslessExecutorMock is ITangem7702GaslessExecutorMock {
    /// @inheritdoc ITangem7702GaslessExecutorMock
    uint256 public calls;

    /// @inheritdoc ITangem7702GaslessExecutorMock
    address public lastMsgSender;

    /// @inheritdoc ITangem7702GaslessExecutorMock
    address public lastFeeReceiver;

    /// @inheritdoc ITangem7702GaslessExecutorMock
    bool public lastForced;

    /// @inheritdoc ITangem7702GaslessExecutorMock
    address public lastTo;

    /// @inheritdoc ITangem7702GaslessExecutorMock
    uint256 public lastValue;

    /// @inheritdoc ITangem7702GaslessExecutorMock
    bytes32 public lastDataHash;

    /// @inheritdoc ITangem7702GaslessExecutorMock
    address public lastFeeToken;

    /// @inheritdoc ITangem7702GaslessExecutorMock
    uint256 public lastMaxTokenFee;

    /// @inheritdoc ITangem7702GaslessExecutorMock
    uint256 public lastGaslessNonce;

    /// @inheritdoc ITangem7702GaslessExecutorMock
    bytes32 public lastSignatureHash;

    /// @inheritdoc ITangem7702GaslessExecutorMock
    receive() external payable {}

    /// @inheritdoc ITangem7702GaslessExecutorMock
    function nonce() external pure returns (uint256) {
        return 0;
    }

    /// @inheritdoc ITangem7702GaslessExecutorMock
    function executeTransaction(
        GaslessTransaction calldata gaslessTx,
        bytes calldata signature,
        address feeReceiver,
        bool forced
    ) 
        external 
    {
        unchecked {
            ++calls;
        }
        lastMsgSender = msg.sender;
        lastFeeReceiver = feeReceiver;
        lastForced = forced;
        lastTo = gaslessTx.transaction.to;
        lastValue = gaslessTx.transaction.value;
        lastDataHash = keccak256(gaslessTx.transaction.data);
        lastFeeToken = gaslessTx.fee.feeToken;
        lastMaxTokenFee = gaslessTx.fee.maxTokenFee;
        lastGaslessNonce = gaslessTx.nonce;
        lastSignatureHash = keccak256(signature);
    }
}
