/**
 * MONK — the only file you need to edit to point the game at live
 * infrastructure. Everything else reads from here.
 */
window.MONK_CFG = {
  /* The Cloudflare Worker (worker/monk-worker.js). Must also appear in the
     `connect-src` of the CSP meta tag in index.html, or the browser blocks it. */
  api: 'https://monk.severin20.workers.dev',

  /* Monk ERC-721, soulbound. */
  contract: '0x0000000000000000000000000000000000000000',

  /* Robinhood Chain — an Arbitrum Orbit (Nitro) L2 that uses ETH for gas, so
     a 0.01 ETH mint means what it says and is not eaten by fees. Chain ID
     4663 = 0x1237. The public RPC is free but rate limited; the game only
     touches it for wallet calls, and the Worker's own sync is ~3 requests
     every five minutes, so the free endpoint is comfortably enough. */
  chainId: '0x1237',                    // 4663 — Robinhood Chain mainnet
  chainName: 'Robinhood Chain',
  rpc: 'https://rpc.mainnet.chain.robinhood.com',
  explorer: 'https://robinhoodchain.blockscout.com',

  mintPrice: '0.01',                    // ETH per monk
  maxPerWallet: 20,

  /* The abbey's X account — the posts that pay devotion. */
  x: 'MonkGame',
};
