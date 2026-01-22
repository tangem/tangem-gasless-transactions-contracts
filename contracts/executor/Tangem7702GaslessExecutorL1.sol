// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;
import {Tangem7702GaslessExecutor} from "./Tangem7702GaslessExecutor.sol";


/// @title Tangem 7702 Gasless Executor for L1 chains (Ethereum mainnet, testnets)
/// @notice L1 chains don't have L1 data fees, so this returns 0 as L1 fee
// layout at keccak256(abi.encode(uint256(keccak256(bytes(tangem.storage.Tangem7702GaslessExecutor))) - 1)) & ~bytes32(uint256(0xff))
contract Tangem7702GaslessExecutorL1 is
    Tangem7702GaslessExecutor
    layout at 0x63126cb0ee213fd665c396acd692b9c0a13c8cc8bbd732af4f146bb546be9800
{
    /// @inheritdoc Tangem7702GaslessExecutor
    function _getL1Fee() internal pure override returns (uint256) {
        return 0;
    }
}