// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.17;

import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {ERC20SnapshotUpgradeable} from
    "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20SnapshotUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from
    "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {EnumerableSetUpgradeable} from
    "@openzeppelin/contracts-upgradeable/utils/structs/EnumerableSetUpgradeable.sol";
import {IERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import {SafeERC20Upgradeable} from
    "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";

import {IEnclavesRWA} from "./interfaces/IEnclavesRWA.sol";
import {IEnclavesCompliance} from "./interfaces/IEnclavesCompliance.sol";
import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";
import {IStakingBond} from "./interfaces/IStakingBond.sol";

/**
 * @title EnclavesRWA
 * @notice Abstract base contract for every ENCLAVES real-world-asset token.
 *         Layered on top of ERC-20 + ERC-3643 semantics (compliance-checked
 *         transfers, identity-registry verification, agent management).
 *
 *         The on-chain contract is the *enforcement* layer for a trusted
 *         platform. The platform decides; this contract records and enforces:
 *
 *           - token custody (ERC-20 / ERC-3643 transfers)
 *           - transfer enforcement (Identity Registry + Compliance)
 *           - supply immutability (`maxSupply` set once, `mintFinalized` one-way)
 *           - staking locks (consults {IStakingBond} on every mint)
 *           - lifecycle state machine (Registered → … → Retired)
 *           - holder & investor tracking (per-wallet + per-ONCHAINID)
 *           - TVL inputs (assetValuation + denominationCurrency + timestamp)
 *           - snapshot capability for yield distribution
 *           - optional maturity / buyback terms
 *
 * @dev    Designed to be deployed via {EnclavesTokenFactory} as an EIP-1167
 *         minimal proxy clone. Therefore the contract uses an initializer
 *         pattern (no constructor logic) and the constructor disables
 *         further initialization of the implementation.
 */
abstract contract EnclavesRWA is
    Initializable,
    ERC20SnapshotUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    IEnclavesRWA
{
    using EnumerableSetUpgradeable for EnumerableSetUpgradeable.AddressSet;
    using SafeERC20Upgradeable for IERC20Upgradeable;

    // =====================================================================
    // Errors
    // =====================================================================

    error NotPlatform();
    error NotSPV();
    error NotIssuer();
    error InvalidState(AssetState expected, AssetState actual);
    error CoolingNotElapsed(uint64 readyAt);
    error MintNotReady();
    error MintFinalized();
    error MaxSupplyExceeded();
    error AlreadyFinalized();
    error InvalidAddress();
    error InvalidAmount();
    error TransferRejected(uint256 code, string reason);
    error LockupActive(uint64 unlockAt);
    error NotMatured();
    error InsufficientEscrow();
    error MaturityTermsLocked();
    error MinimumRaiseNotMet();

    // =====================================================================
    // Roles
    // =====================================================================

    /// @notice The issuer / contract owner (ERC-173). Cannot mint.
    address public override issuer;

    /// @notice Platform backend (T-REX Agent equivalent — "onlyPlatform").
    address public platformAgent;

    /// @notice Active SPV operator. Mutable through governed process.
    address public override spvOperator;

    // =====================================================================
    // Asset identity (immutable after initialization)
    // =====================================================================

    bytes32 public override enclaveId;
    bytes32 public override jurisdiction;
    uint8 public override trustClass;
    /// @notice On-chain dispatch key — the bytes32 key the factory used to
    ///         resolve this token's implementation. Mirrors the platform's
    ///         `contractKind` field (see packages/kits/chain-kit/src/taxonomy.ts).
    ///         Renamed from `assetCategory` when the platform split UX
    ///         classification from on-chain dispatch.
    bytes32 public override contractKind;
    bytes32 public override spvEntityId;
    bytes32 public override spvJurisdiction;
    bytes32 public override spvLegalStructure;
    bytes32 public override spvRegistryId;

    // Updatable metadata pointer (IPFS / Arweave CID).
    string public override metadataURI;

    // =====================================================================
    // Supply control
    // =====================================================================

    uint256 public override maxSupply;
    uint256 public override totalIssued;
    bool public override mintFinalized;
    uint64 public coolingPeriod;

    // =====================================================================
    // Compliance & identity wiring
    // =====================================================================

    IIdentityRegistry public identityRegistry;
    IEnclavesCompliance public compliance;
    IStakingBond public stakingBond;

    // =====================================================================
    // Lifecycle state machine
    // =====================================================================

    AssetState public override assetState;

    /// @dev Timestamp when {assetState} became MintReady. mint() may only
    ///      execute after `mintReadyAt + coolingPeriod`.
    uint64 public mintReadyAt;

    // =====================================================================
    // Mint authorization conditions
    // =====================================================================

    struct MintConditions {
        bool verificationComplete;
        bool spvActive;
        bool noEncumbrances;
        bool documentGatingSatisfied;
        bool spvMintApproved;
    }

    MintConditions public mintConditions;

    // =====================================================================
    // Operational status flags (informational only)
    // =====================================================================

    struct OperationalStatus {
        bool underAudit;
        bool materialEventPending;
        bool disputeRaised;
        bool reVerificationPending;
        bool documentRenewalPending;
        bool complianceReview;
        uint64 lastStatusUpdate;
    }

    OperationalStatus internal _operationalStatus;

    // =====================================================================
    // Valuation reference (drives on-chain TVL)
    // =====================================================================

    uint256 public override assetValuation;
    bytes32 public override denominationCurrency;
    uint64 public override valuationTimestamp;
    bytes32 public override valuationMethodology;

    // =====================================================================
    // Issuance rounds (per ONCHAINID identity)
    // =====================================================================

    struct IssuanceRound {
        uint256 amount;
        uint64 timestamp;
        uint64 lockupEnd;
    }

    mapping(address => IssuanceRound[]) internal _issuanceRounds;

    // =====================================================================
    // Holder tracking
    // =====================================================================

    EnumerableSetUpgradeable.AddressSet internal _holders;

    // =====================================================================
    // Maturity / buyback (optional — only relevant for time-bounded assets)
    // =====================================================================

    uint64 public maturityDate;
    uint256 public buybackPricePerToken;
    address public buybackToken;
    bool public matured;
    bool internal _maturityTermsLocked;

    /// @notice Per-token escrow that funds the buyback price at maturity.
    address public redemptionEscrow;

    // =====================================================================
    // Frozen addresses (T-REX equivalent — managed by platform)
    // =====================================================================

    mapping(address => bool) public isFrozen;

    /// @dev Re-entrancy-safe flag that lets `seize()` bypass the
    ///      `preTransferCheck` gate inside `_beforeTokenTransfer`. Mirrors
    ///      T-REX's `forcedTransfer` semantics: the platform can rebalance
    ///      tokens regardless of pause, freeze and lockup state.
    bool internal _forcedTransfer;

    // =====================================================================
    // Events
    // =====================================================================

    event AssetStateChanged(AssetState indexed prev, AssetState indexed next);
    event MintConditionSet(string condition, bool value);
    event SupplyFinalized(uint256 totalIssued);
    event SPVOperatorChanged(address indexed prev, address indexed next);
    event PlatformAgentChanged(address indexed prev, address indexed next);
    event OperationalFlagChanged(string flag, bool value, uint64 timestamp);
    event Seized(address indexed from, address indexed to, uint256 amount, string reason);
    event IssuanceRoundRecorded(address indexed identity, uint256 amount, uint64 lockupEnd);
    event MetadataURIUpdated(string newURI);
    event HolderAdded(address indexed holder);
    event HolderRemoved(address indexed holder);
    event ValuationUpdated(
        uint256 previousValue, uint256 newValue, bytes32 methodology, uint64 timestamp
    );
    event AddressFrozen(address indexed account, bool frozen);
    event AssetMatured(uint64 maturityDate);
    event TokensRedeemed(address indexed holder, uint256 tokenAmount, uint256 payoutAmount);
    event RedemptionEscrowSet(address indexed escrow);
    event MaturityTermsSet(uint64 maturityDate, uint256 pricePerToken, address paymentToken);

    // =====================================================================
    // Modifiers
    // =====================================================================

    modifier onlyPlatform() {
        if (msg.sender != platformAgent) revert NotPlatform();
        _;
    }

    modifier onlySPV() {
        if (msg.sender != spvOperator) revert NotSPV();
        _;
    }

    modifier onlyIssuer() {
        if (msg.sender != issuer) revert NotIssuer();
        _;
    }

    modifier inState(AssetState expected) {
        if (assetState != expected) revert InvalidState(expected, assetState);
        _;
    }

    // =====================================================================
    // Initialization
    // =====================================================================

    struct InitParams {
        // identity
        address issuer;
        address platformAgent;
        address spvOperator;
        bytes32 enclaveId;
        bytes32 jurisdiction;
        uint8 trustClass;
        /// On-chain implementation dispatch key (formerly `assetCategory`).
        bytes32 contractKind;
        // SPV
        bytes32 spvEntityId;
        bytes32 spvJurisdiction;
        bytes32 spvLegalStructure;
        bytes32 spvRegistryId;
        // supply & valuation
        uint256 maxSupply;
        uint64 coolingPeriod;
        uint256 initialValuation;
        bytes32 denominationCurrency;
        bytes32 valuationMethodology;
        // ERC-20 metadata
        string name;
        string symbol;
        string metadataURI;
        // wiring
        address identityRegistry;
        address compliance;
        address stakingBond;
    }

    /**
     * @dev Initializer for the base contract. Concrete category extensions
     *      MUST call `__EnclavesRWA_init(...)` from their own initializer
     *      before doing any category-specific setup.
     */
    // solhint-disable-next-line func-name-mixedcase
    function __EnclavesRWA_init(InitParams calldata p) internal onlyInitializing {
        if (p.issuer == address(0)) revert InvalidAddress();
        if (p.platformAgent == address(0)) revert InvalidAddress();
        if (p.spvOperator == address(0)) revert InvalidAddress();
        if (p.identityRegistry == address(0)) revert InvalidAddress();
        if (p.compliance == address(0)) revert InvalidAddress();
        if (p.stakingBond == address(0)) revert InvalidAddress();
        if (p.maxSupply == 0) revert InvalidAmount();

        __ERC20_init(p.name, p.symbol);
        __ERC20Snapshot_init();
        __Pausable_init();
        __ReentrancyGuard_init();

        issuer = p.issuer;
        platformAgent = p.platformAgent;
        spvOperator = p.spvOperator;

        enclaveId = p.enclaveId;
        jurisdiction = p.jurisdiction;
        trustClass = p.trustClass;
        contractKind = p.contractKind;

        spvEntityId = p.spvEntityId;
        spvJurisdiction = p.spvJurisdiction;
        spvLegalStructure = p.spvLegalStructure;
        spvRegistryId = p.spvRegistryId;

        maxSupply = p.maxSupply;
        coolingPeriod = p.coolingPeriod;

        assetValuation = p.initialValuation;
        denominationCurrency = p.denominationCurrency;
        valuationMethodology = p.valuationMethodology;
        valuationTimestamp = uint64(block.timestamp);

        metadataURI = p.metadataURI;

        identityRegistry = IIdentityRegistry(p.identityRegistry);
        compliance = IEnclavesCompliance(p.compliance);
        stakingBond = IStakingBond(p.stakingBond);

        assetState = AssetState.Registered;
    }

    // =====================================================================
    // Lifecycle transitions
    // =====================================================================

    /**
     * @notice Platform flips an individual mint condition. When all flags are
     *         satisfied the state transitions to {AssetState.MintReady} and
     *         the cooling timer starts.
     */
    function setMintCondition(string calldata condition, bool value) external onlyPlatform {
        bytes32 key = keccak256(bytes(condition));
        if (key == keccak256("verificationComplete")) {
            mintConditions.verificationComplete = value;
        } else if (key == keccak256("spvActive")) {
            mintConditions.spvActive = value;
        } else if (key == keccak256("noEncumbrances")) {
            mintConditions.noEncumbrances = value;
        } else if (key == keccak256("documentGatingSatisfied")) {
            mintConditions.documentGatingSatisfied = value;
        } else {
            revert("unknown condition");
        }
        emit MintConditionSet(condition, value);
        _maybeStartCooling();
    }

    /// @notice SPV operator authorises minting. Required regardless of how
    ///         many platform conditions are satisfied.
    function approveMint() external onlySPV {
        mintConditions.spvMintApproved = true;
        emit MintConditionSet("spvMintApproved", true);
        _maybeStartCooling();
    }

    function revokeMintApproval() external onlySPV {
        mintConditions.spvMintApproved = false;
        emit MintConditionSet("spvMintApproved", false);
        if (assetState == AssetState.MintReady) {
            _transition(AssetState.Registered);
            mintReadyAt = 0;
        }
    }

    function _maybeStartCooling() private {
        if (
            assetState == AssetState.Registered && mintConditions.verificationComplete
                && mintConditions.spvActive && mintConditions.noEncumbrances
                && mintConditions.documentGatingSatisfied && mintConditions.spvMintApproved
        ) {
            mintReadyAt = uint64(block.timestamp);
            _transition(AssetState.MintReady);
        }
    }

    /// @notice True iff every mint condition flag is set AND the staking bond
    ///         is funded AND the cooling period has elapsed.
    function isMintReady() public view override returns (bool) {
        if (assetState != AssetState.MintReady) return false;
        if (block.timestamp < uint256(mintReadyAt) + coolingPeriod) return false;
        return stakingBond.isBonded(address(this));
    }

    function remainingSupply() public view override returns (uint256) {
        return maxSupply - totalIssued;
    }

    function _transition(AssetState next) internal {
        AssetState prev = assetState;
        assetState = next;
        emit AssetStateChanged(prev, next);
    }

    // =====================================================================
    // Minting (platform-driven, SPV-gated)
    // =====================================================================

    function mint(address to, uint256 amount) external onlyPlatform nonReentrant {
        _mintInternal(to, amount);
    }

    function batchMint(address[] calldata to, uint256[] calldata amounts)
        external
        onlyPlatform
        nonReentrant
    {
        require(to.length == amounts.length, "length mismatch");
        for (uint256 i = 0; i < to.length; ++i) {
            _mintInternal(to[i], amounts[i]);
        }
    }

    function _mintInternal(address to, uint256 amount) internal virtual {
        if (mintFinalized) revert MintFinalized();
        if (assetState != AssetState.MintReady) {
            revert InvalidState(AssetState.MintReady, assetState);
        }
        if (block.timestamp < uint256(mintReadyAt) + coolingPeriod) {
            revert CoolingNotElapsed(mintReadyAt + coolingPeriod);
        }
        if (!stakingBond.isBonded(address(this))) revert MintNotReady();
        if (amount == 0) revert InvalidAmount();
        if (totalIssued + amount > maxSupply) revert MaxSupplyExceeded();

        // Identity-registry verification — ERC-3643 invariant.
        require(identityRegistry.isVerified(to), "recipient not verified");

        totalIssued += amount;
        _mint(to, amount);
        compliance.created(to, amount);

        // Record issuance round under the recipient's ONCHAINID.
        address identityContract = identityRegistry.identity(to);
        uint64 lockupEnd = _lockupEndFor(amount);
        _issuanceRounds[identityContract].push(
            IssuanceRound({amount: amount, timestamp: uint64(block.timestamp), lockupEnd: lockupEnd})
        );
        emit IssuanceRoundRecorded(identityContract, amount, lockupEnd);

        if (totalIssued == maxSupply) {
            mintFinalized = true;
            _transition(AssetState.Active);
            emit SupplyFinalized(totalIssued);
        }
    }

    /**
     * @notice Override in category extensions to apply category-specific
     *         lockup logic. Default: no lockup.
     */
    function _lockupEndFor(uint256 /*amount*/ ) internal view virtual returns (uint64) {
        return uint64(block.timestamp);
    }

    // =====================================================================
    // SPV-driven lifecycle
    // =====================================================================

    function suspend() external onlySPV {
        if (assetState != AssetState.Active) revert InvalidState(AssetState.Active, assetState);
        _transition(AssetState.Suspended);
        _pause();
    }

    function resume() external onlySPV {
        if (assetState != AssetState.Suspended) {
            revert InvalidState(AssetState.Suspended, assetState);
        }
        _transition(AssetState.Active);
        _unpause();
    }

    function initiateRedemption() external onlySPV {
        if (assetState != AssetState.Active && assetState != AssetState.Suspended) {
            revert InvalidState(AssetState.Active, assetState);
        }
        _transition(AssetState.Redeeming);
        if (!paused()) _pause();
    }

    function retire() external onlySPV {
        if (assetState != AssetState.Redeeming) {
            revert InvalidState(AssetState.Redeeming, assetState);
        }
        _transition(AssetState.Retired);
    }

    /// @notice Holders may burn their tokens during redemption / retirement
    ///         (e.g. after off-chain settlement of redemption proceeds).
    function redeemBurn(uint256 amount) external {
        if (assetState != AssetState.Redeeming && assetState != AssetState.Retired) {
            revert InvalidState(AssetState.Redeeming, assetState);
        }
        _burn(msg.sender, amount);
        compliance.destroyed(msg.sender, amount);
    }

    // =====================================================================
    // Maturity & buyback
    // =====================================================================

    /// @notice One-shot configuration of maturity terms. Locked permanently
    ///         after the first mint to prevent retroactive parameter changes.
    function setMaturityTerms(uint64 date, uint256 pricePerToken, address paymentToken)
        external
        onlyPlatform
    {
        if (_maturityTermsLocked) revert MaturityTermsLocked();
        if (totalIssued > 0) revert MaturityTermsLocked();
        maturityDate = date;
        buybackPricePerToken = pricePerToken;
        buybackToken = paymentToken;
        _maturityTermsLocked = true;
        emit MaturityTermsSet(date, pricePerToken, paymentToken);
    }

    function setRedemptionEscrow(address escrow) external onlyPlatform {
        redemptionEscrow = escrow;
        emit RedemptionEscrowSet(escrow);
    }

    /// @notice Permissionless trigger once block.timestamp >= maturityDate.
    function triggerMaturity() external {
        require(maturityDate > 0, "no maturity");
        require(!matured, "already matured");
        require(block.timestamp >= maturityDate, "not yet");
        matured = true;
        emit AssetMatured(maturityDate);
    }

    /**
     * @notice Burn `tokenAmount` and receive the corresponding stablecoin
     *         payout from the redemption escrow.
     */
    function redeemAtMaturity(uint256 tokenAmount) external nonReentrant {
        if (!matured) revert NotMatured();
        if (tokenAmount == 0) revert InvalidAmount();
        require(redemptionEscrow != address(0), "no escrow");
        require(buybackPricePerToken > 0 && buybackToken != address(0), "no buyback");

        uint256 payout = tokenAmount * buybackPricePerToken / (10 ** decimals());
        IERC20Upgradeable token = IERC20Upgradeable(buybackToken);
        if (token.balanceOf(redemptionEscrow) < payout) revert InsufficientEscrow();

        _burn(msg.sender, tokenAmount);
        compliance.destroyed(msg.sender, tokenAmount);

        // Pull payout from the escrow. The escrow is an immutable
        // per-token contract whose constructor approves THIS contract
        // for `type(uint256).max` of `paymentToken`, and the function
        // is `nonReentrant`. Slither's `arbitrary-send-erc20` detector
        // flags any transferFrom whose `from` is not `msg.sender`; the
        // pre-authorised pull-payment pattern is exactly what this
        // detector exists to catch in untrusted contexts and exactly
        // what we intentionally do here.
        // slither-disable-next-line arbitrary-send-erc20
        token.safeTransferFrom(redemptionEscrow, msg.sender, payout);

        emit TokensRedeemed(msg.sender, tokenAmount, payout);
    }

    // =====================================================================
    // Operational status (informational)
    // =====================================================================

    function setOperationalFlag(string calldata flag, bool value) external onlyPlatform {
        bytes32 key = keccak256(bytes(flag));
        if (key == keccak256("underAudit")) {
            _operationalStatus.underAudit = value;
        } else if (key == keccak256("materialEventPending")) {
            _operationalStatus.materialEventPending = value;
        } else if (key == keccak256("disputeRaised")) {
            _operationalStatus.disputeRaised = value;
        } else if (key == keccak256("reVerificationPending")) {
            _operationalStatus.reVerificationPending = value;
        } else if (key == keccak256("documentRenewalPending")) {
            _operationalStatus.documentRenewalPending = value;
        } else if (key == keccak256("complianceReview")) {
            _operationalStatus.complianceReview = value;
        } else {
            revert("unknown flag");
        }
        _operationalStatus.lastStatusUpdate = uint64(block.timestamp);
        emit OperationalFlagChanged(flag, value, _operationalStatus.lastStatusUpdate);
    }

    function getOperationalStatus() external view returns (OperationalStatus memory) {
        return _operationalStatus;
    }

    // =====================================================================
    // Administration (mostly platform / issuer)
    // =====================================================================

    function setSPVOperator(address newOperator) external onlyIssuer {
        if (newOperator == address(0)) revert InvalidAddress();
        address prev = spvOperator;
        spvOperator = newOperator;
        emit SPVOperatorChanged(prev, newOperator);
    }

    function setPlatformAgent(address newAgent) external onlyIssuer {
        if (newAgent == address(0)) revert InvalidAddress();
        address prev = platformAgent;
        platformAgent = newAgent;
        emit PlatformAgentChanged(prev, newAgent);
    }

    function setMetadataURI(string calldata newURI) external onlyPlatform {
        metadataURI = newURI;
        emit MetadataURIUpdated(newURI);
    }

    function updateValuation(uint256 value, bytes32 methodology) external onlyPlatform {
        uint256 prev = assetValuation;
        assetValuation = value;
        valuationMethodology = methodology;
        valuationTimestamp = uint64(block.timestamp);
        emit ValuationUpdated(prev, value, methodology, valuationTimestamp);
    }

    function setAddressFrozen(address account, bool frozen) external onlyPlatform {
        isFrozen[account] = frozen;
        emit AddressFrozen(account, frozen);
    }

    /// @notice Platform-driven forced transfer with explicit reason. Builds on
    ///         the T-REX `forcedTransfer` primitive but adds a `reason` string
    ///         that is emitted for audit trails. Bypasses pause, freeze and
    ///         lockup checks — recipient must still be identity-verified so
    ///         we never create an unregistered holder.
    function seize(address from, address to, uint256 amount, string calldata reason)
        external
        onlyPlatform
    {
        if (to == address(0)) revert InvalidAddress();
        require(identityRegistry.isVerified(to), "recipient not verified");
        _forcedTransfer = true;
        _transfer(from, to, amount);
        _forcedTransfer = false;
        emit Seized(from, to, amount, reason);
    }

    // =====================================================================
    // Snapshot (platform-driven, for yield distribution)
    // =====================================================================

    function snapshot() external onlyPlatform returns (uint256) {
        return _snapshot();
    }

    // =====================================================================
    // Views — investor & holder queries
    // =====================================================================

    function holderCount() external view override returns (uint256) {
        return _holders.length();
    }

    function holderAt(uint256 index) external view override returns (address) {
        return _holders.at(index);
    }

    function isHolder(address account) external view override returns (bool) {
        return _holders.contains(account);
    }

    function getIssuanceRounds(address identityContract)
        external
        view
        returns (IssuanceRound[] memory)
    {
        return _issuanceRounds[identityContract];
    }

    function balanceOfInvestor(address identityContract) public view override returns (uint256) {
        // Sum balances of every wallet linked to this ONCHAINID by walking
        // the holder set. This is O(n) but the platform indexer is the main
        // consumer of large queries; on-chain queries can be paginated.
        uint256 sum;
        uint256 len = _holders.length();
        for (uint256 i = 0; i < len; ++i) {
            address wallet = _holders.at(i);
            if (identityRegistry.identity(wallet) == identityContract) {
                sum += balanceOf(wallet);
            }
        }
        return sum;
    }

    function investorCount() external view override returns (uint256) {
        return compliance.totalInvestorCount(address(this));
    }

    // =====================================================================
    // Transfer pre-checks
    // =====================================================================

    function canTransfer(address from, address to, uint256 amount)
        public
        view
        override
        returns (bool)
    {
        (uint256 code,) = preTransferCheck(from, to, amount);
        return code == 0;
    }

    function preTransferCheck(address from, address to, uint256 amount)
        public
        view
        override
        returns (uint256 code, string memory reason)
    {
        if (paused()) return (1, "token paused");
        if (!identityRegistry.isVerified(from)) return (2, "sender not verified");
        if (!identityRegistry.isVerified(to)) return (3, "recipient not verified");
        if (isFrozen[from]) return (7, "sender frozen");
        if (isFrozen[to]) return (8, "recipient frozen");
        if (balanceOf(from) < amount) return (5, "insufficient balance");
        uint64 unlockAt = _lockedUntil(from);
        if (unlockAt > block.timestamp) return (6, "lockup active");
        if (!compliance.canTransfer(from, to, amount, address(this))) {
            return (4, "compliance rejected");
        }
        return (0, "ok");
    }

    /**
     * @dev Latest lockup end across every issuance round linked to `from`'s
     *      ONCHAINID. Returns 0 if no rounds exist.
     */
    function _lockedUntil(address from) internal view returns (uint64) {
        address id = identityRegistry.identity(from);
        if (id == address(0)) return 0;
        IssuanceRound[] storage rounds = _issuanceRounds[id];
        uint64 latest;
        for (uint256 i = 0; i < rounds.length; ++i) {
            if (rounds[i].lockupEnd > latest) latest = rounds[i].lockupEnd;
        }
        return latest;
    }

    // =====================================================================
    // ERC-20 hooks — compliance + holder set + freeze + pause
    // =====================================================================

    function _beforeTokenTransfer(address from, address to, uint256 amount)
        internal
        virtual
        override(ERC20SnapshotUpgradeable)
    {
        super._beforeTokenTransfer(from, to, amount);

        // Mint (from == 0) and burn (to == 0) are validated in dedicated
        // functions and intentionally bypass the transfer gate. Holder-to-
        // holder transfers are gated by `preTransferCheck` which itself
        // returns code 1 when the token is paused — so `_pause()` continues
        // to halt regular transfers even though `whenNotPaused` is not
        // applied here. Platform-issued seizures set `_forcedTransfer` to
        // skip every check (mirrors T-REX `forcedTransfer`).
        if (from != address(0) && to != address(0) && !_forcedTransfer) {
            (uint256 code, string memory reason) = preTransferCheck(from, to, amount);
            if (code != 0) revert TransferRejected(code, reason);
        }
    }

    function _afterTokenTransfer(address from, address to, uint256 amount) internal virtual override {
        super._afterTokenTransfer(from, to, amount);

        if (from != address(0) && to != address(0)) {
            compliance.transferred(from, to, amount);
        }

        if (from != address(0) && balanceOf(from) == 0 && _holders.contains(from)) {
            _holders.remove(from);
            emit HolderRemoved(from);
        }
        if (to != address(0) && balanceOf(to) > 0 && !_holders.contains(to)) {
            _holders.add(to);
            emit HolderAdded(to);
        }
    }

    // =====================================================================
    // Storage gap reserved for future base-level fields without breaking
    // the storage layout of clones that have already been deployed.
    // =====================================================================

    uint256[40] private __gap;
}
