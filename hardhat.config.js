require('@nomicfoundation/hardhat-toolbox');

/* Deploys are NEVER run from here automatically — see CLAUDE.md. */
const KEY = process.env.DEPLOYER_PRIVATE_KEY;

module.exports = {
  solidity: {
    version: '0.8.26',
    settings: {
      optimizer: { enabled: true, runs: 200 },
      /* OpenZeppelin 5.x uses `mcopy`, which needs Cancun. Base has had it
         since Ecotone, so this is the correct target — leaving it at the
         default (paris) fails to compile. */
      evmVersion: 'cancun',
    },
  },
  networks: {
    /* Robinhood Chain — Arbitrum Orbit (Nitro) L2, ETH for gas. */
    robinhood: {
      url: process.env.ROBINHOOD_RPC || 'https://rpc.mainnet.chain.robinhood.com',
      chainId: 4663,
      accounts: KEY ? [KEY] : [],
    },
    /* Testnet: set ROBINHOOD_TESTNET_RPC and ROBINHOOD_TESTNET_CHAIN_ID from
       docs.robinhood.com/chain/connecting before using this — public chain
       lists disagree on the testnet id, so it is deliberately not hardcoded. */
    robinhoodTestnet: {
      url: process.env.ROBINHOOD_TESTNET_RPC || 'https://rpc.testnet.chain.robinhood.com',
      chainId: parseInt(process.env.ROBINHOOD_TESTNET_CHAIN_ID || '0', 10) || undefined,
      accounts: KEY ? [KEY] : [],
    },
  },
  /* The explorer is Blockscout, which takes any non-empty key. */
  etherscan: {
    apiKey: { robinhood: process.env.BLOCKSCOUT_API_KEY || 'blockscout' },
    customChains: [{
      network: 'robinhood',
      chainId: 4663,
      urls: {
        apiURL: 'https://robinhoodchain.blockscout.com/api',
        browserURL: 'https://robinhoodchain.blockscout.com',
      },
    }],
  },
};
