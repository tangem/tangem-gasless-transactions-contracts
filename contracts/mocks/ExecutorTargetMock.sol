// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

import {IExecutorTargetMock} from "./interfaces/IExecutorTargetMock.sol";

contract ExecutorTargetMock is IExecutorTargetMock {
    /// @inheritdoc IExecutorTargetMock
    uint256 public calls;

    /// @inheritdoc IExecutorTargetMock
    uint256 public lastValue;

    /// @inheritdoc IExecutorTargetMock
    receive() external payable {}

    /// @inheritdoc IExecutorTargetMock
    fallback() external payable {
        revert("FALLBACK");
    }

    /// @inheritdoc IExecutorTargetMock
    function ok(bytes calldata payload) external payable returns (bytes32) {
        unchecked {
            ++calls;
        }
        lastValue = msg.value;
        emit OkCalled(msg.sender, msg.value, payload);
        return keccak256(payload);
    }

    /// @inheritdoc IExecutorTargetMock
    function fail() external pure {
        revert("FAIL");
    }

    /// @inheritdoc IExecutorTargetMock
    function failNoData() external pure {
        assembly {
            revert(0, 0)
        }
    }
}
