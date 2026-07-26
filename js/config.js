/**
 * MONK — the only file you need to edit to point the game at live
 * infrastructure. Everything else reads from here.
 */
window.MONK_CFG = {
  /* The Cloudflare Worker (worker/monk-worker.js). Must also appear in the
     `connect-src` of the CSP meta tag in index.html, or the browser blocks it. */
  api: 'https://monk.severin20.workers.dev',

  /* Monk ERC-721. Base mainnet: ETH-denominated so a 0.01 ETH mint means what
     it says, and gas does not swallow the price. */
  contract: '0x0000000000000000000000000000000000000000',
  chainId: '0x2105',                    // 8453 — Base mainnet
  chainName: 'Base',
  rpc: 'https://mainnet.base.org',
  explorer: 'https://basescan.org',

  mintPrice: '0.01',                    // ETH per monk
  maxPerWallet: 20,

  /* The abbey's X account — the posts that pay devotion. */
  x: 'MonkGame',
};
