// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {IERC20Mock} from "./interfaces/IERC20Mock.sol";

contract ERC20Mock is ERC20, IERC20Mock {
    /// @notice Deploys an ERC-20 mock token with the given name and symbol.
    /// @dev Intended for tests only. Uses OpenZeppelin's {ERC20} implementation and exposes a public `mint`
    ///      function via {IERC20Mock} to create balances for test scenarios.
    /// @param name The ERC-20 token name.
    /// @param symbol The ERC-20 token symbol.
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}

    /// @inheritdoc IERC20Mock
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}