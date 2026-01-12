// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

interface ITangem7702GaslessExecutor {
    struct Transaction {
        address to;
        uint256 value;
        bytes data;
    }

    struct Fee {
        address feeToken;
        uint256 maxTokenFee;
        uint256 coinPriceInToken;
        uint256 feeTransferGasLimit;
        uint256 baseGas;
    }

    struct GaslessTransaction {
        Transaction transaction;
        Fee fee;
        uint256 nonce;
    }

    error InsufficientFundsForFee(address feeToken, uint256 balance, uint256 maxTokenFee);
    error ExecutionFailed(address to, uint256 value, bytes data);
    error MaxFeeExceeded(uint256 feeAmount, uint256 maxTokenFee);
    error FeeTransferGasLimitExceededNotForced(uint256 gasLimit, uint256 gasUsed);
    error InvalidNonce(uint256 expectedNonce, uint256 providedNonce);
    error InvalidSigner(address recoveredSigner, address expectedSigner);

    event TransactionExecuted(GaslessTransaction gaslessTx);
    event FeeTransferProcessed(address indexed feeReceiver, address feeToken, uint256 feeAmount, uint256 totalGas);
    event FeeTransferGasLimitExceeded(uint256 gasLimit, uint256 gasUsed);

    receive() external payable;

    function executeTransaction(
        GaslessTransaction calldata gaslessTx,
        bytes calldata signature,
        address feeReceiver,
        bool forced
    ) 
        external;

    function nonce() external view returns (uint256);
}