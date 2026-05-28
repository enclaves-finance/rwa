// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.17;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IStakingBond} from "./interfaces/IStakingBond.sol";
import {IEnclavesRWA} from "./interfaces/IEnclavesRWA.sol";

/**
 * @title StakingBond
 * @notice Global singleton that holds ENCL on behalf of issuers and
 *         determines whether a given token is bonded enough to mint.
 *
 *         Required ENCL is computed at bond time using:
 *
 *             required = (assetValueUsd * bondingRateBps) /
 *                        (10_000 * enclPriceUsd / 1e18)
 *
 *         and is fixed for the life of the bond. Top-ups simply add ENCL on
 *         top of the existing required floor; unbonding returns ENCL only
 *         once the token reaches `AssetState.Retired`.
 */
contract StakingBond is IStakingBond, Ownable {
    using SafeERC20 for IERC20;

    // =====================================================================
    // Errors
    // =====================================================================

    error AlreadyBonded();
    error NotBonded();
    error NotRetired();
    error InsufficientBond();

    // =====================================================================
    // State
    // =====================================================================

    IERC20 public immutable enclToken;
    address public admin;
    address public slashReceiver;
    /// @notice ENCL/USD price (1e18-scaled). Platform-set.
    uint256 public enclPriceUsd;
    mapping(uint8 => uint256) public bondingRateBps;

    struct Bond {
        address staker;
        uint256 amount;
        uint256 required;
        uint8 trustClass;
        uint256 assetValueAtBond;
        uint64 bondedAt;
        bool active;
    }

    mapping(address => Bond) public bonds;
    mapping(address => uint256) public totalStakedBy;

    // =====================================================================
    // Events
    // =====================================================================

    event Bonded(
        address indexed token,
        address indexed staker,
        uint256 amount,
        uint256 required,
        uint8 trustClass
    );
    event ToppedUp(address indexed token, uint256 amount);
    event Unbonded(address indexed token, uint256 amount);
    event Slashed(address indexed token, uint256 amount, string reason);
    event BondingRateSet(uint8 indexed trustClass, uint256 bps);
    event PriceSet(uint256 priceUsd);
    event SlashReceiverChanged(address indexed prev, address indexed next);
    event AdminChanged(address indexed prev, address indexed next);

    // =====================================================================
    // Init
    // =====================================================================

    constructor(address enclToken_, address admin_, address slashReceiver_, uint256 enclPriceUsd_) {
        require(enclToken_ != address(0), "bad encl");
        require(admin_ != address(0), "bad admin");
        require(slashReceiver_ != address(0), "bad receiver");
        require(enclPriceUsd_ > 0, "bad price");
        enclToken = IERC20(enclToken_);
        admin = admin_;
        slashReceiver = slashReceiver_;
        enclPriceUsd = enclPriceUsd_;
        _setDefaultRates();
    }

    function _setDefaultRates() internal {
        bondingRateBps[1] = 150; // Class I
        bondingRateBps[2] = 400; // Class II
        bondingRateBps[3] = 700; // Class III
        bondingRateBps[4] = 1000; // Class IV
        bondingRateBps[5] = 1600; // Class V
        bondingRateBps[6] = 2000; // Class VI
    }

    // =====================================================================
    // Admin
    // =====================================================================

    modifier onlyAdmin() {
        require(msg.sender == admin, "not admin");
        _;
    }

    function setAdmin(address newAdmin) external onlyOwner {
        require(newAdmin != address(0), "bad admin");
        emit AdminChanged(admin, newAdmin);
        admin = newAdmin;
    }

    function setSlashReceiver(address newReceiver) external onlyOwner {
        require(newReceiver != address(0), "bad receiver");
        emit SlashReceiverChanged(slashReceiver, newReceiver);
        slashReceiver = newReceiver;
    }

    function setBondingRate(uint8 trustClass, uint256 bps) external onlyAdmin {
        bondingRateBps[trustClass] = bps;
        emit BondingRateSet(trustClass, bps);
    }

    function setEnclPrice(uint256 priceUsd) external onlyAdmin {
        require(priceUsd > 0, "bad price");
        enclPriceUsd = priceUsd;
        emit PriceSet(priceUsd);
    }

    // =====================================================================
    // Bond lifecycle
    // =====================================================================

    function bond(address token, uint256 amount, uint8 trustClass, uint256 assetValueUsd) external {
        if (bonds[token].active) revert AlreadyBonded();
        uint256 required = getRequiredStake(trustClass, assetValueUsd);
        require(amount >= required, "insufficient amount");

        enclToken.safeTransferFrom(msg.sender, address(this), amount);

        bonds[token] = Bond({
            staker: msg.sender,
            amount: amount,
            required: required,
            trustClass: trustClass,
            assetValueAtBond: assetValueUsd,
            bondedAt: uint64(block.timestamp),
            active: true
        });
        totalStakedBy[msg.sender] += amount;
        emit Bonded(token, msg.sender, amount, required, trustClass);
    }

    function topUp(address token, uint256 amount) external {
        Bond storage b = bonds[token];
        if (!b.active) revert NotBonded();
        enclToken.safeTransferFrom(msg.sender, address(this), amount);
        b.amount += amount;
        totalStakedBy[msg.sender] += amount;
        emit ToppedUp(token, amount);
    }

    /// @notice Releases the bond when the associated token has reached
    ///         {AssetState.Retired}. Only the original staker may unbond.
    function unbond(address token) external {
        Bond storage b = bonds[token];
        if (!b.active) revert NotBonded();
        require(msg.sender == b.staker, "not staker");
        require(
            IEnclavesRWA(token).assetState() == IEnclavesRWA.AssetState.Retired,
            "not retired"
        );
        uint256 amount = b.amount;
        b.active = false;
        b.amount = 0;
        totalStakedBy[msg.sender] -= amount;
        enclToken.safeTransfer(b.staker, amount);
        emit Unbonded(token, amount);
    }

    function slash(address token, uint256 amount, string calldata reason) external onlyAdmin {
        Bond storage b = bonds[token];
        if (!b.active) revert NotBonded();
        require(amount <= b.amount, "exceeds bond");
        b.amount -= amount;
        totalStakedBy[b.staker] -= amount;
        enclToken.safeTransfer(slashReceiver, amount);
        emit Slashed(token, amount, reason);
        if (b.amount < b.required) {
            // staker now under-collateralised; leave bond active but mint
            // gate will fail until topped-up. (isBonded() checks `>= required`.)
        }
    }

    // =====================================================================
    // Views
    // =====================================================================

    function isBonded(address token) external view override returns (bool) {
        Bond memory b = bonds[token];
        return b.active && b.amount >= b.required;
    }

    function getRequiredStake(uint8 trustClass, uint256 assetValueUsd)
        public
        view
        override
        returns (uint256)
    {
        uint256 bps = bondingRateBps[trustClass];
        require(bps > 0, "unknown trust class");
        // `assetValueUsd` is in plain USD; `enclPriceUsd` is 1e18-scaled.
        // Result is in ENCL wei (token decimals = 18):
        //   required_wei = assetValueUsd * bps * 1e36 / (10_000 * enclPriceUsd)
        return (assetValueUsd * bps * 1e36) / (10_000 * enclPriceUsd);
    }
}
