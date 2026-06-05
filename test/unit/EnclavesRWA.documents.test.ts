import { ethers } from 'hardhat';
import { expect } from 'chai';

import * as F from '../helpers/fixture';
import { k, toBytes32 } from '../helpers/utils';
import * as C from '../helpers/constants';
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';

/**
 * Coverage for the on-chain per-document metadata registry on the
 * EnclavesRWA base, exercised through a concrete EnclavesBiomass token.
 */

type DocInput = {
  sha256Hash: string;
  uri: string;
  filename: string;
  docKind: string;
  isPublic: boolean;
  addedAt: bigint | number;
};

describe('EnclavesRWA (asset documents)', () => {
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

  function doc(overrides: Partial<DocInput> = {}): DocInput {
    return {
      sha256Hash: ethers.keccak256(ethers.toUtf8Bytes('file-bytes')),
      uri: 'ipfs://Qm-default',
      filename: 'deed.pdf',
      docKind: toBytes32('title_deed'),
      isPublic: true,
      // Deliberately bogus — the contract overwrites this with block.timestamp.
      addedAt: 1,
      ...overrides,
    };
  }

  async function buildAndDeployToken() {
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
    });
    const biomass = F.biomassParams();

    const { token: t } = await F.deployBiomassToken({
      factory,
      impls,
      base,
      biomass,
      salt: k('DOCS_TEST'),
      from: deployer,
    });
    token = t;
  }

  beforeEach(async () => buildAndDeployToken());

  describe('addDocument', () => {
    it('appends, returns the index, and emits DocumentAdded', async () => {
      const d = doc({ docKind: toBytes32('title_deed'), isPublic: true });

      // First the static call confirms the returned index, then we send the tx.
      const idx = await token.connect(platformAgent).addDocument.staticCall(d);
      expect(idx).to.equal(0n);

      await expect(token.connect(platformAgent).addDocument(d))
        .to.emit(token, 'DocumentAdded')
        .withArgs(0n, d.sha256Hash, d.docKind, d.isPublic);

      expect(await token.documentCount()).to.equal(1n);
    });

    it('increments documentCount and reads fields back via documentAt / documents', async () => {
      const d = doc({
        sha256Hash: ethers.keccak256(ethers.toUtf8Bytes('the-real-bytes')),
        uri: 'ipfs://QmABC',
        filename: 'sales.pdf',
        docKind: toBytes32('sales_collateral'),
        isPublic: false,
        addedAt: 999,
      });

      await token.connect(platformAgent).addDocument(d);
      expect(await token.documentCount()).to.equal(1n);

      const stored = await token.documentAt(0);
      expect(stored.sha256Hash).to.equal(d.sha256Hash);
      expect(stored.uri).to.equal(d.uri);
      expect(stored.filename).to.equal(d.filename);
      expect(stored.docKind).to.equal(d.docKind);
      expect(stored.isPublic).to.equal(false);
      // Contract overwrites addedAt with block.timestamp — not the bogus 999.
      const block = await ethers.provider.getBlock('latest');
      expect(stored.addedAt).to.equal(BigInt(block!.timestamp));
      expect(stored.addedAt).to.not.equal(999n);

      const all = await token.documents();
      expect(all.length).to.equal(1);
      expect(all[0].sha256Hash).to.equal(d.sha256Hash);
    });

    it('supports multiple documents with ascending indices', async () => {
      await token.connect(platformAgent).addDocument(doc({ filename: 'a.pdf' }));
      const idx2 = await token.connect(platformAgent).addDocument.staticCall(
        doc({ filename: 'b.pdf' })
      );
      expect(idx2).to.equal(1n);
      await token.connect(platformAgent).addDocument(doc({ filename: 'b.pdf' }));
      expect(await token.documentCount()).to.equal(2n);
    });
  });

  describe('setDocuments', () => {
    it('replaces the whole set and emits DocumentsReplaced with the count', async () => {
      await token.connect(platformAgent).addDocument(doc({ filename: 'old.pdf' }));
      expect(await token.documentCount()).to.equal(1n);

      const replacement = [
        doc({ filename: 'one.pdf', docKind: toBytes32('image') }),
        doc({ filename: 'two.pdf', docKind: toBytes32('title_deed') }),
        doc({ filename: 'three.pdf', docKind: toBytes32('sales_collateral') }),
      ];

      await expect(token.connect(platformAgent).setDocuments(replacement))
        .to.emit(token, 'DocumentsReplaced')
        .withArgs(3n);

      expect(await token.documentCount()).to.equal(3n);
      const all = await token.documents();
      expect(all.map((x) => x.filename)).to.deep.equal(['one.pdf', 'two.pdf', 'three.pdf']);

      // addedAt is stamped by the contract on every entry.
      const block = await ethers.provider.getBlock('latest');
      for (const entry of all) {
        expect(entry.addedAt).to.equal(BigInt(block!.timestamp));
      }
    });

    it('clearing with an empty array empties the registry', async () => {
      await token.connect(platformAgent).addDocument(doc());
      await expect(token.connect(platformAgent).setDocuments([]))
        .to.emit(token, 'DocumentsReplaced')
        .withArgs(0n);
      expect(await token.documentCount()).to.equal(0n);
    });
  });

  describe('removeDocumentAt', () => {
    beforeEach(async () => {
      await token.connect(platformAgent).setDocuments([
        doc({ filename: 'a.pdf' }),
        doc({ filename: 'b.pdf' }),
        doc({ filename: 'c.pdf' }),
      ]);
    });

    it('emits DocumentRemoved and shrinks the array', async () => {
      await expect(token.connect(platformAgent).removeDocumentAt(1))
        .to.emit(token, 'DocumentRemoved')
        .withArgs(1n);
      expect(await token.documentCount()).to.equal(2n);
      // swap-and-pop moves the last element ('c.pdf') into slot 1.
      const all = await token.documents();
      expect(all.map((x) => x.filename)).to.deep.equal(['a.pdf', 'c.pdf']);
    });

    it('reverts on an out-of-range index', async () => {
      await expect(
        token.connect(platformAgent).removeDocumentAt(3)
      ).to.be.revertedWithCustomError(token, 'DocumentIndexOutOfRange');
    });

    it('documentAt reverts on an out-of-range index', async () => {
      await expect(token.documentAt(99)).to.be.revertedWithCustomError(
        token,
        'DocumentIndexOutOfRange'
      );
    });
  });

  describe('onlyPlatform access control', () => {
    it('non-platform cannot addDocument', async () => {
      await expect(
        token.connect(intruder).addDocument(doc())
      ).to.be.revertedWithCustomError(token, 'NotPlatform');
    });

    it('non-platform cannot setDocuments', async () => {
      await expect(
        token.connect(intruder).setDocuments([doc()])
      ).to.be.revertedWithCustomError(token, 'NotPlatform');
    });

    it('non-platform cannot removeDocumentAt', async () => {
      await token.connect(platformAgent).addDocument(doc());
      await expect(
        token.connect(intruder).removeDocumentAt(0)
      ).to.be.revertedWithCustomError(token, 'NotPlatform');
    });
  });
});
