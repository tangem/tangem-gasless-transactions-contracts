// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

import {IERC20, SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC721Holder} from "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {ITangem7702GaslessExecutor} from "../interfaces/ITangem7702GaslessExecutor.sol";

// layout should be at keccak256(abi.encode(uint256(keccak256(bytes(tangem.storage.Tangem7702GaslessExecutor))) - 1)) & ~bytes32(uint256(0xff))
abstract contract Tangem7702GaslessExecutor is EIP712, ERC721Holder, ERC1155Holder, ITangem7702GaslessExecutor {
    using SafeERC20 for IERC20;

    /// @notice Fixed-point precision used for `coinPriceInToken` calculations.
    /// @dev `coinPriceInToken` is expressed as the price of 1 ether in the smallest unit of `feeToken`.
    ///      Using 1e18 keeps the math consistent with ETH-denominated gas costs.
    uint256 private constant PRICE_PRECISION = 1 ether;

    // EIP-712 types
    string private constant GASLESS_TRANSACTION_TYPE =
        "GaslessTransaction(Transaction transaction,Fee fee,uint256 nonce)";
    string private constant FEE_TYPE =
        "Fee(address feeToken,uint256 maxTokenFee,uint256 coinPriceInToken,uint256 feeTransferGasLimit,uint256 baseGas,address feeReceiver)";
    string private constant TRANSACTION_TYPE =
        "Transaction(address to,uint256 value,bytes data)";

    // EIP-712 type hashes
    bytes32 private constant GASLESS_TRANSACTION_TYPEHASH = keccak256(
        abi.encodePacked(GASLESS_TRANSACTION_TYPE, FEE_TYPE, TRANSACTION_TYPE)
    );
    bytes32 private constant FEE_TYPEHASH = keccak256(bytes(FEE_TYPE));
    bytes32 private constant TRANSACTION_TYPEHASH = keccak256(bytes(TRANSACTION_TYPE));

    /// @inheritdoc ITangem7702GaslessExecutor
    uint256 public nonce;

    /// @notice Initializes the EIP-712 domain used to verify `GaslessTransaction` signatures.
    /// @dev Sets the EIP-712 domain name to "Tangem7702GaslessExecutor" and version to "1".
    ///      These values are part of the signed domain separator, so changing them breaks
    ///      signature compatibility with existing clients.
    constructor() EIP712("Tangem7702GaslessExecutor", "1") {}

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
        _verifyGaslessTransaction(gaslessTx, signature);

        uint256 startGas = gasleft();

        (bool success, bytes memory returnData) =
            gaslessTx.transaction.to.call{value: gaslessTx.transaction.value}(gaslessTx.transaction.data);

        if (!success) {
            if (forced) {
                emit ExecutionFailed(
                    gaslessTx.transaction.to,
                    gaslessTx.transaction.value,
                    _selector(gaslessTx.transaction.data)
                );
            } else {
                if (returnData.length == 0) {
                    revert ExecutionFailedNotForced(
                        gaslessTx.transaction.to,
                        gaslessTx.transaction.value,
                        _selector(gaslessTx.transaction.data)
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
            gaslessTx.transaction.to,
            gaslessTx.transaction.value,
            _selector(gaslessTx.transaction.data)
        );
    }

    /// @notice Computes and transfers the fee in `fee.feeToken` to `feeReceiver`.
    /// @dev Calculates `totalGas` as:
    ///      `totalGas = (startGas - gasleft()) + fee.feeTransferGasLimit + fee.baseGas`,
    ///      then converts the native coin cost (`totalGas * tx.gasprice`) into `feeToken`
    ///      using `fee.coinPriceInToken / PRICE_PRECISION`. Measures the gas spent by the
    ///      fee transfer itself and enforces `feeTransferGasLimit` depending on `forced`.
    /// @param fee Fee parameters used for computation and the token transfer.
    /// @param startGas Gas snapshot taken before executing the target call.
    /// @param forced If true, exceeding `feeTransferGasLimit` is reported via an event; otherwise it reverts.
    function _processFeeTransfer(
        Fee calldata fee,
        uint256 startGas,
        bool forced
    )
        private
    {
        uint256 gasAfterUserCall = gasleft();
        uint256 totalGas = startGas - gasAfterUserCall + fee.feeTransferGasLimit + fee.baseGas;
        uint256 weiCost = totalGas * tx.gasprice;

        // Add L1 data fee for L2 networks
        uint256 l1Fee = _getL1Fee();
        weiCost += l1Fee;

        uint256 feeAmount = (weiCost * fee.coinPriceInToken) / PRICE_PRECISION;
    
        require(feeAmount <= fee.maxTokenFee, MaxFeeExceeded(feeAmount, fee.maxTokenFee));

        uint256 gasBeforeTransfer = gasleft();

        uint256 balance = IERC20(fee.feeToken).balanceOf(address(this));
        require(
            balance >= feeAmount,
            InsufficientFundsForFee(fee.feeToken, balance, feeAmount)
        );

        IERC20(fee.feeToken).safeTransfer(fee.feeReceiver, feeAmount);

        uint256 gasAfterTransfer = gasleft();
        uint256 feeTransferGasUsed = gasBeforeTransfer - gasAfterTransfer;

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
                keccak256(transaction.data)
            )
        );
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

    /// @notice Get L1 data fee in wei for the current transaction
    /// @dev Should return 0 for non-L2 chains
    function _getL1Fee() internal view virtual returns (uint256);

    function supportsInterface(bytes4 interfaceId) 
        public 
        view 
        virtual 
        override
        returns (bool) 
    {
        return interfaceId == type(IERC721Receiver).interfaceId ||
               super.supportsInterface(interfaceId);
    }
}