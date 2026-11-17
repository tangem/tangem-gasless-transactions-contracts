// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

import {IERC20, SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC721Holder} from "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {ITangem7702GaslessExecutor} from "../interfaces/ITangem7702GaslessExecutor.sol";
import {GasOverhead} from "./GasOverhead.sol";
import {Tangem7702ERC1271, IERC1271} from "./Tangem7702ERC1271.sol";

/// @title Tangem 7702 Gasless Executor
// layout at keccak256(abi.encode(uint256(keccak256(bytes(tangem.storage.Tangem7702GaslessExecutor))) - 1)) & ~bytes32(uint256(0xff))
contract Tangem7702GaslessExecutor is
    EIP712,
    ERC721Holder,
    ERC1155Holder,
    GasOverhead,
    ITangem7702GaslessExecutor,
    Tangem7702ERC1271
    layout at 0x63126cb0ee213fd665c396acd692b9c0a13c8cc8bbd732af4f146bb546be9800
{
    using SafeERC20 for IERC20;

    /// @notice Fixed-point precision used for `coinPriceInToken` calculations.
    /// @dev `coinPriceInToken` is expressed as the price of 1 ether in the smallest unit of `feeToken`.
    ///      Using 1e18 keeps the math consistent with ETH-denominated gas costs.
    uint256 private constant PRICE_PRECISION = 1 ether;

    /// @notice Per-iteration loop body overhead for batch execution.
    /// @dev Covers: stack manipulation, counter increment, conditional jumps,
    ///      memory operations, and warm CALL opcode base cost (100 gas).
    ///      Measured ~1085 gas/iteration via gasleft() instrumentation + ~10% margin.
    uint256 private constant BATCH_LOOP_OVERHEAD = 1200;

    // EIP-712 types
    string private constant GASLESS_TRANSACTION_TYPE =
        "GaslessTransaction(Transaction transaction,Fee fee,uint256 nonce)";
    string private constant GASLESS_BATCH_TRANSACTION_TYPE =
        "GaslessBatchTransaction(Transaction[] transactions,Fee fee,uint256 nonce)";
    string private constant FEE_TYPE =
        "Fee(address feeToken,uint256 maxTokenFee,uint256 coinPriceInToken,uint256 feeTransferGasLimit,uint256 baseGas,address feeReceiver)";
    string private constant TRANSACTION_TYPE =
        "Transaction(address to,uint256 value,uint256 gasLimit,bytes data)";

    // EIP-712 type hashes
    bytes32 private constant GASLESS_TRANSACTION_TYPEHASH = keccak256(
        abi.encodePacked(GASLESS_TRANSACTION_TYPE, FEE_TYPE, TRANSACTION_TYPE)
    );
    bytes32 private constant GASLESS_BATCH_TRANSACTION_TYPEHASH = keccak256(
        abi.encodePacked(GASLESS_BATCH_TRANSACTION_TYPE, FEE_TYPE, TRANSACTION_TYPE)
    );
    bytes32 private constant FEE_TYPEHASH = keccak256(bytes(FEE_TYPE));
    bytes32 private constant TRANSACTION_TYPEHASH = keccak256(bytes(TRANSACTION_TYPE));

    /// @inheritdoc ITangem7702GaslessExecutor
    uint256 public nonce;

    /// @notice Initializes the EIP-712 domain and gas accounting.
    /// @dev Sets the EIP-712 domain name to "Tangem7702GaslessExecutor" and version to "1".
    ///      These values are part of the signed domain separator, so changing them breaks
    ///      signature compatibility with existing clients.
    /// @param baseGasAfterCall_ See {BASE_GAS_AFTER_CALL}.
    /// @param l1FeeMode_ See {L1_FEE_MODE}.
    /// @param callGasCosts_ See {IGasOverhead-CallGasCosts}.
    constructor(uint256 baseGasAfterCall_, L1FeeMode l1FeeMode_, CallGasCosts memory callGasCosts_)
        EIP712("Tangem7702GaslessExecutor", "1")
        GasOverhead(baseGasAfterCall_, l1FeeMode_, callGasCosts_)
    {}

    /// @inheritdoc ITangem7702GaslessExecutor
    receive() external payable {}
    
    /// @inheritdoc ITangem7702GaslessExecutor
    fallback() external payable {}

    /// @inheritdoc ITangem7702GaslessExecutor
    function executeTransaction(
        GaslessTransaction calldata gaslessTx,
        bytes calldata signature,
        bool forced
    ) 
        external
    {
        uint256 startGas = gasleft();

        Transaction calldata transaction = gaslessTx.transaction;

        require(transaction.to != address(0), ZeroTarget());

        _verifyGaslessTransaction(gaslessTx, signature);

        _checkGasLimit(
            transaction.gasLimit,
            _callOverhead(transaction.to, transaction.value) + _reservedPostCallGas(gaslessTx.fee)
        );

        (bool success, bytes memory returnData)
            = transaction.to.call{value: transaction.value, gas: transaction.gasLimit}(transaction.data);

        if (!success) {
            if (forced) {
                emit ExecutionFailed(
                    transaction.to,
                    transaction.value,
                    _selector(transaction.data)
                );
            } else {
                if (returnData.length == 0) {
                    revert ExecutionFailedNotForced(
                        transaction.to,
                        transaction.value,
                        _selector(transaction.data)
                    );
                }
                assembly {
                    revert(add(returnData, 0x20), mload(returnData))
                }
            }
        }

        if (gaslessTx.fee.coinPriceInToken > 0) {
            _processFeeTransfer(gaslessTx.fee, startGas, forced);
        }

        emit TransactionExecuted(
            address(this),
            gaslessTx.nonce,
            transaction.to,
            transaction.value,
            _selector(transaction.data)
        );
    }

    /// @inheritdoc ITangem7702GaslessExecutor
    function executeBatchTransaction(
        GaslessBatchTransaction calldata gaslessTx,
        bytes calldata signature,
        bool forced
    )
        external
    {
        uint256 startGas = gasleft();

        Transaction[] calldata txs = gaslessTx.transactions;
        require(txs.length >= 2, InvalidCallsLength());

        uint256 totalGasLimit = 0;
        uint256 totalCallOverhead = 0;
        for (uint256 i = 0; i < txs.length; ++i) {
            Transaction calldata transaction = txs[i];

            require(transaction.to != address(0), ZeroTarget());

            totalGasLimit += transaction.gasLimit;
            totalCallOverhead += BATCH_LOOP_OVERHEAD + _callOverhead(transaction.to, transaction.value);
        }

        _verifyGaslessBatchTransaction(gaslessTx, signature);

        _checkGasLimit(totalGasLimit, _reservedPostCallGas(gaslessTx.fee) + totalCallOverhead);

        uint256 executedCalls = 0;

        for (uint256 i = 0; i < txs.length; ++i) {
            Transaction calldata transaction = txs[i];

            (bool success, bytes memory returnData)
                = transaction.to.call{value: transaction.value, gas: transaction.gasLimit}(transaction.data);

            if (!success) {
                if (forced) {
                    emit BatchCallFailed(i, transaction.to, transaction.value, _selector(transaction.data));
                    break;
                } else {
                    if (returnData.length == 0) {
                        revert BatchExecutionFailedNotForced(
                            i, 
                            transaction.to, 
                            transaction.value, 
                            _selector(transaction.data)
                        );
                    }
                    assembly {
                        revert(add(returnData, 0x20), mload(returnData))
                    }
                }
            }

            executedCalls = i + 1;
        }

        if (gaslessTx.fee.coinPriceInToken > 0) {
            _processFeeTransfer(gaslessTx.fee, startGas, forced);
        }

        emit BatchTransactionExecuted(
            address(this),
            gaslessTx.nonce,
            txs.length,
            executedCalls
        );
    }

    /// @notice Computes and transfers the fee in `fee.feeToken` to `feeReceiver`.
    /// @dev Calculates `totalGas` as:
    ///      `totalGas = (startGas - gasleft()) + calldata gas + fee.feeTransferGasLimit + fee.baseGas`,
    ///      where the measured part includes the L1 fee oracle call. Then converts the native coin cost
    ///      (`totalGas * tx.gasprice + l1Fee`) into `feeToken` using `fee.coinPriceInToken / PRICE_PRECISION`.
    ///      Measures the gas spent by the fee transfer itself and enforces `feeTransferGasLimit` depending on `forced`.
    ///
    ///      Strict invariants (NEVER softened by `forced`):
    ///      - `feeAmount <= fee.maxTokenFee`
    ///      - `balance(feeToken) >= feeAmount`
    ///      - the fee transfer succeeds (and `feeReceiver != address(0)` for native coin)
    ///
    ///      Softened only when `forced=true`:
    ///      - exceeding `feeTransferGasLimit` emits {FeeTransferGasLimitExceeded} instead of reverting.
    /// @param fee Fee parameters used for computation and the token transfer.
    /// @param startGas Gas snapshot taken at the start of `executeTransaction` / `executeBatchTransaction`.
    /// @param forced If true, exceeding `feeTransferGasLimit` is reported via an event; otherwise it reverts.
    function _processFeeTransfer(
        Fee calldata fee,
        uint256 startGas,
        bool forced
    )
        private
    {
        uint256 l1Fee = _getL1Fee();

        uint256 gasNow = gasleft();
        uint256 gasUsed = startGas > gasNow ? startGas - gasNow : 0;
        uint256 totalGas = gasUsed + _calldataGas() + fee.feeTransferGasLimit + fee.baseGas;
        uint256 weiCost = totalGas * tx.gasprice + l1Fee;

        uint256 feeAmount = (weiCost * fee.coinPriceInToken) / PRICE_PRECISION;
    
        require(feeAmount <= fee.maxTokenFee, MaxFeeExceeded(feeAmount, fee.maxTokenFee));

        uint256 gasBeforeTransfer = gasleft();

        uint256 balance = _balanceOf(fee.feeToken);
        require(balance >= feeAmount, InsufficientFundsForFee(fee.feeToken, balance, feeAmount));

        _feeTransfer(fee.feeToken, fee.feeReceiver, feeAmount);

        uint256 gasAfterTransfer = gasleft();
        uint256 feeTransferGasUsed = gasBeforeTransfer > gasAfterTransfer ? gasBeforeTransfer - gasAfterTransfer : 0;

        bool feeTransferGasLimitExceeded = feeTransferGasUsed > fee.feeTransferGasLimit;
        if (forced) {
            if (feeTransferGasLimitExceeded) {
                emit FeeTransferGasLimitExceeded(fee.feeTransferGasLimit, feeTransferGasUsed);
            }
        } else {
            require(
                !feeTransferGasLimitExceeded,
                FeeTransferGasLimitExceededNotForced(fee.feeTransferGasLimit, feeTransferGasUsed)
            );
        }

        emit FeeTransferProcessed(fee.feeReceiver, fee.feeToken, feeAmount, totalGas, l1Fee);
    }

    /// @notice Sends the fee to `feeReceiver` in `feeToken`.
    function _feeTransfer(address feeToken, address feeReceiver, uint256 feeAmount) private {
        if (feeToken == address(0)) {
            require(feeReceiver != address(0), ZeroFeeReceiver());

            (bool success,) = feeReceiver.call{value: feeAmount}("");
            require(success, NativeFeeTransferFailed(feeReceiver, feeAmount));
        } else {
            IERC20(feeToken).safeTransfer(feeReceiver, feeAmount);
        }
    }

    /// @notice Verifies a gasless transaction EIP-712 signature and consumes the nonce.
    /// @dev Requires `gaslessTx.nonce` to equal the current stored `nonce`, computes the EIP-712 digest for `gaslessTx`
    ///      , recovers the signer from `signature`, and requires it to equal `address(this)` in the EIP-7702 delegated
    ///      execution context. Increments `nonce` after a successful verification.
    /// @param gaslessTx The gasless transaction payload being authorized (target call, fee config, and nonce).
    /// @param signature The EIP-712 signature over the typed data digest produced by the executor account.
    function _verifyGaslessTransaction(GaslessTransaction calldata gaslessTx, bytes calldata signature) private {
        require (gaslessTx.nonce == nonce, InvalidNonce(nonce, gaslessTx.nonce));

        bytes32 structHash = _hashGaslessTransaction(gaslessTx);
        bytes32 digest = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(digest, signature);

        require(signer == address(this), InvalidSigner(signer, address(this)));

        unchecked { 
            ++nonce; 
        }
    }

    /// @notice Verifies a batch gasless transaction EIP-712 signature and consumes the nonce.
    /// @dev Same semantics as `_verifyGaslessTransaction`, but hashes `Transaction[]` per EIP-712 rules.
    /// @param gaslessTx The batch payload being authorized (calls, fee config, and nonce).
    /// @param signature The EIP-712 signature over the typed data digest produced by the executor account.
    function _verifyGaslessBatchTransaction(
        GaslessBatchTransaction calldata gaslessTx,
        bytes calldata signature
    )
        private
    {
        require(gaslessTx.nonce == nonce, InvalidNonce(nonce, gaslessTx.nonce));

        bytes32 structHash = _hashGaslessBatchTransaction(gaslessTx);
        bytes32 digest = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(digest, signature);

        require(signer == address(this), InvalidSigner(signer, address(this)));

        unchecked {
            ++nonce;
        }
    }

    /// @notice Returns the amount of gas to reserve for post-call operations.
    /// @dev Always includes `BASE_GAS_AFTER_CALL`.
    ///      Includes `feeTransferGasLimit` only when fee is enabled (`coinPriceInToken > 0`),
    ///      because fee processing is skipped otherwise.
    function _reservedPostCallGas(Fee calldata fee) private view returns (uint256 reserved) {
        reserved = BASE_GAS_AFTER_CALL;
        if (fee.coinPriceInToken > 0) {
            reserved += fee.feeTransferGasLimit;
        }
    }

    /// @notice Reverts unless calls get `gasLimit` under the 63/64 rule with `reservedGas` kept aside.
    function _checkGasLimit(uint256 gasLimit, uint256 reservedGas) private view {
        uint256 availableGas = gasleft();
        require(availableGas > reservedGas, InsufficientGas());

        availableGas -= reservedGas;
        require(gasLimit <= availableGas - availableGas / 64, InsufficientGas());
    }

    /// @notice Returns the executor balance of `token`, or native coin balance.
    function _balanceOf(address token) private view returns (uint256) {
        return token == address(0) ? address(this).balance : IERC20(token).balanceOf(address(this));
    }

    /// @notice Computes the EIP-712 struct hash for a `Transaction`.
    /// @dev Encodes fields with `TRANSACTION_TYPEHASH` per EIP-712.
    /// @param transaction The transaction parameters being signed.
    /// @return hash The EIP-712 struct hash of `Transaction`.
    function _hashTransaction(Transaction calldata transaction) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                TRANSACTION_TYPEHASH,
                transaction.to,
                transaction.value,
                transaction.gasLimit,
                keccak256(transaction.data)
            )
        );
    }

    /// @notice Computes the EIP-712 array hash for `Transaction[]`.
    /// @dev Hashes each element as `keccak256(abi.encode(TransactionTypeHash,...))`, then:
    ///      `keccak256(abi.encodePacked(txHash_0, txHash_1, ...))`.
    /// @param txs Array of transactions.
    /// @return hash Array hash suitable for inclusion into the EIP-712 struct hash.
    function _hashTransactions(Transaction[] calldata txs) private pure returns (bytes32) {
        bytes32[] memory hashes = new bytes32[](txs.length);
        for (uint256 i = 0; i < txs.length; ++i) {
            hashes[i] = _hashTransaction(txs[i]);
        }
        return keccak256(abi.encodePacked(hashes));
    }

    /// @notice Computes the EIP-712 struct hash for a `Fee`.
    /// @dev Encodes fields with `FEE_TYPEHASH` per EIP-712.
    /// @param fee The fee parameters being signed.
    /// @return hash The EIP-712 struct hash of `Fee`.
    function _hashFee(Fee calldata fee) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                FEE_TYPEHASH,
                fee.feeToken,
                fee.maxTokenFee,
                fee.coinPriceInToken,
                fee.feeTransferGasLimit,
                fee.baseGas,
                fee.feeReceiver
            )
        );
    }

    /// @notice Computes the EIP-712 struct hash for a `GaslessTransaction`.
    /// @dev Encodes the nested `Transaction` and `Fee` hashes with `GASLESS_TRANSACTION_TYPEHASH`.
    /// @param gaslessTx The gasless transaction being signed.
    /// @return hash The EIP-712 struct hash of `GaslessTransaction`.
    function _hashGaslessTransaction(GaslessTransaction calldata gaslessTx) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                GASLESS_TRANSACTION_TYPEHASH,
                _hashTransaction(gaslessTx.transaction),
                _hashFee(gaslessTx.fee),
                gaslessTx.nonce
            )
        );
    }

    /// @notice Computes the EIP-712 struct hash for a `GaslessBatchTransaction`.
    /// @dev Encodes `transactions` as an EIP-712 array hash (see `_hashTransactions`) and combines with `Fee` and `nonce`.
    /// @param gaslessTx The batch payload being signed.
    /// @return hash The EIP-712 struct hash of `GaslessBatchTransaction`.
    function _hashGaslessBatchTransaction(GaslessBatchTransaction calldata gaslessTx) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                GASLESS_BATCH_TRANSACTION_TYPEHASH,
                _hashTransactions(gaslessTx.transactions),
                _hashFee(gaslessTx.fee),
                gaslessTx.nonce
            )
        );
    }

    /// @notice Extracts the function selector from calldata.
    /// @dev Returns `bytes4(0)` when `data.length < 4`.
    /// @param data ABI-encoded calldata.
    /// @return sel The first 4 bytes of `data` (function selector) or zero if unavailable.
    function _selector(bytes calldata data) private pure returns (bytes4 sel) {
        if (data.length >= 4) {
            assembly {
                sel := calldataload(data.offset)
            }
        }
    }

    function supportsInterface(bytes4 interfaceId) 
        public 
        view 
        virtual 
        override
        returns (bool) 
    {
        return interfaceId == type(IERC721Receiver).interfaceId ||
               interfaceId == type(IERC1271).interfaceId ||
               super.supportsInterface(interfaceId);
    }
}