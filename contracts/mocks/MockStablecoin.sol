// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.17;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockStablecoin
/// @notice Plain ERC-20 with configurable decimals used as the stand-in for
///         USDC / USDT in tests.
contract MockStablecoin is ERC20 {
    uint8 internal _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
