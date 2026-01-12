import * as dotenv from "dotenv";
import { defineConfig, task } from "hardhat/config";
import hardhatToolboxMochaEthersPlugin from "@nomicfoundation/hardhat-toolbox-mocha-ethers";

dotenv.config();

const MNEMONIC = process.env.MNEMONIC;
const ACCOUNTS = MNEMONIC ? { mnemonic: MNEMONIC, initialIndex: 0 } : [];

task("deploy", "Deploys all the contracts")
  .setAction(() => import("./tasks/deploy.js"));

export default defineConfig({
  solidity: {
    version: "0.8.33",
    settings: { 
      optimizer: { 
        enabled: true, 
        runs: 200 
      } 
    },
  },
  networks: {
    ethereum: {
      type: "http",
      chainType: "l1",
      url: process.env.ETHEREUM_RPC_URL ?? "https://mainnet.gateway.tenderly.co",
      accounts: ACCOUNTS,
    },
    polygon: {
      type: "http",
      chainType: "l1",
      url: process.env.POLYGON_RPC_URL ?? "https://rpc-mainnet.matic.quiknode.pro/",
      accounts: ACCOUNTS,
    }
  },
  plugins: [hardhatToolboxMochaEthersPlugin]
});