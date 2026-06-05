// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.17;

import {EnclavesRWA} from "../EnclavesRWA.sol";

/// @title EnclavesCollectibles
/// @notice Category extension for high-value collectibles held in third-party
///         vaults — fine art, watches, wine, etc.
contract EnclavesCollectibles is EnclavesRWA {
    bytes32 public itemCategory;
    bytes32 public authenticationRef;
    bytes32 public vaultLocation;
    bytes32 public insurerRef;

    struct CollectiblesInit {
        bytes32 itemCategory;
        bytes32 authenticationRef;
        bytes32 vaultLocation;
        bytes32 insurerRef;
    }

    function initialize(InitParams calldata base, CollectiblesInit calldata c) external initializer {
        __EnclavesRWA_init(base);
        itemCategory = c.itemCategory;
        authenticationRef = c.authenticationRef;
        vaultLocation = c.vaultLocation;
        insurerRef = c.insurerRef;
    }
}
