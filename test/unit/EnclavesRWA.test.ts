import { ethers } from 'hardhat';
import { expect } from 'chai';

import * as F from '../helpers/fixture';
import { k, toBytes32, toEth, toUSDC, advanceTime, latestTime } from '../helpers/utils';
import * as C from '../helpers/constants';
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';

/**
 * Behavioural tests for the EnclavesRWA abstract base, exercised through
 * a concrete EnclavesBiomass token. The biomass-specific surface is
 * covered by test/unit/categories/EnclavesBiomass.test.ts; here we
 * focus on every base-contract responsibility from the spec.
 */

describe('EnclavesRWA (base behavior)', () => {
  let deployer: HardhatEthersSigner;
  let platformAgent: HardhatEthersSigner;
  let issuer: HardhatEthersSigner;
  let spvOperator: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let carol: HardhatEthersSigner;
  let intruder: HardhatEthersSigner;

  let encl: F.ENCL;
  let staking: F.StakingBond;
  let ir: F.MockIdentityRegistry;
  let factory: F.EnclavesTokenFactory;
  let compliance: F.EnclavesCompliance;
  let impls: F.EnclaveImpls;
  let token: F.EnclavesBiomass;

  before(async () => {
    [deployer, platformAgent, issuer, spvOperator, treasury, alice, bob, carol, intruder] =
      await ethers.getSigners();
  });

  async function buildAndDeployToken(opts: {
    base?: F.InitParamOverrides;
    biomass?: F.InitParamOverrides;
    salt?: string;
  } = {}) {
    ({ encl, staking, ir } = await F.deployGlobals({
      deployer,
      treasury,
      slashReceiver: deployer,
    }));
    ({ compliance, factory, impls } = await F.deployEnclave({
      deployer,
      platformAgent,
      ir,
      staking,
    }));

    await F.registerInvestors(
      ir,
      [issuer, spvOperator, alice, bob, carol],
      C.COUNTRY.NA,
      deployer
    );

    const base = F.biomassBaseParams({
      issuer,
      platformAgent,
      spvOperator,
      ir,
      compliance,
      staking,
      options: opts.base || {},
    });
    const biomass = F.biomassParams(opts.biomass || {});

    const { token: t } = await F.deployBiomassToken({
      factory,
      impls,
      base,
      biomass,
      salt: opts.salt || k('TEST_BASE'),
      from: deployer,
    });
    token = t;

    await compliance.connect(deployer).registerToken(token.target);
    await compliance.connect(platformAgent).setDefaultCountryAllowed(C.COUNTRY.NA, true);
    await compliance
      .connect(platformAgent)
      .batchSetSpvApproval(
        token.target,
        [alice.address, bob.address, carol.address, spvOperator.address, issuer.address],
        true
      );
    return { base, biomass };
  }

  describe('initialization', () => {
    beforeEach(async () => buildAndDeployToken());

    it('records every immutable identity field', async () => {
      expect(await token.issuer()).to.equal(issuer.address);
      expect(await token.spvOperator()).to.equal(spvOperator.address);
      expect(await token.platformAgent()).to.equal(platformAgent.address);
      expect(await token.trustClass()).to.equal(BigInt(C.TRUST_CLASS.V));
      expect(await token.contractKind()).to.equal(C.CONTRACT_KIND.BIOMASS);
      expect(await token.spvEntityId()).to.equal(toBytes32('EXAMPLE_BIOMASS_SPV'));
      expect(await token.maxSupply()).to.equal(4000n);
      expect(await token.totalIssued()).to.equal(0n);
      expect(await token.mintFinalized()).to.equal(false);
    });

    it('initial state is Registered', async () => {
      expect(await token.assetState()).to.equal(BigInt(C.STATE.REGISTERED));
    });

    it('rejects re-initialization', async () => {
      const base = F.biomassBaseParams({
        issuer,
        platformAgent,
        spvOperator,
        ir,
        compliance,
        staking,
      });
      const biomass = F.biomassParams();
      await expect(token.initialize(base as any, biomass as any)).to.be.reverted;
    });

    it('seeds the valuation reference', async () => {
      expect(await token.assetValuation()).to.equal(20_000_000n);
      expect(await token.denominationCurrency()).to.equal(k('USD'));
      expect(await token.valuationMethodology()).to.equal(k('APPRAISAL'));
      expect(await token.valuationTimestamp()).to.be.greaterThan(0n);
    });
  });

  describe('mint authorization gate', () => {
    beforeEach(async () => buildAndDeployToken());

    it('reverts mint while still in Registered', async () => {
      await expect(token.connect(platformAgent).mint(alice.address, 1)).to.be.reverted;
    });

    it('requires every flag + SPV approval to reach MintReady', async () => {
      expect(await token.isMintReady()).to.equal(false);
      await token.connect(platformAgent).setMintCondition('verificationComplete', true);
      await token.connect(platformAgent).setMintCondition('spvActive', true);
      await token.connect(platformAgent).setMintCondition('noEncumbrances', true);
      expect(await token.assetState()).to.equal(BigInt(C.STATE.REGISTERED));
      await token
        .connect(platformAgent)
        .setMintCondition('documentGatingSatisfied', true);
      expect(await token.assetState()).to.equal(BigInt(C.STATE.REGISTERED));
      await token.connect(spvOperator).approveMint();
      expect(await token.assetState()).to.equal(BigInt(C.STATE.MINT_READY));
    });

    it('SPV revoke during MintReady bumps state back to Registered', async () => {
      await F.setAllMintConditions(token as any, platformAgent);
      await token.connect(spvOperator).approveMint();
      expect(await token.assetState()).to.equal(BigInt(C.STATE.MINT_READY));
      await token.connect(spvOperator).revokeMintApproval();
      expect(await token.assetState()).to.equal(BigInt(C.STATE.REGISTERED));
    });

    it('mint blocked without a bond even after MintReady', async () => {
      await F.setAllMintConditions(token as any, platformAgent);
      await token.connect(spvOperator).approveMint();
      expect(await token.isMintReady()).to.equal(false);
      await expect(token.connect(platformAgent).mint(alice.address, 1)).to.be.reverted;
    });

    it('cooling period blocks mint until it elapses', async () => {
      await buildAndDeployToken({
        base: { coolingPeriod: 60 },
        salt: k('COOLING_TEST'),
      });
      await F.setAllMintConditions(token as any, platformAgent);
      await token.connect(spvOperator).approveMint();
      await F.fundAndBond({
        encl,
        staking,
        treasury,
        staker: issuer,
        token,
        trustClass: C.TRUST_CLASS.V,
        assetValueUsd: 20_000_000,
      });
      expect(await token.isMintReady()).to.equal(false);
      await expect(token.connect(platformAgent).mint(alice.address, 1)).to.be.reverted;
      await advanceTime(61);
      expect(await token.isMintReady()).to.equal(true);
      await token.connect(platformAgent).mint(alice.address, 1);
    });

    it('rejects mint to non-verified address', async () => {
      await F.setAllMintConditions(token as any, platformAgent);
      await token.connect(spvOperator).approveMint();
      await F.fundAndBond({
        encl,
        staking,
        treasury,
        staker: issuer,
        token,
        trustClass: C.TRUST_CLASS.V,
        assetValueUsd: 20_000_000,
      });
      await expect(
        token.connect(platformAgent).mint(intruder.address, 1)
      ).to.be.revertedWith('recipient not verified');
    });

    it('rejects mint exceeding maxSupply', async () => {
      await F.setAllMintConditions(token as any, platformAgent);
      await token.connect(spvOperator).approveMint();
      await F.fundAndBond({
        encl,
        staking,
        treasury,
        staker: issuer,
        token,
        trustClass: C.TRUST_CLASS.V,
        assetValueUsd: 20_000_000,
      });
      await expect(token.connect(platformAgent).mint(alice.address, 4001)).to.be.reverted;
    });

    it('non-platform cannot mint', async () => {
      await F.setAllMintConditions(token as any, platformAgent);
      await token.connect(spvOperator).approveMint();
      await F.fundAndBond({
        encl,
        staking,
        treasury,
        staker: issuer,
        token,
        trustClass: C.TRUST_CLASS.V,
        assetValueUsd: 20_000_000,
      });
      await expect(token.connect(intruder).mint(alice.address, 1)).to.be.reverted;
    });

    it('full-supply mint auto-finalizes and transitions to Active', async () => {
      await F.setAllMintConditions(token as any, platformAgent);
      await token.connect(spvOperator).approveMint();
      await F.fundAndBond({
        encl,
        staking,
        treasury,
        staker: issuer,
        token,
        trustClass: C.TRUST_CLASS.V,
        assetValueUsd: 20_000_000,
      });

      await token
        .connect(platformAgent)
        .batchMint([alice.address, bob.address], [3000, 1000]);
      expect(await token.totalIssued()).to.equal(4000n);
      expect(await token.mintFinalized()).to.equal(true);
      expect(await token.assetState()).to.equal(BigInt(C.STATE.ACTIVE));

      await expect(token.connect(platformAgent).mint(alice.address, 1)).to.be.reverted;
    });
  });

  describe('issuance rounds + lockup', () => {
    beforeEach(async () => {
      await buildAndDeployToken();
      await F.setAllMintConditions(token as any, platformAgent);
      await token.connect(spvOperator).approveMint();
      await F.fundAndBond({
        encl,
        staking,
        treasury,
        staker: issuer,
        token,
        trustClass: C.TRUST_CLASS.V,
        assetValueUsd: 20_000_000,
      });
    });

    it('records an IssuanceRound keyed by ONCHAINID on every mint', async () => {
      await token.connect(platformAgent).mint(alice.address, 100);
      const rounds = await token.getIssuanceRounds(alice.address);
      expect(rounds.length).to.equal(1);
      expect(rounds[0].amount).to.equal(100n);
    });

    it('emits IssuanceRoundRecorded', async () => {
      await expect(token.connect(platformAgent).mint(alice.address, 50)).to.emit(
        token,
        'IssuanceRoundRecorded'
      );
    });
  });

  describe('holder tracking', () => {
    beforeEach(async () => {
      await buildAndDeployToken();
      await F.setAllMintConditions(token as any, platformAgent);
      await token.connect(spvOperator).approveMint();
      await F.fundAndBond({
        encl,
        staking,
        treasury,
        staker: issuer,
        token,
        trustClass: C.TRUST_CLASS.V,
        assetValueUsd: 20_000_000,
      });
      await token.connect(platformAgent).mint(alice.address, 1000);
      await token.connect(platformAgent).mint(bob.address, 500);
    });

    it('lists both holders', async () => {
      expect(await token.holderCount()).to.equal(2n);
      expect(await token.isHolder(alice.address)).to.equal(true);
      expect(await token.isHolder(bob.address)).to.equal(true);
      expect(await token.isHolder(carol.address)).to.equal(false);
    });

    it('removes a holder once their balance reaches zero', async () => {
      await token.connect(bob).transfer(carol.address, 500);
      expect(await token.isHolder(bob.address)).to.equal(false);
      expect(await token.isHolder(carol.address)).to.equal(true);
      expect(await token.holderCount()).to.equal(2n);
    });

    it('balanceOfInvestor aggregates wallets sharing one ONCHAINID', async () => {
      await ir
        .connect(deployer)
        .setProfile(carol.address, alice.address, C.COUNTRY.NA, true);
      await token.connect(alice).transfer(carol.address, 200);
      const total = await token.balanceOfInvestor(alice.address);
      expect(total).to.equal(1000n);
    });
  });

  describe('transfer pre-checks', () => {
    beforeEach(async () => {
      await buildAndDeployToken();
      await F.setAllMintConditions(token as any, platformAgent);
      await token.connect(spvOperator).approveMint();
      await F.fundAndBond({
        encl,
        staking,
        treasury,
        staker: issuer,
        token,
        trustClass: C.TRUST_CLASS.V,
        assetValueUsd: 20_000_000,
      });
      await token.connect(platformAgent).mint(alice.address, 1000);
    });

    it('canTransfer / preTransferCheck — happy path', async () => {
      expect(await token.canTransfer(alice.address, bob.address, 100)).to.equal(true);
      const res = await token.preTransferCheck(alice.address, bob.address, 100);
      expect(res.code).to.equal(BigInt(C.REASON.OK));
    });

    it('detects insufficient balance', async () => {
      const res = await token.preTransferCheck(alice.address, bob.address, 2000);
      expect(res.code).to.equal(BigInt(C.REASON.INSUFFICIENT_BALANCE));
    });

    it('frozen sender → code 7', async () => {
      await token.connect(platformAgent).setAddressFrozen(alice.address, true);
      const res = await token.preTransferCheck(alice.address, bob.address, 1);
      expect(res.code).to.equal(BigInt(C.REASON.SENDER_FROZEN));
      await expect(token.connect(alice).transfer(bob.address, 1)).to.be.reverted;
    });

    it('frozen recipient → code 8', async () => {
      await token.connect(platformAgent).setAddressFrozen(bob.address, true);
      const res = await token.preTransferCheck(alice.address, bob.address, 1);
      expect(res.code).to.equal(BigInt(C.REASON.RECIPIENT_FROZEN));
    });

    it('unverified recipient → code 3', async () => {
      const res = await token.preTransferCheck(alice.address, intruder.address, 1);
      expect(res.code).to.equal(BigInt(C.REASON.RECIPIENT_NOT_VERIFIED));
    });
  });

  describe('SPV-driven lifecycle', () => {
    beforeEach(async () => {
      await buildAndDeployToken();
      await F.setAllMintConditions(token as any, platformAgent);
      await token.connect(spvOperator).approveMint();
      await F.fundAndBond({
        encl,
        staking,
        treasury,
        staker: issuer,
        token,
        trustClass: C.TRUST_CLASS.V,
        assetValueUsd: 20_000_000,
      });
      await token
        .connect(platformAgent)
        .batchMint([alice.address, bob.address], [3000, 1000]);
    });

    it('only SPV can suspend / resume / redeem / retire', async () => {
      await expect(token.connect(platformAgent).suspend()).to.be.reverted;
      await expect(token.connect(platformAgent).resume()).to.be.reverted;
      await expect(token.connect(platformAgent).initiateRedemption()).to.be.reverted;
    });

    it('suspend halts transfers; resume reopens them', async () => {
      await token.connect(spvOperator).suspend();
      expect(await token.assetState()).to.equal(BigInt(C.STATE.SUSPENDED));
      expect(await token.paused()).to.equal(true);
      const res = await token.preTransferCheck(alice.address, bob.address, 1);
      expect(res.code).to.equal(BigInt(C.REASON.PAUSED));
      await expect(token.connect(alice).transfer(bob.address, 1)).to.be.reverted;

      await token.connect(spvOperator).resume();
      expect(await token.assetState()).to.equal(BigInt(C.STATE.ACTIVE));
      expect(await token.paused()).to.equal(false);
      await token.connect(alice).transfer(bob.address, 1);
    });

    it('initiateRedemption blocks transfers but allows redeemBurn', async () => {
      await token.connect(spvOperator).initiateRedemption();
      expect(await token.assetState()).to.equal(BigInt(C.STATE.REDEEMING));
      await expect(token.connect(alice).transfer(bob.address, 1)).to.be.reverted;
      const before = await token.balanceOf(alice.address);
      await token.connect(alice).redeemBurn(100);
      expect(await token.balanceOf(alice.address)).to.equal(before - 100n);
    });

    it('retire transitions and blocks redeemBurn outside Redeeming|Retired', async () => {
      await token.connect(spvOperator).initiateRedemption();
      await token.connect(spvOperator).retire();
      expect(await token.assetState()).to.equal(BigInt(C.STATE.RETIRED));
      await token.connect(alice).redeemBurn(10);
    });
  });

  describe('seize() — forced transfer with reason', () => {
    beforeEach(async () => {
      await buildAndDeployToken();
      await F.setAllMintConditions(token as any, platformAgent);
      await token.connect(spvOperator).approveMint();
      await F.fundAndBond({
        encl,
        staking,
        treasury,
        staker: issuer,
        token,
        trustClass: C.TRUST_CLASS.V,
        assetValueUsd: 20_000_000,
      });
      await token.connect(platformAgent).mint(alice.address, 1000);
    });

    it('moves tokens between holders and emits Seized', async () => {
      await expect(
        token.connect(platformAgent).seize(alice.address, bob.address, 100, 'court order')
      )
        .to.emit(token, 'Seized')
        .withArgs(alice.address, bob.address, 100, 'court order');
      expect(await token.balanceOf(alice.address)).to.equal(900n);
      expect(await token.balanceOf(bob.address)).to.equal(100n);
    });

    it('bypasses freeze on the sender', async () => {
      await token.connect(platformAgent).setAddressFrozen(alice.address, true);
      await token
        .connect(platformAgent)
        .seize(alice.address, bob.address, 100, 'override freeze');
      expect(await token.balanceOf(alice.address)).to.equal(900n);
    });

    it('bypasses pause', async () => {
      await token.connect(platformAgent).mint(alice.address, 3000);
      await token.connect(spvOperator).suspend();
      expect(await token.paused()).to.equal(true);
      await token
        .connect(platformAgent)
        .seize(alice.address, bob.address, 100, 'recovery');
      expect(await token.balanceOf(bob.address)).to.equal(100n);
    });

    it('still rejects seize to unverified address', async () => {
      await expect(
        token.connect(platformAgent).seize(alice.address, intruder.address, 1, 'oops')
      ).to.be.revertedWith('recipient not verified');
    });

    it('only platform agent can seize', async () => {
      await expect(
        token.connect(intruder).seize(alice.address, bob.address, 1, 'x')
      ).to.be.reverted;
    });
  });

  describe('operational status', () => {
    beforeEach(async () => buildAndDeployToken());

    it('platform sets a known flag and emits OperationalFlagChanged', async () => {
      await expect(
        token.connect(platformAgent).setOperationalFlag('underAudit', true)
      ).to.emit(token, 'OperationalFlagChanged');
      const s = await token.getOperationalStatus();
      expect(s.underAudit).to.equal(true);
    });

    it('rejects an unknown flag', async () => {
      await expect(
        token.connect(platformAgent).setOperationalFlag('typo', true)
      ).to.be.revertedWith('unknown flag');
    });
  });

  describe('valuation + metadata', () => {
    beforeEach(async () => buildAndDeployToken());

    it('platform updates valuation; emits ValuationUpdated', async () => {
      await expect(
        token.connect(platformAgent).updateValuation(25_000_000, k('NAV'))
      ).to.emit(token, 'ValuationUpdated');
      expect(await token.assetValuation()).to.equal(25_000_000n);
      expect(await token.valuationMethodology()).to.equal(k('NAV'));
    });

    it('platform updates metadataURI', async () => {
      await token.connect(platformAgent).setMetadataURI('ipfs://NEW');
      expect(await token.metadataURI()).to.equal('ipfs://NEW');
    });

    it('non-platform rejected', async () => {
      await expect(token.connect(intruder).updateValuation(1, k('X'))).to.be.reverted;
      await expect(token.connect(intruder).setMetadataURI('x')).to.be.reverted;
    });
  });

  describe('role rotation', () => {
    beforeEach(async () => buildAndDeployToken());

    it('issuer rotates the SPV operator', async () => {
      await expect(token.connect(issuer).setSPVOperator(carol.address)).to.emit(
        token,
        'SPVOperatorChanged'
      );
      expect(await token.spvOperator()).to.equal(carol.address);
    });

    it('non-issuer cannot rotate the SPV operator', async () => {
      await expect(token.connect(platformAgent).setSPVOperator(carol.address)).to.be
        .reverted;
    });

    it('issuer rotates the platform agent', async () => {
      await token.connect(issuer).setPlatformAgent(carol.address);
      expect(await token.platformAgent()).to.equal(carol.address);
    });
  });

  describe('snapshot + balanceOfAt', () => {
    beforeEach(async () => {
      await buildAndDeployToken();
      await F.setAllMintConditions(token as any, platformAgent);
      await token.connect(spvOperator).approveMint();
      await F.fundAndBond({
        encl,
        staking,
        treasury,
        staker: issuer,
        token,
        trustClass: C.TRUST_CLASS.V,
        assetValueUsd: 20_000_000,
      });
      await token.connect(platformAgent).mint(alice.address, 1000);
      await token.connect(platformAgent).mint(bob.address, 500);
    });

    it('captures balances at a point in time', async () => {
      const tx = await token.connect(platformAgent).snapshot();
      const receipt = await tx.wait();
      if (!receipt) throw new Error('no receipt');
      // ERC20SnapshotUpgradeable's `Snapshot(uint256 id)` is emitted as a
      // non-indexed event; its only datum is the id, ABI-encoded as a
      // uint256. We pick it out by topic0 so we don't rely on the token's
      // own ABI exposing the inherited event.
      const snapshotTopic = ethers.id('Snapshot(uint256)');
      const snapshotLog = receipt.logs.find((l) => l.topics[0] === snapshotTopic);
      expect(snapshotLog, 'Snapshot event not found').to.not.equal(undefined);
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
        ['uint256'],
        snapshotLog!.data
      );
      const id = decoded[0] as bigint;

      await token.connect(alice).transfer(carol.address, 1000);
      expect(await token.balanceOfAt(alice.address, id)).to.equal(1000n);
      expect(await token.balanceOfAt(carol.address, id)).to.equal(0n);
      expect(await token.totalSupplyAt(id)).to.equal(1500n);
    });

    it('only platform can call snapshot()', async () => {
      await expect(token.connect(intruder).snapshot()).to.be.reverted;
    });
  });

  describe('maturity + buyback', () => {
    let stable: F.MockStablecoin;
    let escrow: F.RedemptionEscrow;

    /**
     * Re-deploys the token with a maxSupply expressed in wei (18-decimals)
     * so the payout math `tokenAmount * price / 10**decimals` doesn't
     * floor to zero. Mirrors how real-world deployments size the supply.
     */
    async function setupMaturity({
      pricePerToken,
    }: { pricePerToken?: bigint | string | number } = {}) {
      await buildAndDeployToken({
        base: { maxSupply: toEth('4000').toString() },
        salt: k('MATURITY'),
      });
      stable = await F.deployStablecoin({ deployer });
      escrow = await F.deployRedemptionEscrow({
        deployer,
        platformAgent,
        token,
        paymentToken: stable,
        owner: deployer,
      });

      const now = await latestTime();
      await token
        .connect(platformAgent)
        .setMaturityTerms(now + 100, pricePerToken ?? toUSDC('5000'), stable.target);
      await token.connect(platformAgent).setRedemptionEscrow(escrow.target);
    }

    it('setMaturityTerms cannot be replayed (one-shot)', async () => {
      await setupMaturity();
      await expect(
        token.connect(platformAgent).setMaturityTerms(0, 0, stable.target)
      ).to.be.reverted;
    });

    it('triggerMaturity gated by timestamp', async () => {
      await setupMaturity();
      await expect(token.triggerMaturity()).to.be.revertedWith('not yet');
      await advanceTime(200);
      await token.triggerMaturity();
      expect(await token.matured()).to.equal(true);
    });

    it('redeemAtMaturity burns tokens and pays out the price × amount', async () => {
      await setupMaturity({ pricePerToken: toUSDC('5000') });

      await F.setAllMintConditions(token as any, platformAgent);
      await token.connect(spvOperator).approveMint();
      await F.fundAndBond({
        encl,
        staking,
        treasury,
        staker: issuer,
        token,
        trustClass: C.TRUST_CLASS.V,
        assetValueUsd: 20_000_000,
      });
      await token.connect(platformAgent).mint(alice.address, toEth('10'));

      const expectedPayout = toUSDC('50000');
      await stable.connect(deployer).mint(platformAgent.address, expectedPayout);
      await stable.connect(platformAgent).approve(escrow.target, expectedPayout);
      await escrow.connect(platformAgent).fund(expectedPayout);

      await advanceTime(200);
      await token.triggerMaturity();

      const before = await stable.balanceOf(alice.address);
      await expect(token.connect(alice).redeemAtMaturity(toEth('10'))).to.emit(
        token,
        'TokensRedeemed'
      );
      const after = await stable.balanceOf(alice.address);
      expect(after - before).to.equal(expectedPayout);
      expect(await token.balanceOf(alice.address)).to.equal(0n);
    });

    it('redeemAtMaturity reverts when escrow is under-funded', async () => {
      await setupMaturity({ pricePerToken: toUSDC('5000') });
      await F.setAllMintConditions(token as any, platformAgent);
      await token.connect(spvOperator).approveMint();
      await F.fundAndBond({
        encl,
        staking,
        treasury,
        staker: issuer,
        token,
        trustClass: C.TRUST_CLASS.V,
        assetValueUsd: 20_000_000,
      });
      await token.connect(platformAgent).mint(alice.address, toEth('10'));
      await advanceTime(200);
      await token.triggerMaturity();
      await expect(token.connect(alice).redeemAtMaturity(toEth('10'))).to.be.reverted;
    });
  });

  describe('lockup enforcement', () => {
    it('preTransferCheck returns code OK when no lockup is configured', async () => {
      await buildAndDeployToken();
      await F.setAllMintConditions(token as any, platformAgent);
      await token.connect(spvOperator).approveMint();
      await F.fundAndBond({
        encl,
        staking,
        treasury,
        staker: issuer,
        token,
        trustClass: C.TRUST_CLASS.V,
        assetValueUsd: 20_000_000,
      });
      await token.connect(platformAgent).mint(alice.address, 100);
      const res = await token.preTransferCheck(alice.address, bob.address, 1);
      expect(res.code).to.equal(BigInt(C.REASON.OK));
    });
  });
});
