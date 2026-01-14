// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

interface IExecutorTargetMock {
    /// @notice Emitted when {ok} is successfully called.
    /// @dev Used by tests to confirm the call executed, to capture the forwarded `msg.value`,
    ///      and to record the payload passed in the calldata.
    /// @param caller The address that invoked {ok}.
    /// @param value The `msg.value` received by {ok}.
    /// @param payload The bytes payload passed to {ok}.
    event OkCalled(address caller, uint256 value, bytes payload);

    /// @notice Allows the mock to receive native coin (ETH) with empty calldata.
    /// @dev Used by tests to validate ETH forwarding and to support direct funding transfers.
    receive() external payable;

    /// @notice Fallback handler for calls with unknown function selectors or short calldata.
    /// @dev Used by tests to exercise executor selector extraction and failure paths when calldata is invalid.
    fallback() external payable;

    /// @notice Test function that succeeds and records basic call information.
    /// @dev Intended to be called through the executor to validate forwarding of calldata and `msg.value`.
    ///      Implementations typically increment an internal call counter, store the last received value,
    ///      emit {OkCalled}, and return a deterministic value derived from `payload`.
    /// @param payload Arbitrary bytes payload to be recorded/processed by the mock.
    /// @return result A deterministic bytes32 result (implementation-defined, typically derived from `payload`).
    function ok(bytes calldata payload) external payable returns (bytes32 result);

    /// @notice Returns how many times {ok} was called.
    /// @dev Used by tests to assert that the expected number of successful calls were executed.
    /// @return count The number of calls recorded.
    function calls() external view returns (uint256 count);

    /// @notice Returns the last `msg.value` observed by {ok}.
    /// @dev Used by tests to confirm that ETH value was forwarded correctly by the executor.
    /// @return value The last recorded value.
    function lastValue() external view returns (uint256 value);

    /// @notice Test function that always reverts.
    /// @dev Used by tests to trigger the executor's {ExecutionFailed} error path.
    function fail() external pure;

    /// @notice Test function that always reverts with empty returndata.
    /// @dev Used by tests to cover the executor branch where the target call fails but returns no revert data,
    ///      so the executor cannot bubble a revert reason and must fallback to {ExecutionFailed}.
    function failNoData() external pure;
}