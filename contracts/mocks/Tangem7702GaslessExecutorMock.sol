// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

contract Tangem7702GaslessExecutorMock {
    struct Transaction {
        address to;
        uint256 value;
        uint256 gasLimit;
        bytes data;
    }

    struct Fee {
        address feeToken;
        uint256 maxTokenFee;
        uint256 coinPriceInToken;
        uint256 feeTransferGasLimit;
        uint256 baseGas;
        address feeReceiver;
    }

    struct GaslessTransaction {
        Transaction transaction;
        Fee fee;
        uint256 nonce;
    }

    uint256 public calls;

    address public lastMsgSender;

    address public lastFeeReceiver;

    bool public lastForced;

    address public lastTo;

    uint256 public lastValue;

    bytes32 public lastDataHash;

    address public lastFeeToken;

    uint256 public lastMaxTokenFee;

    uint256 public lastGaslessNonce;

    bytes32 public lastSignatureHash;

    receive() external payable {}

    function executeTransaction(
        GaslessTransaction calldata gaslessTx,
        bytes calldata signature,
        bool forced
    ) 
        external 
    {
        unchecked {
            ++calls;
        }
        lastMsgSender = msg.sender;
        lastFeeReceiver = gaslessTx.fee.feeReceiver;
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
