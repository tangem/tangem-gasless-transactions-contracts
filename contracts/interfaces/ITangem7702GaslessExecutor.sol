// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

interface ITangem7702GaslessExecutor {
    /// @notice Call data for a target execution.
    /// @dev This struct is signed as part of {GaslessTransaction} using EIP-712.
    struct Transaction {
        /// @notice Target contract to call.
        address to;
        /// @notice Amount of native coin (ETH) to send with the call.
        uint256 value;
        /// @notice ABI-encoded calldata for the call.
        bytes data;
    }

    /// @notice Fee configuration for a gasless execution.
    /// @dev The fee is paid in `feeToken` and is computed from measured gas usage and `coinPriceInToken`.
    struct Fee {
        /// @notice ERC-20 token used to pay the relayer/service fee.
        address feeToken;
        /// @notice Maximum fee amount (in `feeToken` smallest units) the signer is willing to pay.
        uint256 maxTokenFee;
        /// @notice Price of 1 native coin (1 ether) expressed in `feeToken` smallest units.
        uint256 coinPriceInToken;
        /// @notice Gas limit budget allocated for the fee token transfer.
        uint256 feeTransferGasLimit;
        /// @notice Fixed gas overhead added to the measured gas for fee calculation.
        uint256 baseGas;
        /// @notice The recipient of the fee. Added to signature to discourage front-running
        address feeReceiver;
    }

    /// @notice Signed payload authorizing a gasless execution and fee payment.
    /// @dev The signature must recover to the executing account address (EIP-7702 delegated context).
    struct GaslessTransaction {
        /// @notice Target call parameters.
        Transaction transaction;
        /// @notice Fee parameters used to compute and transfer the fee.
        Fee fee;
        /// @notice Sequential nonce used to prevent replay.
        uint256 nonce;
    }

    /// @notice Thrown when the executor account does not have enough `feeToken` balance for `maxTokenFee`.
    /// @dev This is checked early to fail fast before signature verification and execution.
    /// @param feeToken The ERC-20 fee token address.
    /// @param balance Current `feeToken` balance of the executor account.
    /// @param maxTokenFee Maximum fee required by the signed payload.
    error InsufficientFundsForFee(address feeToken, uint256 balance, uint256 maxTokenFee);

    /// @notice Thrown when the target call fails without revert data.
    /// @dev If the target reverts with non-empty revert data (custom error / Error(string) / Panic(uint256)),
    ///      the executor bubbles that revert data instead of using this error.
    ///      `selector` and `dataHash` identify the intended calldata without returning the full bytes payload.
    ///      When `forced` is true, the executor emits {ExecutionFailed} instead of reverting.
    /// @param to Target contract address that was called.
    /// @param value Native coin value sent with the call.
    /// @param selector First 4 bytes of calldata (function selector), or 0x00000000 if calldata is shorter than 4 bytes.
    error ExecutionFailedNotForced(address to, uint256 value, bytes4 selector);

    /// @notice Thrown when the computed fee exceeds `maxTokenFee`.
    /// @dev The computed fee is derived from measured gas and `coinPriceInToken`.
    /// @param feeAmount Computed fee amount in `feeToken` smallest units.
    /// @param maxTokenFee Maximum fee allowed by the signed payload.
    error MaxFeeExceeded(uint256 feeAmount, uint256 maxTokenFee);

    /// @notice Thrown when fee transfer gas usage exceeds `feeTransferGasLimit` and `forced` is false.
    /// @dev When `forced` is true, the executor emits {FeeTransferGasLimitExceeded} instead of reverting.
    /// @param gasLimit The signed gas limit budget for the fee transfer.
    /// @param gasUsed The measured gas used by the fee transfer.
    error FeeTransferGasLimitExceededNotForced(uint256 gasLimit, uint256 gasUsed);

    /// @notice Thrown when the provided nonce does not match the current executor nonce.
    /// @dev Prevents replay and enforces ordering of signed executions.
    /// @param expectedNonce Current nonce stored by the executor.
    /// @param providedNonce Nonce provided in the signed payload.
    error InvalidNonce(uint256 expectedNonce, uint256 providedNonce);

