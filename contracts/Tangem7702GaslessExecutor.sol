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

    /// @notice Fixed-point precision used for `coinPriceInToken` calculations.
    /// @dev `coinPriceInToken` is expressed as the price of 1 ether in the smallest unit of `feeToken`.
    ///      Using 1e18 keeps the math consistent with ETH-denominated gas costs.
    uint256 private constant PRICE_PRECISION = 1 ether;

    /// @notice Canonical EIP-712 type string for `GaslessTransaction`.
    /// @dev Must exactly match the struct definition and field ordering used for signing.
    ///      This string is concatenated with `FEE_TYPE` and `TRANSACTION_TYPE` when computing
    ///      `GASLESS_TRANSACTION_TYPEHASH` (per EIP-712 encoding rules for nested structs).
    string private constant GASLESS_TRANSACTION_TYPE =
        "GaslessTransaction(Transaction transaction,Fee fee,uint256 nonce)";

    /// @notice Canonical EIP-712 type string for `Fee`.
    /// @dev Must exactly match the struct definition and field ordering used for signing.
    string private constant FEE_TYPE =
        "Fee(address feeToken,uint256 maxTokenFee,uint256 coinPriceInToken,uint256 feeTransferGasLimit,uint256 baseGas)";

    /// @notice Canonical EIP-712 type string for `Transaction`.
    /// @dev Must exactly match the struct definition and field ordering used for signing.
    string private constant TRANSACTION_TYPE =
        "Transaction(address to,uint256 value,bytes data)";

    /// @notice EIP-712 type hash for `GaslessTransaction` including nested type definitions.
    /// @dev Computed as `keccak256(abi.encodePacked(GASLESS_TRANSACTION_TYPE, FEE_TYPE, TRANSACTION_TYPE))`.
    ///      The concatenation order is critical and must not be changed, otherwise signatures will break.
    bytes32 private constant GASLESS_TRANSACTION_TYPEHASH = keccak256(
        abi.encodePacked(GASLESS_TRANSACTION_TYPE, FEE_TYPE, TRANSACTION_TYPE)
    );

    /// @notice EIP-712 type hash for `Fee`.
    /// @dev Computed as `keccak256(bytes(FEE_TYPE))`. Any change to `FEE_TYPE` breaks signature compatibility.
    bytes32 private constant FEE_TYPEHASH = keccak256(bytes(FEE_TYPE));

    /// @notice EIP-712 type hash for `Transaction`.
    /// @dev Computed as `keccak256(bytes(TRANSACTION_TYPE))`. Any change to `TRANSACTION_TYPE` breaks signature compatibility.
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
        if (gaslessTx.nonce != nonce) {
            revert InvalidNonce(nonce, gaslessTx.nonce);
        }
        bytes32 dataHash = keccak256(gaslessTx.transaction.data);
        bytes32 structHash = _hashGaslessTransaction(gaslessTx, dataHash);
        bytes32 digest = _hashTypedDataV4(structHash);
        _verifyGaslessTransaction(signature, digest);
        uint256 startGas = gasleft();
        (bool success, ) = gaslessTx.transaction.to.call{value: gaslessTx.transaction.value}(gaslessTx.transaction.data);
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

    /// @notice Computes and transfers the fee in `fee.feeToken` to `feeReceiver`.
    /// @dev Calculates `totalGas` as:
    ///      `totalGas = (startGas - gasleft()) + fee.feeTransferGasLimit + fee.baseGas`,
    ///      then converts the native coin cost (`totalGas * tx.gasprice`) into `feeToken`
    ///      using `fee.coinPriceInToken / PRICE_PRECISION`. Measures the gas spent by the
    ///      fee transfer itself and enforces `feeTransferGasLimit` depending on `forced`.
    /// @param fee Fee parameters used for computation and the token transfer.
    /// @param feeReceiver Recipient of the fee in `fee.feeToken`.
    /// @param startGas Gas snapshot taken before executing the target call.
    /// @param forced If true, exceeding `feeTransferGasLimit` is reported via an event; otherwise it reverts.
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

    /// @notice Verifies the EIP-712 signature for a gasless transaction and consumes the nonce.
    /// @dev Recovers the signer from `digest` and requires it to equal `address(this)` in the
    ///      EIP-7702 delegated execution context. Increments `nonce` after a successful check.
    /// @param signature EIP-712 signature over the transaction digest.
    /// @param digest EIP-712 typed data digest computed from the signed payload.
    function _verifyGaslessTransaction(
        bytes calldata signature,
        bytes32 digest
    ) 
        private 
    {
        address signer = ECDSA.recover(digest, signature);
        if (signer != address(this)) {
            revert InvalidSigner(signer, address(this));
        }
        unchecked {
            ++nonce;
        }
    }

    /// @notice Computes the EIP-712 struct hash for a `Transaction`.
    /// @dev Uses `dataHash` (keccak256 of calldata) to avoid hashing dynamic bytes multiple times.
    /// @param transaction The transaction parameters being signed.
    /// @param dataHash Keccak256 hash of `transaction.data`.
    /// @return hash The EIP-712 struct hash of `Transaction`.
    function _hashTransaction(
        Transaction calldata transaction,
        bytes32 dataHash
    )
        private
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                TRANSACTION_TYPEHASH,
                transaction.to,
                transaction.value,
                dataHash
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
                fee.baseGas
            )
        );
    }

    /// @notice Computes the EIP-712 struct hash for a `GaslessTransaction`.
    /// @dev Encodes the nested `Transaction` and `Fee` hashes with `GASLESS_TRANSACTION_TYPEHASH`.
    /// @param gaslessTx The gasless transaction being signed.
    /// @param dataHash Keccak256 hash of `gaslessTx.transaction.data`.
    /// @return hash The EIP-712 struct hash of `GaslessTransaction`.
    function _hashGaslessTransaction(
        GaslessTransaction calldata gaslessTx,
        bytes32 dataHash
    )
        private
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                GASLESS_TRANSACTION_TYPEHASH,
                _hashTransaction(gaslessTx.transaction, dataHash),
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
}