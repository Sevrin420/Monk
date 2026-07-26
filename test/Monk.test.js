const { expect } = require('chai');
const { ethers } = require('hardhat');

/**
 * Soulbinding is the whole anti-arbitrage mechanism — if a Monk can move,
 * a player can grind a 28-day streak with one habit and then buy up cheap
 * ones from lapsed players to apply 3x to tokens that were earning nothing.
 * So the transfer paths get tested harder than the mint path.
 */
describe('Monk', function () {
  const PRICE = ethers.parseEther('0.01');
  let monk, owner, alice, bob;

  beforeEach(async function () {
    [owner, alice, bob] = await ethers.getSigners();
    monk = await (await ethers.getContractFactory('Monk'))
      .deploy('https://monk.example/', owner.address);
  });

  describe('minting', function () {
    it('mints at 0.01 ETH each', async function () {
      await monk.connect(alice).mint(3, { value: PRICE * 3n });
      expect(await monk.balanceOf(alice.address)).to.equal(3);
      expect(await monk.totalMinted()).to.equal(3);
      expect(await monk.ownerOf(1)).to.equal(alice.address);
    });

    it('rejects the wrong price in either direction', async function () {
      await expect(monk.connect(alice).mint(2, { value: PRICE }))
        .to.be.revertedWith('Monk: wrong price');
      await expect(monk.connect(alice).mint(1, { value: PRICE * 2n }))
        .to.be.revertedWith('Monk: wrong price');
    });

    it('caps a wallet at 20, across separate mints', async function () {
      await monk.connect(alice).mint(15, { value: PRICE * 15n });
      await monk.connect(alice).mint(5, { value: PRICE * 5n });
      await expect(monk.connect(alice).mint(1, { value: PRICE }))
        .to.be.revertedWith('Monk: 20 per wallet');
      expect(await monk.balanceOf(alice.address)).to.equal(20);
    });

    it('refuses zero quantity and a closed mint', async function () {
      await expect(monk.connect(alice).mint(0, { value: 0 }))
        .to.be.revertedWith('Monk: quantity 0');
      await monk.connect(owner).setMintOpen(false);
      await expect(monk.connect(alice).mint(1, { value: PRICE }))
        .to.be.revertedWith('Monk: mint closed');
    });

    it('numbers tokens from 1', async function () {
      await monk.connect(alice).mint(2, { value: PRICE * 2n });
      expect(await monk.tokensOfOwner(alice.address)).to.deep.equal([1n, 2n]);
    });
  });

  describe('soulbound', function () {
    beforeEach(async function () {
      await monk.connect(alice).mint(1, { value: PRICE });
    });

    it('reverts on transferFrom', async function () {
      await expect(monk.connect(alice).transferFrom(alice.address, bob.address, 1))
        .to.be.revertedWithCustomError(monk, 'Soulbound');
    });

    it('reverts on safeTransferFrom', async function () {
      await expect(
        monk.connect(alice)['safeTransferFrom(address,address,uint256)'](
          alice.address, bob.address, 1),
      ).to.be.revertedWithCustomError(monk, 'Soulbound');
    });

    it('reverts on approve, so it can never be listed', async function () {
      await expect(monk.connect(alice).approve(bob.address, 1))
        .to.be.revertedWithCustomError(monk, 'Soulbound');
    });

    it('reverts on setApprovalForAll, so no marketplace operator works', async function () {
      await expect(monk.connect(alice).setApprovalForAll(bob.address, true))
        .to.be.revertedWithCustomError(monk, 'Soulbound');
    });

    it('leaves the owner unchanged after every failed attempt', async function () {
      expect(await monk.ownerOf(1)).to.equal(alice.address);
      expect(await monk.balanceOf(bob.address)).to.equal(0);
    });

    it('still lets the abbey mint — the one allowed movement', async function () {
      await monk.connect(bob).mint(1, { value: PRICE });
      expect(await monk.ownerOf(2)).to.equal(bob.address);
    });
  });

  describe('referrals', function () {
    it('emits Referral when the referrer already holds a monk', async function () {
      await monk.connect(alice).mint(1, { value: PRICE });
      await expect(monk.connect(bob).mintWithReferrer(2, alice.address, { value: PRICE * 2n }))
        .to.emit(monk, 'Referral').withArgs(alice.address, bob.address, 2);
    });

    it('drops a referral from a wallet holding nothing, but still mints', async function () {
      await expect(monk.connect(bob).mintWithReferrer(1, alice.address, { value: PRICE }))
        .to.not.emit(monk, 'Referral');
      expect(await monk.balanceOf(bob.address)).to.equal(1);
    });

    it('counts referred MONKS, not referrals, so the Worker can read it', async function () {
      // This mapping is what lets the backend drop its log scan entirely:
      // one eth_call replaces a cron, a cursor and a START_BLOCK.
      await monk.connect(alice).mint(1, { value: PRICE });
      expect(await monk.referredCount(alice.address)).to.equal(0);

      await monk.connect(bob).mintWithReferrer(3, alice.address, { value: PRICE * 3n });
      expect(await monk.referredCount(alice.address)).to.equal(3);

      const [, , , dave] = await ethers.getSigners();
      await monk.connect(dave).mintWithReferrer(2, alice.address, { value: PRICE * 2n });
      expect(await monk.referredCount(alice.address)).to.equal(5);
    });

    it('does not count a dropped referral', async function () {
      // referrer holds nothing, so the referral is ignored — and must not
      // leave a number behind for the Worker to pay out on.
      await monk.connect(bob).mintWithReferrer(2, alice.address, { value: PRICE * 2n });
      expect(await monk.referredCount(alice.address)).to.equal(0);
    });

    it('refuses self-referral, but still mints', async function () {
      await monk.connect(alice).mint(1, { value: PRICE });
      await expect(monk.connect(alice).mintWithReferrer(1, alice.address, { value: PRICE }))
        .to.not.emit(monk, 'Referral');
      expect(await monk.balanceOf(alice.address)).to.equal(2);
    });
  });

  describe('owner controls', function () {
    it('only ever tightens the supply cap', async function () {
      await monk.connect(alice).mint(2, { value: PRICE * 2n });
      await expect(monk.connect(owner).setMaxSupply(1))
        .to.be.revertedWith('Monk: below minted');
      await monk.connect(owner).setMaxSupply(5);
      await expect(monk.connect(owner).setMaxSupply(10))
        .to.be.revertedWith('Monk: cannot raise cap');
      await expect(monk.connect(bob).mint(4, { value: PRICE * 4n }))
        .to.be.revertedWith('Monk: sold out');
    });

    it('keeps owner-only doors shut', async function () {
      await expect(monk.connect(alice).setMintOpen(false))
        .to.be.revertedWithCustomError(monk, 'OwnableUnauthorizedAccount');
      await expect(monk.connect(alice).withdraw(alice.address))
        .to.be.revertedWithCustomError(monk, 'OwnableUnauthorizedAccount');
    });

    it('withdraws the take', async function () {
      await monk.connect(alice).mint(4, { value: PRICE * 4n });
      const before = await ethers.provider.getBalance(bob.address);
      await monk.connect(owner).withdraw(bob.address);
      expect(await ethers.provider.getBalance(bob.address) - before).to.equal(PRICE * 4n);
      expect(await ethers.provider.getBalance(await monk.getAddress())).to.equal(0);
    });
  });
});
