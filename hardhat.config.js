import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import { task } from "hardhat/config";
import "dotenv/config";

const { MNEMONIC, ETHEREUM_RPC_URL, POLYGON_RPC_URL, BSC_RPC_URL, ARBITRUM_RPC_URL, BASE_RPC_URL, API_KEY } = process.env;
const ACCOUNTS = MNEMONIC ? { mnemonic: MNEMONIC, "initialIndex": 0 } : "remote";

const deploy = task(
  "deploy",
  "Deploys all the contracts"
).addOption({
    name: "type",
    description: "The type of Exector to deploy, depending on the network type",
    defaultValue: "",
  })
  .setAction(() => import("./tasks/deploy.js"))
  .build();

export default {
  plugins: [hardhatToolboxMochaEthers],
  solidity: {
    version: "0.8.33",
    settings: {
      optimizer: { 
        enabled: true, 
        runs: 5000 
      },
    },
  },
  networks: {
    ethereum: {
      type: "http",
      chainType: "l1",
      url: ETHEREUM_RPC_URL,
      mnemonic: MNEMONIC,
      accounts: ACCOUNTS
    },
    polygon: {
      type: "http",
      chainType: "l1",
      url: POLYGON_RPC_URL,
      mnemonic: MNEMONIC,
      accounts: ACCOUNTS
    },
    bsc: {
      type: "http",
      chainType: "l1",
      url: BSC_RPC_URL,
      mnemonic: MNEMONIC,
      accounts: ACCOUNTS
    },
    arbitrum: {
      type: "http",
      chainType: "generic",
      url: ARBITRUM_RPC_URL,
      mnemonic: MNEMONIC,
      accounts: ACCOUNTS
    },
    base: {
      type: "http",
      chainType: "op",
      url: BASE_RPC_URL,
      mnemonic: MNEMONIC,
      accounts: ACCOUNTS
    },
  },
  etherscan: {
    apiKey: API_KEY,
  },
  tasks: [deploy]
};