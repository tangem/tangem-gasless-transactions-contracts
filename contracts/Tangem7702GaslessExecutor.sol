// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

import {IERC20, SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {ITangem7702GaslessExecutor} from "./interfaces/ITangem7702GaslessExecutor.sol";

contract Tangem7702GaslessExecutor is 
    EIP712, 
    ReentrancyGuardTransient,
    ITangem7702GaslessExecutor 
    layout at 0x63126cb0ee213fd665c396acd692b9c0a13c8cc8bbd732af4f146bb546be9800 
{
    using SafeERC20 for IERC20;

    uint256 private constant PRICE_PRECISION = 1 ether;

    string private constant GASLESS_TRANSACTION_TYPE =
        "GaslessTransaction(Transaction transaction,Fee fee,uint256 nonce)";

    string private constant FEE_TYPE =
        "Fee(address feeToken,uint256 maxTokenFee,uint256 coinPriceInToken,uint256 feeTransferGasLimit,uint256 baseGas)";

    string private constant TRANSACTION_TYPE =
        "Transaction(address to,uint256 value,bytes data)";

    bytes32 private constant GASLESS_TRANSACTION_TYPEHASH = keccak256(
        abi.encodePacked(GASLESS_TRANSACTION_TYPE, FEE_TYPE, TRANSACTION_TYPE)
    );

    bytes32 private constant FEE_TYPEHASH = keccak256(bytes(FEE_TYPE));

    bytes32 private constant TRANSACTION_TYPEHASH = keccak256(bytes(TRANSACTION_TYPE));

    /// @inheritdoc ITangem7702GaslessExecutor
    uint256 public nonce;

    constructor() EIP712("Tangem7702GaslessExecutor", "1") {}

    /// @inheritdoc ITangem7702GaslessExecutor
    receive() external payable {}

    /// @inheritdoc ITangem7702GaslessExecutor
    function executeTransaction(
        GaslessTransaction calldata gaslessTx,
        bytes calldata signature,
        address feeReceiver,
        bool forced
    ) 
        external 
        nonReentrant
    {
        uint256 balance = IERC20(gaslessTx.fee.feeToken).balanceOf(address(this));
        if (balance < gaslessTx.fee.maxTokenFee) {
            revert InsufficientFundsForFee(gaslessTx.fee.feeToken, balance, gaslessTx.fee.maxTokenFee);
        }
        bytes32 structHash = _hashGaslessTransaction(gaslessTx);
        bytes32 digest = _hashTypedDataV4(structHash);
        _verifyGaslessTransaction(gaslessTx, signature, digest);
        uint256 startGas = gasleft();
        (bool success, ) = gaslessTx.transaction.to.call{value: gaslessTx.transaction.value}(gaslessTx.transaction.data);
        bytes32 dataHash = keccak256(gaslessTx.transaction.data);
        if (!success) {
            bytes4 selector = _selector(gaslessTx.transaction.data);
            revert ExecutionFailed(gaslessTx.transaction.to, gaslessTx.transaction.value, selector, dataHash);
        }
        if (gaslessTx.fee.coinPriceInToken > 0) {
            _processFeeTransfer(gaslessTx.fee, feeReceiver, startGas, forced);
        }
        emit TransactionExecuted(
            address(this),
            gaslessTx.nonce,
            gaslessTx.transaction.to,
            gaslessTx.transaction.value,
            dataHash,
            digest
        );
    }

    function _processFeeTransfer(
        Fee calldata fee,
        address feeReceiver,
        uint256 startGas,
        bool forced
    )
        private
    {
        uint256 gasAfterUserCall = gasleft();
        uint256 totalGas = startGas - gasAfterUserCall + fee.feeTransferGasLimit + fee.baseGas;
        uint256 weiCost = totalGas * tx.gasprice;
        uint256 feeAmount = (weiCost * fee.coinPriceInToken) / PRICE_PRECISION;
        if (feeAmount > fee.maxTokenFee) {
            revert MaxFeeExceeded(feeAmount, fee.maxTokenFee);
        }
        uint256 gasBeforeTransfer = gasleft();
        IERC20(fee.feeToken).safeTransfer(feeReceiver, feeAmount);
        uint256 gasAfterTransfer = gasleft();
        uint256 feeTransferGasUsed = gasBeforeTransfer - gasAfterTransfer;
        bool exceeded = feeTransferGasUsed > fee.feeTransferGasLimit;
        if (forced) {
            if (exceeded) {
                emit FeeTransferGasLimitExceeded(fee.feeTransferGasLimit, feeTransferGasUsed);
            }
        } else {
            if (exceeded) {
                revert FeeTransferGasLimitExceededNotForced(fee.feeTransferGasLimit, feeTransferGasUsed);
            }
        }
        emit FeeTransferProcessed(feeReceiver, fee.feeToken, feeAmount, totalGas);
    }

    function _verifyGaslessTransaction(
        GaslessTransaction calldata gaslessTx,
        bytes calldata signature,
        bytes32 digest
    ) 
        private 
    {
        if (gaslessTx.nonce != nonce) {
            revert InvalidNonce(nonce, gaslessTx.nonce);
        }
        address signer = ECDSA.recover(digest, signature);
        if (signer != address(this)) {
            revert InvalidSigner(signer, address(this));
        }
        unchecked {
            ++nonce;
        }
    }

    function _hashTransaction(Transaction calldata transaction) private pure returns (bytes32) {
        return keccak256(abi.encode(
            TRANSACTION_TYPEHASH,
            transaction.to,
            transaction.value,
            keccak256(transaction.data)
        ));
    }
    
    function _hashFee(Fee calldata fee) private pure returns (bytes32) {
        return keccak256(abi.encode(
            FEE_TYPEHASH,
            fee.feeToken,
            fee.maxTokenFee,
            fee.coinPriceInToken,
            fee.feeTransferGasLimit,
            fee.baseGas
        ));
    }

    function _hashGaslessTransaction(GaslessTransaction calldata gaslessTx) private pure returns (bytes32) {
        return keccak256(abi.encode(
            GASLESS_TRANSACTION_TYPEHASH,
            _hashTransaction(gaslessTx.transaction),
            _hashFee(gaslessTx.fee),
            gaslessTx.nonce
        ));
    }

    function _selector(bytes calldata data) private pure returns (bytes4 sel) {
        if (data.length >= 4) {
            assembly {
                sel := calldataload(data.offset)
            }
        }
    }
}