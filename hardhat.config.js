require('@nomicfoundation/hardhat-toolbox');

/* Deploys are NEVER run from here automatically — see CLAUDE.md. */
const KEY = process.env.DEPLOYER_PRIVATE_KEY;

module.exports = {
  solidity: {
    version: '0.8.26',
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    base: {
      url: process.env.BASE_RPC || 'https://mainnet.base.org',
      chainId: 8453,
      accounts: KEY ? [KEY] : [],
    },
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org',
      chainId: 84532,
      accounts: KEY ? [KEY] : [],
    },
  },
  etherscan: { apiKey: { base: process.env.BASESCAN_API_KEY || '' } },
};
