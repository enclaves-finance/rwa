// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.17;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * @title YieldDistributor
 * @notice Per-token, stablecoin-denominated revenue distribution.
 *
 *         The platform creates a `Distribution` for a given period — passing
 *         the {EnclavesRWA} snapshot id taken at the record date — and
 *         deposits stablecoin into this contract. Token holders then claim
 *         their pro-rata share `(balanceAt / totalSupplyAt) * totalAmount`.
 */
contract YieldDistributor is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // =====================================================================
    // Types
    // =====================================================================

    struct Distribution {
        uint256 totalAmount;
        address paymentToken;
        uint256 snapshotId;
        uint64 distributionDate;
        uint64 claimDeadline;
        bool finalized;
    }

    // =====================================================================
    // State
    // =====================================================================

    /// @notice The {EnclavesRWA}-compatible token (must expose
    ///         `balanceOfAt` and `totalSupplyAt`).
    IEnclavesSnapshotToken public immutable token;
    /// @notice Platform agent permitted to create distributions.
    address public platformAgent;

    uint256 public currentPeriod;
    mapping(uint256 => Distribution) public distributions;
    mapping(uint256 => mapping(address => bool)) public claimed;

    // =====================================================================
    // Events
    // =====================================================================

    event DistributionCreated(
        uint256 indexed period, uint256 amount, address paymentToken, uint256 snapshotId
    );
    event YieldClaimed(uint256 indexed period, address indexed holder, uint256 amount);
    event UnclaimedSwept(uint256 indexed period, uint256 amount, address indexed to);
    event PlatformAgentChanged(address indexed prev, address indexed next);

    // =====================================================================
    // Init
    // =====================================================================

    constructor(address token_, address platformAgent_, address owner_) {
        require(token_ != address(0) && platformAgent_ != address(0) && owner_ != address(0), "bad addr");
        token = IEnclavesSnapshotToken(token_);
        platformAgent = platformAgent_;
        _transferOwnership(owner_);
    }

    modifier onlyPlatform() {
        require(msg.sender == platformAgent, "not platform");
        _;
    }

    // =====================================================================
    // Distribution creation
    // =====================================================================

    /**
     * @notice Pulls `amount` of `paymentToken` from the caller, takes a
     *         token-balance snapshot and opens a new period for claims.
     */
    function createDistribution(
        uint256 amount,
        address paymentToken,
        uint64 claimDeadline
    ) external onlyPlatform returns (uint256 period) {
        require(amount > 0, "amount=0");
        require(paymentToken != address(0), "bad token");

        uint256 snapshotId = token.snapshot();
        IERC20(paymentToken).safeTransferFrom(msg.sender, address(this), amount);

        currentPeriod += 1;
        period = currentPeriod;
        distributions[period] = Distribution({
            totalAmount: amount,
            paymentToken: paymentToken,
            snapshotId: snapshotId,
            distributionDate: uint64(block.timestamp),
            claimDeadline: claimDeadline,
            finalized: true
        });
        emit DistributionCreated(period, amount, paymentToken, snapshotId);
    }

    // =====================================================================
    // Claims
    // =====================================================================

    function claim(uint256 period) public nonReentrant {
        _claim(period, msg.sender);
    }

    function claimMultiple(uint256[] calldata periods) external nonReentrant {
        for (uint256 i = 0; i < periods.length; ++i) {
            _claim(periods[i], msg.sender);
        }
    }

    function _claim(uint256 period, address holder) internal {
        Distribution storage d = distributions[period];
        require(d.finalized, "no period");
        require(!claimed[period][holder], "claimed");
        require(d.claimDeadline == 0 || block.timestamp <= d.claimDeadline, "claim closed");

        uint256 share = getClaimable(period, holder);
        require(share > 0, "nothing to claim");

        claimed[period][holder] = true;
        IERC20(d.paymentToken).safeTransfer(holder, share);
        emit YieldClaimed(period, holder, share);
    }

    function getClaimable(uint256 period, address holder) public view returns (uint256) {
        Distribution memory d = distributions[period];
        if (!d.finalized) return 0;
        if (claimed[period][holder]) return 0;
        uint256 balance = token.balanceOfAt(holder, d.snapshotId);
        if (balance == 0) return 0;
        uint256 supply = token.totalSupplyAt(d.snapshotId);
        if (supply == 0) return 0;
        return (balance * d.totalAmount) / supply;
    }

    // =====================================================================
    // Sweeps & admin
    // =====================================================================

    function sweepUnclaimed(uint256 period, address to) external onlyOwner {
        Distribution storage d = distributions[period];
        require(d.finalized, "no period");
        require(d.claimDeadline > 0 && block.timestamp > d.claimDeadline, "still open");
        IERC20 stable = IERC20(d.paymentToken);
        uint256 bal = stable.balanceOf(address(this));
        stable.safeTransfer(to, bal);
        emit UnclaimedSwept(period, bal, to);
    }

    function setPlatformAgent(address newAgent) external onlyOwner {
        require(newAgent != address(0), "bad agent");
        emit PlatformAgentChanged(platformAgent, newAgent);
        platformAgent = newAgent;
    }
}

interface IEnclavesSnapshotToken {
    function snapshot() external returns (uint256);
    function balanceOfAt(address account, uint256 snapshotId) external view returns (uint256);
    function totalSupplyAt(uint256 snapshotId) external view returns (uint256);
}
