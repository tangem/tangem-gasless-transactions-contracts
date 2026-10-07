// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

abstract contract Tangem7702ERC1271 is IERC1271 {
    /// @dev The magic value returned when the signature is invalid (ERC-1271)
    bytes4 private constant _INVALID_SIGNATURE = 0xffffffff;

    /// @inheritdoc IERC1271
    /// @dev Accepts both 65-byte and 64-byte (ERC-2098) encodings of the same signature
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        (uint8 v, bytes32 r, bytes32 s) = ECDSA.parseCalldata(signature);
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, v, r, s);

        return recovered == address(this) && err == ECDSA.RecoverError.NoError
            ? IERC1271.isValidSignature.selector
            : _INVALID_SIGNATURE;
    }
}
