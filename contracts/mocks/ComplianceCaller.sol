// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.17;

import {IEnclavesCompliance} from "../interfaces/IEnclavesCompliance.sol";

/**
 * @title ComplianceCaller
 * @notice Test helper that lets a unit test invoke
 *         {EnclavesCompliance.created/destroyed/transferred} from a contract
 *         address (so the `onlyRegisteredToken` modifier is satisfied)
 *         without standing up the full EnclavesRWA stack.
 *
 *         Also exposes a configurable `balanceOf` / `balanceOfInvestor`
 *         so the destroyed-path in compliance can be exercised by writing
 *         the expected balance.
 */
contract ComplianceCaller {
    IEnclavesCompliance public immutable compliance;

    mapping(address => uint256) internal _balance;
    mapping(address => uint256) internal _investorBalance;

    constructor(address compliance_) {
        compliance = IEnclavesCompliance(compliance_);
    }

    function created(address to, uint256 amount) external {
        _balance[to] += amount;
        _investorBalance[to] += amount;
        compliance.created(to, amount);
    }

    function destroyed(address from, uint256 amount) external {
        if (_balance[from] >= amount) _balance[from] -= amount;
        if (_investorBalance[from] >= amount) _investorBalance[from] -= amount;
        compliance.destroyed(from, amount);
    }

    function transferred(address from, address to, uint256 amount) external {
        if (_balance[from] >= amount) _balance[from] -= amount;
        _balance[to] += amount;
        if (_investorBalance[from] >= amount) _investorBalance[from] -= amount;
        _investorBalance[to] += amount;
        compliance.transferred(from, to, amount);
    }

    /// @dev Lets the test set bookkeeping to whatever the compliance
    ///      destroyed-path is expected to read.
    function setBalance(address account, uint256 amount) external {
        _balance[account] = amount;
        _investorBalance[account] = amount;
    }

    function balanceOf(address account) external view returns (uint256) {
        return _balance[account];
    }

    function balanceOfInvestor(address account) external view returns (uint256) {
        return _investorBalance[account];
    }
}
