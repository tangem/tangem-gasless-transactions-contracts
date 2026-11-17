import deploymentParameters from "../../config/deployment-parameters.json" with { type: "json" };

/** `IGasOverhead.L1FeeMode` members in declaration order. */
const L1_FEE_MODES = ["None", "Arbitrum", "OpStack"];

const REQUIRED_PARAMETERS = [
  "baseGasAfterCall",
  "l1FeeMode",
  "coldAccountAccessCost",
  "valueTransferCost",
  "newAccountCost",
];

/** Config values of the network, overridden by the CLI arguments that were passed. */
export async function resolveDeploymentParameters({ ethers, networkName }, args) {
  const { chainId, ...configured } = deploymentParameters[networkName] ?? {};
  const { chainId: rpcChainId } = await ethers.provider.getNetwork();

  if (chainId !== undefined && BigInt(chainId) !== rpcChainId) {
    throw new Error(`Chain ID mismatch for network "${networkName}": expected ${chainId}, got ${rpcChainId}`);
  }

  const overrides = Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
  const parameters = { ...configured, ...overrides };
  const missing = REQUIRED_PARAMETERS.filter((name) => !parameters[name]);

  if (missing.length > 0) {
    throw new Error(
      `Missing deployment parameters for network "${networkName}": ${missing.join(", ")}. ` +
        "Configure them in config/deployment-parameters.json or pass them as CLI arguments.",
    );
  }

  if (!L1_FEE_MODES.includes(parameters.l1FeeMode)) {
    throw new Error(`l1FeeMode must be one of ${L1_FEE_MODES.join(", ")}, got "${parameters.l1FeeMode}"`);
  }

  return parameters;
}

export function executorArgs({ baseGasAfterCall, l1FeeMode, coldAccountAccessCost, valueTransferCost, newAccountCost }) {
  return [
    baseGasAfterCall,
    L1_FEE_MODES.indexOf(l1FeeMode),
    { coldAccountAccessCost, valueTransferCost, newAccountCost },
  ];
}
