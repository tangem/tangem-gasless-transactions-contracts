import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import "dotenv/config";

const { MNEMONIC, ETHEREUM_RPC_URL, POLYGON_RPC_URL, API_KEY } = process.env;

export default {
  plugins: [hardhatToolboxMochaEthers],
  solidity: {
    version: "0.8.33",
    settings: {
      optimizer: { 
        enabled: true, 
        runs: 200 
      },
    },
  },
  networks: {
    ethereum: {
      type: "http",
      chainType: "l1",
      url: ETHEREUM_RPC_URL,
      mnemonic: MNEMONIC,
    },
    polygon: {
      type: "http",
      chainType: "l1",
      url: POLYGON_RPC_URL,
      mnemonic: MNEMONIC,
    },
  },
  etherscan: {
    apiKey: API_KEY,
  },
};