// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.17;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import {IEnclavesCompliance} from "./interfaces/IEnclavesCompliance.sol";
import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";

/**
 * @title EnclavesCompliance
 * @notice Per-Enclave compliance module shared across every token deployed
 *         under the same Enclave. Mirrors the spec:
 *
 *           - SPV approval gate (per-token, per-holder, with intermediaries)
 *           - jurisdiction rules (default + per-token overrides)
 *           - holder caps per country
 *           - per-holder balance ceiling
 *           - per-transfer minimum
 *           - investor counting at ONCHAINID level, not wallet level
 *
 *         Each call from a registered token is authenticated by the token
 *         address itself; the platform (Enclave admin) configures rules.
 */
contract EnclavesCompliance is IEnclavesCompliance, Ownable {
    using EnumerableSet for EnumerableSet.AddressSet;

    // =====================================================================
    // Errors
    // =====================================================================

    error NotRegisteredToken();
    error InvalidIntermediary();

    // =====================================================================
    // Roles & wiring
    // =====================================================================

    bytes32 public immutable enclaveId;
    address public platformAgent;
    IIdentityRegistry public immutable identityRegistry;

    /// @notice Tokens authorised to call the mutating hooks.
    mapping(address => bool) public registeredTokens;

    // =====================================================================
    // Enclave-wide defaults
    // =====================================================================

    mapping(uint16 => bool) public defaultCountryAllowed;

    // =====================================================================
    // Per-token rules
    // =====================================================================

    // SPV approval for direct holders.
    mapping(address => mapping(address => bool)) public spvApproved;
    // Per-token country override; if not set the enclave default applies.
    mapping(address => mapping(uint16 => bool)) internal _countryAllowed;
    mapping(address => mapping(uint16 => bool)) internal _countryAllowedSet;

    mapping(address => mapping(uint16 => uint256)) public maxHoldersPerCountry;
    mapping(address => uint256) public maxBalancePerHolder;
    mapping(address => uint256) public minTransferAmount;

    // =====================================================================
    // Intermediaries
    // =====================================================================

    struct Intermediary {
        bool active;
        bool globalApproval;
        bytes32 entityId;
    }

    mapping(address => Intermediary) public intermediaries;
    // intermediary => token => approved
    mapping(address => mapping(address => bool)) public intermediaryTokenApproval;

    // =====================================================================
    // Counters (token => …)
    // =====================================================================

    // token => countryCode => unique ONCHAINID count
    mapping(address => mapping(uint16 => uint256)) internal _holderCountByCountry;
    // token => ONCHAINID => bool
    mapping(address => mapping(address => bool)) public identityCounted;
    mapping(address => uint256) internal _totalInvestorCount;

    // =====================================================================
    // Events
    // =====================================================================

    event TokenRegistered(address indexed token);
    event TokenUnregistered(address indexed token);
    event PlatformAgentChanged(address indexed prev, address indexed next);
    event DefaultCountrySet(uint16 country, bool allowed);
    event CountrySet(address indexed token, uint16 country, bool allowed);
    event SpvApprovalChanged(address indexed token, address indexed holder, bool approved);
    event MaxHoldersPerCountrySet(address indexed token, uint16 country, uint256 max);
    event MaxBalancePerHolderSet(address indexed token, uint256 max);
    event MinTransferAmountSet(address indexed token, uint256 min);
    event IntermediaryRegistered(address indexed intermediary, bool global, bytes32 entityId);
    event IntermediaryDeactivated(address indexed intermediary);
    event IntermediaryTokenApprovalChanged(
        address indexed intermediary, address indexed token, bool approved
    );

    // =====================================================================
    // Modifiers
    // =====================================================================

    modifier onlyPlatform() {
        require(msg.sender == platformAgent, "not platform");
        _;
    }

    modifier onlyRegisteredToken() {
        if (!registeredTokens[msg.sender]) revert NotRegisteredToken();
        _;
    }

    // =====================================================================
    // Init
    // =====================================================================

    constructor(bytes32 enclaveId_, address identityRegistry_, address platformAgent_) {
        require(identityRegistry_ != address(0), "bad ir");
        require(platformAgent_ != address(0), "bad agent");
        enclaveId = enclaveId_;
        identityRegistry = IIdentityRegistry(identityRegistry_);
        platformAgent = platformAgent_;
    }

    // =====================================================================
    // Admin
    // =====================================================================

    function setPlatformAgent(address newAgent) external onlyOwner {
        require(newAgent != address(0), "bad agent");
        emit PlatformAgentChanged(platformAgent, newAgent);
        platformAgent = newAgent;
    }

    function registerToken(address token) external onlyOwner {
        registeredTokens[token] = true;
        emit TokenRegistered(token);
    }

    function unregisterToken(address token) external onlyOwner {
        registeredTokens[token] = false;
        emit TokenUnregistered(token);
    }

    // =====================================================================
    // Enclave defaults
    // =====================================================================

    function setDefaultCountryAllowed(uint16 country, bool allowed) external onlyPlatform {
        defaultCountryAllowed[country] = allowed;
        emit DefaultCountrySet(country, allowed);
    }

    // =====================================================================
    // Per-token rules
    // =====================================================================

    function setSpvApproval(address token, address holder, bool approved) public onlyPlatform {
        spvApproved[token][holder] = approved;
        emit SpvApprovalChanged(token, holder, approved);
    }

    function batchSetSpvApproval(address token, address[] calldata holders, bool approved)
        external
        onlyPlatform
    {
        for (uint256 i = 0; i < holders.length; ++i) {
            spvApproved[token][holders[i]] = approved;
            emit SpvApprovalChanged(token, holders[i], approved);
        }
    }

    function setCountryAllowed(address token, uint16 country, bool allowed) external onlyPlatform {
        _countryAllowed[token][country] = allowed;
        _countryAllowedSet[token][country] = true;
        emit CountrySet(token, country, allowed);
    }

    function setMaxHoldersPerCountry(address token, uint16 country, uint256 max)
        external
        onlyPlatform
    {
        maxHoldersPerCountry[token][country] = max;
        emit MaxHoldersPerCountrySet(token, country, max);
    }

    function setMaxBalancePerHolder(address token, uint256 max) external onlyPlatform {
        maxBalancePerHolder[token] = max;
        emit MaxBalancePerHolderSet(token, max);
    }

    function setMinTransferAmount(address token, uint256 min) external onlyPlatform {
        minTransferAmount[token] = min;
        emit MinTransferAmountSet(token, min);
    }

    // =====================================================================
    // Intermediaries
    // =====================================================================

    function registerIntermediary(address intermediary, bool globalApproval, bytes32 entityId)
        external
        onlyPlatform
    {
        if (intermediary == address(0)) revert InvalidIntermediary();
        intermediaries[intermediary] =
            Intermediary({active: true, globalApproval: globalApproval, entityId: entityId});
        emit IntermediaryRegistered(intermediary, globalApproval, entityId);
    }

    function deactivateIntermediary(address intermediary) external onlyPlatform {
        intermediaries[intermediary].active = false;
        emit IntermediaryDeactivated(intermediary);
    }

    function setIntermediaryTokenApproval(address intermediary, address token, bool approved)
        external
        onlyPlatform
    {
        require(intermediaries[intermediary].active, "intermediary inactive");
        intermediaryTokenApproval[intermediary][token] = approved;
        emit IntermediaryTokenApprovalChanged(intermediary, token, approved);
    }

    // =====================================================================
    // Lookups
    // =====================================================================

    function countryAllowed(address token, uint16 country) public view returns (bool) {
        if (_countryAllowedSet[token][country]) return _countryAllowed[token][country];
        return defaultCountryAllowed[country];
    }

    function totalInvestorCount(address token) external view override returns (uint256) {
        return _totalInvestorCount[token];
    }

    function holderCountByCountry(address token, uint16 country)
        external
        view
        override
        returns (uint256)
    {
        return _holderCountByCountry[token][country];
    }

    /// @dev True if `holder` is approved either directly or via an intermediary.
    function _isHolderApproved(address token, address holder) internal view returns (bool) {
        if (spvApproved[token][holder]) return true;
        Intermediary memory i = intermediaries[holder];
        if (i.active && (i.globalApproval || intermediaryTokenApproval[holder][token])) return true;
        return false;
    }

    // =====================================================================
    // ERC-3643 hooks
    // =====================================================================

    function canTransfer(address from, address to, uint256 amount, address token)
        external
        view
        override
        returns (bool)
    {
        (uint256 code,) = preTransferCheck(from, to, amount, token);
        return code == 0;
    }

    function preTransferCheck(address from, address to, uint256 amount, address token)
        public
        view
        override
        returns (uint256 code, string memory reason)
    {
        // Both endpoints must be SPV-approved.
        if (!_isHolderApproved(token, from)) return (10, "sender not SPV-approved");
        if (!_isHolderApproved(token, to)) return (11, "recipient not SPV-approved");

        uint16 toCountry = identityRegistry.investorCountry(to);
        if (!countryAllowed(token, toCountry)) return (12, "country not allowed");

        uint256 minTx = minTransferAmount[token];
        if (minTx > 0 && amount < minTx) return (13, "below min transfer");

        // Concentration cap.
        uint256 maxBalance = maxBalancePerHolder[token];
        if (maxBalance > 0) {
            // Defensive: balance() is checked from the token contract on
            // the caller side. Here we only validate the would-be new total.
            // The token contract calls this *before* moving funds, so the
            // recipient's current balance is still pre-move.
            try IERC20Read(token).balanceOf(to) returns (uint256 currentBal) {
                if (currentBal + amount > maxBalance) return (14, "exceeds max balance");
            } catch {/* ignore — non-standard token */}
        }

        // Holder cap per country: only enforce when recipient is a new holder.
        address toIdentity = identityRegistry.identity(to);
        if (toIdentity != address(0) && !identityCounted[token][toIdentity]) {
            uint256 cap = maxHoldersPerCountry[token][toCountry];
            if (cap > 0 && _holderCountByCountry[token][toCountry] + 1 > cap) {
                return (15, "country holder cap");
            }
        }

        return (0, "ok");
    }

    function transferred(address from, address to, uint256 amount)
        external
        override
        onlyRegisteredToken
    {
        amount; // silence
        _updateCounts(msg.sender, from, to);
    }

    function created(address to, uint256 amount) external override onlyRegisteredToken {
        amount;
        _updateCounts(msg.sender, address(0), to);
    }

    function destroyed(address from, uint256 amount) external override onlyRegisteredToken {
        amount;
        _updateCounts(msg.sender, from, address(0));
    }

    /// @dev Investor counts must be maintained at the ONCHAINID level. We
    ///      look up the ONCHAINID for `from` and `to`, then increment /
    ///      decrement only when their *total* balance across linked wallets
    ///      crosses zero. Because the token contract has already updated
    ///      its ERC-20 balances when this is called, we can ask it directly.
    function _updateCounts(address token, address from, address to) internal {
        if (from != address(0)) {
            address fromId = identityRegistry.identity(from);
            if (fromId != address(0) && identityCounted[token][fromId]) {
                // If the identity no longer holds any tokens (across all wallets),
                // decrement counters. We approximate by checking the single wallet
                // since multi-wallet aggregation requires the token to expose
                // `balanceOfInvestor`; do that opportunistically.
                bool stillHolds;
                try IEnclavesBalanceOf(token).balanceOfInvestor(fromId) returns (uint256 b) {
                    stillHolds = b > 0;
                } catch {
                    try IERC20Read(token).balanceOf(from) returns (uint256 b) {
                        stillHolds = b > 0;
                    } catch {
                        stillHolds = true;
                    }
                }
                if (!stillHolds) {
                    identityCounted[token][fromId] = false;
                    uint16 fromCountry = identityRegistry.investorCountry(from);
                    if (_holderCountByCountry[token][fromCountry] > 0) {
                        _holderCountByCountry[token][fromCountry] -= 1;
                    }
                    if (_totalInvestorCount[token] > 0) _totalInvestorCount[token] -= 1;
                }
            }
        }
        if (to != address(0)) {
            address toId = identityRegistry.identity(to);
            if (toId != address(0) && !identityCounted[token][toId]) {
                identityCounted[token][toId] = true;
                uint16 toCountry = identityRegistry.investorCountry(to);
                _holderCountByCountry[token][toCountry] += 1;
                _totalInvestorCount[token] += 1;
            }
        }
    }
}

/// @dev Minimal callback interface so the compliance module can ask the
///      token for its current balance / investor balance without forcing
///      a hard dependency on the EnclavesRWA contract.
interface IERC20Read {
    function balanceOf(address account) external view returns (uint256);
}

interface IEnclavesBalanceOf {
    function balanceOfInvestor(address identityContract) external view returns (uint256);
}
