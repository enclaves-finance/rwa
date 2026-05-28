// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.17;

import {IIdentityRegistry} from "../interfaces/IIdentityRegistry.sol";

/**
 * @title MockIdentityRegistry
 * @notice In-memory stand-in for the T-REX IdentityRegistry. Useful for
 *         unit tests and local development; not for production.
 */
contract MockIdentityRegistry is IIdentityRegistry {
    address public admin;

    struct Profile {
        address onchainId;
        uint16 country;
        bool verified;
    }

    mapping(address => Profile) internal _profiles;

    event ProfileSet(address indexed wallet, address onchainId, uint16 country, bool verified);

    constructor() {
        admin = msg.sender;
    }

    modifier onlyAdmin() {
        require(msg.sender == admin, "not admin");
        _;
    }

    function setProfile(address wallet, address onchainId, uint16 country, bool verified)
        external
        onlyAdmin
    {
        _profiles[wallet] = Profile(onchainId, country, verified);
        emit ProfileSet(wallet, onchainId, country, verified);
    }

    function setAdmin(address newAdmin) external onlyAdmin {
        admin = newAdmin;
    }

    function isVerified(address userAddress) external view override returns (bool) {
        return _profiles[userAddress].verified;
    }

    function identity(address userAddress) external view override returns (address) {
        return _profiles[userAddress].onchainId;
    }

    function investorCountry(address userAddress) external view override returns (uint16) {
        return _profiles[userAddress].country;
    }
}
