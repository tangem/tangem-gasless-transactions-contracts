// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

contract ExecutorTargetMock {
    uint256 public calls;

    uint256 public lastValue;

    event OkCalled(address caller, uint256 value, bytes payload);

    receive() external payable {}

    fallback() external payable {
        revert("FALLBACK");
    }

    function ok(bytes calldata payload) external payable returns (bytes32) {
        unchecked {
            ++calls;
        }
        lastValue = msg.value;
        emit OkCalled(msg.sender, msg.value, payload);
        return keccak256(payload);
    }

    function fail() external pure {
        revert("FAIL");
    }

    function failNoData() external pure {
        assembly {
            revert(0, 0)
        }
    }
}