    /// @notice Thrown when signature recovery does not match the expected signer.
    /// @dev In EIP-7702 delegated execution, the expected signer is the executing account address.
    /// @param recoveredSigner Address recovered from the signature.
    /// @param expectedSigner The expected signer address (the executor account).
    error InvalidSigner(address recoveredSigner, address expectedSigner);

    /// @notice Emitted after a gasless transaction is executed (and fee processing, if enabled, completes).
    /// @dev `dataHash` identifies the intended calldata without emitting full bytes.
    /// @param executor The executing account (EIP-7702 delegating account), i.e., `address(this)` in delegated context.
    /// @param nonce The nonce value used by the signed payload.
    /// @param to The target contract that was called.
    /// @param value Native coin value sent with the call.
    /// @param selector First 4 bytes of calldata (function selector), or 0x00000000 if calldata is shorter than 4 bytes.
    event TransactionExecuted(
        address indexed executor,
        uint256 indexed nonce,
        address indexed to,
        uint256 value,
        bytes4 selector
    );

    /// @notice Emitted after the fee token transfer is processed.
    /// @dev `totalGas` is the gas amount used for fee calculation (measured + overheads).
    /// @param feeReceiver Address receiving the fee.
    /// @param feeToken ERC-20 token used for the fee payment.
    /// @param feeAmount Actual fee amount transferred in `feeToken` smallest units.
    /// @param totalGas Total gas amount used to compute the fee.
    event FeeTransferProcessed(
        address indexed feeReceiver,
        address indexed feeToken,
        uint256 feeAmount,
        uint256 totalGas,
        uint256 l1Fee
    );

    /// @notice Emitted when the fee transfer gas usage exceeds `feeTransferGasLimit`.
    /// @dev This event is emitted only when `forced` is true; otherwise the call reverts.
    /// @param gasLimit The signed gas limit budget for the fee transfer.
    /// @param gasUsed The measured gas used by the fee transfer.
    event FeeTransferGasLimitExceeded(uint256 gasLimit, uint256 gasUsed);

    /// @notice Emitted when the target call fails.
    /// @dev This event is emitted only when `forced` is true; otherwise the call reverts.
    /// @param to Target contract address that was called.
    /// @param value Native coin value sent with the call.
    /// @param selector First 4 bytes of calldata (function selector), or 0x00000000 if calldata is shorter than 4 bytes.
    event ExecutionFailed(address indexed to, uint256 value, bytes4 selector);

    /// @notice Allows the executor account to receive native coin (ETH).
    /// @dev Required to support value transfers and funding the account.
    receive() external payable;

    /// @notice Fallback handler for unknown function selectors.
    /// @dev Intentionally does nothing and accepts ETH to keep the executor permissive for
    ///      accidental transfers/calls in delegated (EIP-7702) context. No state is modified.
    fallback() external payable;

    /// @notice Executes a user-signed gasless transaction and optionally pays a fee in an ERC-20 token.
    /// @dev Must be called in the context of an EIP-7702 delegating account; the recovered signer is required
    ///      to equal `address(this)` in the delegated execution context.
    ///      Verifies `gaslessTx.nonce` and the EIP-712 signature before executing the target call and increments
    ///      the stored `nonce` on successful verification (state changes roll back if the transaction reverts later).
    ///      If the target call reverts with non-empty revert data (custom error / Error(string) / Panic(uint256)),
    ///      this function bubbles the revert data. If the target call reverts with empty data, it reverts with
    ///      {ExecutionFailed} for diagnostics.
    ///      Fee processing is executed only when `gaslessTx.fee.coinPriceInToken > 0`.
    /// @param gaslessTx The signed payload containing the target call, fee parameters, and nonce.
    /// @param signature The EIP-712 signature over `gaslessTx` produced by the executor account.
    /// @param forced If true, exceeding `feeTransferGasLimit` and call failure are reported via an event; otherwise they revert.
    function executeTransaction(
        GaslessTransaction calldata gaslessTx,
        bytes calldata signature,
        bool forced
    )
        external;

    /// @notice Returns the current nonce used for replay protection.
    /// @dev Each successful execution increments this value by 1.
    /// @return currentNonce The current stored nonce.
    function nonce() external view returns (uint256 currentNonce);
}