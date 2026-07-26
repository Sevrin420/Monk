// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * MONK — the abbey, 1200 AD.
 *
 * A SOULBOUND ERC-721. A habit is given, never sold on: once minted, a Monk
 * cannot be transferred, approved or burned. Want more monks? Take them from
 * the abbey.
 *
 * That is a game-design decision before it is a technical one. Devotion is
 * earned by a WALLET and every Monk in it shares that wallet's streak, so if
 * monks were tradeable a player could grind a 28-day streak with one monk and
 * then buy up cheap monks from lapsed players — instantly applying a 3x
 * multiplier to habits that were earning nothing. Soulbinding closes that
 * arbitrage completely, and it means the only way to hold more monks is to
 * mint them.
 *
 * It also shrinks the backend to almost nothing. With no transfers there is
 * no ownership to track: the Worker only ever needs to learn that a mint
 * happened, which it reads from `Transfer` logs out of the zero address.
 *
 * Chain reads the Worker relies on, both free over `eth_getLogs`:
 *   1. Transfer(0x0 → owner)  — a mint
 *   2. Referral               — who sent the minter
 */
contract Monk is ERC721, Ownable {
    uint256 public constant MINT_PRICE = 0.01 ether;
    uint256 public constant MAX_PER_WALLET = 20;

    /// 0 = uncapped. The abbey takes all who come; set a cap later if wanted.
    uint256 public maxSupply;

    uint256 public totalMinted;
    bool public mintOpen = true;
    string private _base;

    /// Minted through someone's referral link. The Worker credits `referrer`
    /// 20 devotion per monk in `quantity`.
    event Referral(address indexed referrer, address indexed minter, uint256 quantity);
    event MintOpenSet(bool open);
    event MaxSupplySet(uint256 maxSupply);

    error Soulbound();

    constructor(string memory baseURI_, address owner_) ERC721("Monk", "MONK") Ownable(owner_) {
        _base = baseURI_;
    }

    // ─────────────────────────── minting ───────────────────────────

    function mint(uint256 quantity) external payable {
        _mintMany(quantity, address(0));
    }

    /**
     * Mint crediting a referrer. `referrer` must be a real, different wallet
     * that already holds a Monk — otherwise the referral is silently dropped
     * and the mint still goes through, so a bad link never costs a player
     * their transaction.
     */
    function mintWithReferrer(uint256 quantity, address referrer) external payable {
        if (referrer == msg.sender || balanceOf(referrer) == 0) referrer = address(0);
        _mintMany(quantity, referrer);
    }

    function _mintMany(uint256 quantity, address referrer) private {
        require(mintOpen, "Monk: mint closed");
        require(quantity > 0, "Monk: quantity 0");
        require(balanceOf(msg.sender) + quantity <= MAX_PER_WALLET, "Monk: 20 per wallet");
        require(maxSupply == 0 || totalMinted + quantity <= maxSupply, "Monk: sold out");
        require(msg.value == MINT_PRICE * quantity, "Monk: wrong price");

        uint256 id = totalMinted;
        totalMinted = id + quantity;
        for (uint256 i = 0; i < quantity; i++) {
            _safeMint(msg.sender, id + i + 1); // token ids start at 1
        }

        if (referrer != address(0)) emit Referral(referrer, msg.sender, quantity);
    }

    // ─────────────────────────── soulbound ───────────────────────────

    /**
     * The single chokepoint every mint, transfer and burn passes through.
     * Minting has no previous owner, so it is the only case allowed; a
     * transfer or a burn both arrive here with `from != 0` and revert.
     */
    function _update(address to, uint256 tokenId, address auth)
        internal
        override
        returns (address)
    {
        if (_ownerOf(tokenId) != address(0)) revert Soulbound();
        return super._update(to, tokenId, auth);
    }

    /// Approvals are refused outright, so a Monk can never even be listed.
    function approve(address, uint256) public pure override {
        revert Soulbound();
    }

    function setApprovalForAll(address, bool) public pure override {
        revert Soulbound();
    }

    // ─────────────────────────── views ───────────────────────────

    /**
     * Every token a wallet holds. O(totalMinted) — never call this on-chain,
     * it exists for wallet UIs and for the Worker's reconciliation pass.
     */
    function tokensOfOwner(address owner_) external view returns (uint256[] memory ids) {
        uint256 n = balanceOf(owner_);
        ids = new uint256[](n);
        if (n == 0) return ids;
        uint256 found;
        for (uint256 id = 1; id <= totalMinted && found < n; id++) {
            if (_ownerOf(id) == owner_) ids[found++] = id;
        }
    }

    function _baseURI() internal view override returns (string memory) {
        return _base;
    }

    // ─────────────────────────── owner ───────────────────────────

    function setMintOpen(bool open) external onlyOwner {
        mintOpen = open;
        emit MintOpenSet(open);
    }

    /// Only ever tightens: once a cap is set it can be lowered, never raised
    /// above itself, and never below what is already minted.
    function setMaxSupply(uint256 newMax) external onlyOwner {
        require(newMax >= totalMinted, "Monk: below minted");
        require(maxSupply == 0 || newMax <= maxSupply, "Monk: cannot raise cap");
        maxSupply = newMax;
        emit MaxSupplySet(newMax);
    }

    function setBaseURI(string calldata baseURI_) external onlyOwner {
        _base = baseURI_;
    }

    function withdraw(address payable to) external onlyOwner {
        require(to != address(0), "Monk: zero address");
        (bool ok, ) = to.call{value: address(this).balance}("");
        require(ok, "Monk: withdraw failed");
    }
}
