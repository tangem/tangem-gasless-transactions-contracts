// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

interface ITangem7702GaslessExecutorMock {
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

    /// @notice Allows the mock (and delegated executor account in tests) to receive native coin (ETH).
    /// @dev Required so the delegated account can accept ETH transfers during testing.
    receive() external payable;

    /// @notice Executes a gasless transaction on the mock and records all inputs for assertions.
    /// @dev This mock does not validate signatures, nonces, or fee logic. It only captures the
    ///      calldata fields and parameters passed by the caller. Intended for EntryPoint forwarding tests.
    /// @param gaslessTx The gasless transaction payload to record.
    /// @param signature Raw signature bytes to record (stored as keccak256 hash).
    /// @param feeReceiver Fee receiver address to record.
    /// @param forced Forced flag to record.
    function executeTransaction(
        GaslessTransaction calldata gaslessTx,
        bytes calldata signature,
        address feeReceiver,
        bool forced
    ) 
        external;

    /// @notice Returns how many times `executeTransaction` was called on this mock.
    /// @dev Incremented on each `executeTransaction` call.
    /// @return count The number of calls recorded by the mock.
    function calls() external view returns (uint256 count);

    /// @notice Returns the last `msg.sender` observed by the mock.
    /// @dev For EntryPoint tests, this should be the EntryPoint address when forwarding works.
    /// @return sender The last caller address.
    function lastMsgSender() external view returns (address sender);

    /// @notice Returns the last fee receiver passed to `executeTransaction`.
    /// @dev Captured from the `feeReceiver` parameter of the last call.
    /// @return receiver The last fee receiver address.
    function lastFeeReceiver() external view returns (address receiver);

    /// @notice Returns the last `forced` flag passed to `executeTransaction`.
    /// @dev Captured from the `forced` parameter of the last call.
    /// @return wasForced The last `forced` value.
    function lastForced() external view returns (bool wasForced);

    /// @notice Returns the last target address (`gaslessTx.transaction.to`) recorded by the mock.
    /// @dev Captured from the signed payload passed to the last call.
    /// @return to The last target address.
    function lastTo() external view returns (address to);

    /// @notice Returns the last ETH/native value (`gaslessTx.transaction.value`) recorded by the mock.
    /// @dev Captured from the signed payload passed to the last call.
    /// @return value The last value.
    function lastValue() external view returns (uint256 value);

    /// @notice Returns the keccak256 hash of the last calldata (`gaslessTx.transaction.data`) recorded by the mock.
    /// @dev Stored as `keccak256(gaslessTx.transaction.data)` to avoid saving dynamic bytes.
    /// @return hash The calldata hash of the last call.
    function lastDataHash() external view returns (bytes32 hash);

    /// @notice Returns the last fee token address (`gaslessTx.fee.feeToken`) recorded by the mock.
    /// @dev Captured from the signed payload passed to the last call.
    /// @return token The last fee token address.
    function lastFeeToken() external view returns (address token);

    /// @notice Returns the last max token fee (`gaslessTx.fee.maxTokenFee`) recorded by the mock.
    /// @dev Captured from the signed payload passed to the last call.
    /// @return maxFee The last max token fee.
    function lastMaxTokenFee() external view returns (uint256 maxFee);

    /// @notice Returns the last nonce (`gaslessTx.nonce`) recorded by the mock.
    /// @dev Captured from the signed payload passed to the last call.
    /// @return nonceValue The last gasless nonce value.
    function lastGaslessNonce() external view returns (uint256 nonceValue);

    /// @notice Returns the keccak256 hash of the last signature bytes recorded by the mock.
    /// @dev Stored as `keccak256(signature)` to avoid saving dynamic bytes.
    /// @return hash The signature hash of the last call.
    function lastSignatureHash() external view returns (bytes32 hash);

    /// @notice Returns the nonce value exposed by the mock.
    /// @dev Always returns 0. The mock does not implement nonce management and is only used for EntryPoint tests.
    /// @return currentNonce Always 0.
    function nonce() external pure returns (uint256);
}
