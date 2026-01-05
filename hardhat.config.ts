import * as dotenv from "dotenv";
import { defineConfig, task } from "hardhat/config";
import hardhatToolboxMochaEthersPlugin from "@nomicfoundation/hardhat-toolbox-mocha-ethers";

dotenv.config();

const MNEMONIC = process.env.MNEMONIC;
const ACCOUNTS = MNEMONIC ? { mnemonic: MNEMONIC, "initialIndex": 0 } : "remote";

const deploy = task(
  "deploy",
  "Deploys all the contracts"
).setAction(() => import("./tasks/deploy.js"))
  .build();

export default defineConfig({
  solidity: {
    version: "0.8.33",
    settings: {
      optimizer: {
        enabled: true,
        runs: 5000,
      },
    },
  },
  networks: {
    ethereum: {
      type: "http",
      chainType: "l1",
      url: "https://mainnet.gateway.tenderly.co",
      accounts: ACCOUNTS
    },
    polygon: {
      type: "http",
      chainType: "l1",
      url: "https://rpc-mainnet.matic.quiknode.pro/",
      accounts: ACCOUNTS
    }
  },
  tasks: [deploy],
  plugins: [hardhatToolboxMochaEthersPlugin]
});
