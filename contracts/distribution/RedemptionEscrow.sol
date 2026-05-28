// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.17;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IEnclavesRWA} from "../interfaces/IEnclavesRWA.sol";

/**
 * @title RedemptionEscrow
 * @notice Holds stablecoins earmarked for the buyback price at maturity.
 *         The associated {EnclavesRWA} token pulls funds from this escrow
 *         when holders call `redeemAtMaturity`.
 */
contract RedemptionEscrow is Ownable {
    using SafeERC20 for IERC20;

    IEnclavesRWA public immutable rwa;
    IERC20 public immutable paymentToken;
    address public platformAgent;

    event Funded(address indexed funder, uint256 amount);
    event PlatformAgentChanged(address indexed prev, address indexed next);
    event ApprovalRefreshed(uint256 newAllowance);

    constructor(address rwa_, address paymentToken_, address platformAgent_, address owner_) {
        require(rwa_ != address(0) && paymentToken_ != address(0), "bad addr");
        require(platformAgent_ != address(0) && owner_ != address(0), "bad addr");
        rwa = IEnclavesRWA(rwa_);
        paymentToken = IERC20(paymentToken_);
        platformAgent = platformAgent_;
        _transferOwnership(owner_);

        // Pre-approve the token contract for unlimited transfers. Holders
        // call `redeemAtMaturity` on the RWA which will safeTransferFrom
        // this escrow.
        IERC20(paymentToken_).approve(rwa_, type(uint256).max);
        emit ApprovalRefreshed(type(uint256).max);
    }

    modifier onlyPlatform() {
        require(msg.sender == platformAgent, "not platform");
        _;
    }

    function fund(uint256 amount) external onlyPlatform {
        paymentToken.safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(msg.sender, amount);
    }

    function availableFunds() external view returns (uint256) {
        return paymentToken.balanceOf(address(this));
    }

    function isSufficientlyFunded() external view returns (bool) {
        uint256 outstanding = rwa.totalIssued();
        // Use 18 decimals by default — actual RWA may differ; this helper is
        // best-effort. Use the more accurate `availableFunds() / pricePerToken`
        // off-chain.
        uint256 required = outstanding * IBuyback(address(rwa)).buybackPricePerToken() / 1e18;
        return paymentToken.balanceOf(address(this)) >= required;
    }

    function refreshApproval() external onlyOwner {
        paymentToken.approve(address(rwa), type(uint256).max);
        emit ApprovalRefreshed(type(uint256).max);
    }

    function setPlatformAgent(address newAgent) external onlyOwner {
        require(newAgent != address(0), "bad agent");
        emit PlatformAgentChanged(platformAgent, newAgent);
        platformAgent = newAgent;
    }
}

interface IBuyback {
    function buybackPricePerToken() external view returns (uint256);
}
