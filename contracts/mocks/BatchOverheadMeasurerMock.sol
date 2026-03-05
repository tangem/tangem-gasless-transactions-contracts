// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

contract BatchOverheadMeasurerMock {
    struct Transaction {
        address to;
        uint256 value;
        uint256 gasLimit;
        bytes data;
    }

    event LoopGas(uint256 gasBeforeLoop, uint256 gasAfterLoop);

    function measure(Transaction[] calldata txs) external {
        uint256 executedCalls = 0;
        uint256 gasBefore = gasleft();
        for (uint256 i = 0; i < txs.length; ) {
            Transaction calldata transaction = txs[i];
            (bool success, bytes memory returnData)
                = transaction.to.call{value: transaction.value, gas: transaction.gasLimit}(transaction.data);
            if (!success) {
                if (returnData.length == 0) {
                    revert("call failed");
                }
                assembly {
                    revert(add(returnData, 0x20), mload(returnData))
                }
            }
            executedCalls = i + 1;
            unchecked {
                ++i;
            }
        }
        emit LoopGas(gasBefore, gasleft());
    }
}
