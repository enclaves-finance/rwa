// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.17;

import {EnclavesRWA} from "../EnclavesRWA.sol";

/// @title EnclavesPreciousMetals
/// @notice Category extension for vaulted precious metals.
contract EnclavesPreciousMetals is EnclavesRWA {
    bytes32 public metalType;
    uint256 public totalWeightGrams;
    bytes32 public vaultOperator;
    bytes32 public assayRef;

    struct PreciousMetalsInit {
        bytes32 metalType;
        uint256 totalWeightGrams;
        bytes32 vaultOperator;
        bytes32 assayRef;
    }

    function initialize(InitParams calldata base, PreciousMetalsInit calldata m) external initializer {
        __EnclavesRWA_init(base);
        metalType = m.metalType;
        totalWeightGrams = m.totalWeightGrams;
        vaultOperator = m.vaultOperator;
        assayRef = m.assayRef;
    }
}
