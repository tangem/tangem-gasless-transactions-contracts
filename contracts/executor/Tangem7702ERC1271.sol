// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

import {SignerERC7702} from "@openzeppelin/contracts/utils/cryptography/signers/SignerERC7702.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

abstract contract Tangem7702ERC1271 is IERC1271, SignerERC7702 {
    bytes4 private constant _INVALID_SIGNATURE = 0xffffffff;

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        return _rawSignatureValidation(hash, signature) ? IERC1271.isValidSignature.selector : _INVALID_SIGNATURE;
    }

    function _rawSignatureValidation(bytes32 hash, bytes calldata signature) internal view override returns (bool) {
        if (signature.length == 64) {
            (address recovered, ECDSA.RecoverError err,) =
                ECDSA.tryRecover(hash, bytes32(signature[0:32]), bytes32(signature[32:64]));

            return address(this) == recovered && err == ECDSA.RecoverError.NoError;
        }

        return super._rawSignatureValidation(hash, signature);
    }
}
