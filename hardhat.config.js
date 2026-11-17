import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import "dotenv/config";
import { buildNetworks } from "./config/networks.js";
import tasks from "./tasks/index.js";

const COMPILER = {
  version: "0.8.33",
  settings: {
    optimizer: {
      enabled: true,
      runs: 5000
    },
  },
};

export default {
  plugins: [hardhatToolboxMochaEthers],
  solidity: {
    // Hardhat derives an implicit production profile with 200 optimizer runs. Deployments and
    // verification use it, so it must compile the same bytecode the tests run against.
    profiles: {
      default: COMPILER,
      production: COMPILER,
    },
  },
  networks: buildNetworks(),
  verify: {
    etherscan: {
      apiKey: process.env.ETHERSCAN_API_KEY ?? "",
    },
  },
  typechain: {
    dontOverrideCompile: true,
  },
  tasks,
};
