// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

contract SignatureCheckerMock {
    function isValidSignatureNow(address signer, bytes32 hash, bytes memory signature) external view returns (bool) {
        return SignatureChecker.isValidSignatureNow(signer, hash, signature);
    }
}
