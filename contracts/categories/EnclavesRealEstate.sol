// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.17;

import {EnclavesRWA} from "../EnclavesRWA.sol";

/// @title EnclavesRealEstate
/// @notice Category extension for real-estate tokens.
contract EnclavesRealEstate is EnclavesRWA {
    bytes32 public propertyRegistryId;
    bytes32 public propertyType;
    uint256 public totalAreaSqm;
    bytes32 public rentalStatus;

    struct RealEstateInit {
        bytes32 propertyRegistryId;
        bytes32 propertyType;
        uint256 totalAreaSqm;
        bytes32 rentalStatus;
    }

    event RentalStatusUpdated(bytes32 newStatus);

    function initialize(InitParams calldata base, RealEstateInit calldata r) external initializer {
        __EnclavesRWA_init(base);
        propertyRegistryId = r.propertyRegistryId;
        propertyType = r.propertyType;
        totalAreaSqm = r.totalAreaSqm;
        rentalStatus = r.rentalStatus;
    }

    function setRentalStatus(bytes32 newStatus) external onlyPlatform {
        rentalStatus = newStatus;
        emit RentalStatusUpdated(newStatus);
    }
}
