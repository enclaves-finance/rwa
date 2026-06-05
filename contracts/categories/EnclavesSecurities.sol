// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.17;

import {EnclavesRWA} from "../EnclavesRWA.sol";

/// @title EnclavesSecurities
/// @notice Category extension for traditional securities (bonds, notes, equity).
///         Carries the ISIN, custodian, maturity date and coupon rate.
contract EnclavesSecurities is EnclavesRWA {
    bytes32 public securityType;
    bytes32 public isinCode;
    bytes32 public custodianId;
    uint64 public securityMaturityDate;
    uint256 public couponRateBps;

    struct SecuritiesInit {
        bytes32 securityType;
        bytes32 isinCode;
        bytes32 custodianId;
        uint64 maturityDate;
        uint256 couponRateBps;
    }

    function initialize(InitParams calldata base, SecuritiesInit calldata s) external initializer {
        __EnclavesRWA_init(base);
        securityType = s.securityType;
        isinCode = s.isinCode;
        custodianId = s.custodianId;
        securityMaturityDate = s.maturityDate;
        couponRateBps = s.couponRateBps;
    }
}
