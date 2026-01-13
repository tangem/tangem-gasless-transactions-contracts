// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IERC20Mock is IERC20 {
    /// @notice Mints `amount` tokens to `to`.
    /// @dev Test helper to set up token balances without relying on external faucets or complex setup.
    ///      Implementations may restrict access in production-like environments, but test mocks typically allow it.
    /// @param to The address that will receive the newly minted tokens.
    /// @param amount The amount of tokens to mint (in the token's smallest units).
    function mint(address to, uint256 amount) external;
}