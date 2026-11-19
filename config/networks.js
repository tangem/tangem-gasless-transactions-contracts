const NETWORKS = {
  ethereum: { chainId: 1, chainType: "l1", rpc: "https://mainnet.gateway.tenderly.co" },
  bsc: { chainId: 56, chainType: "l1", rpc: "https://bsc-dataseed.bnbchain.org" },
  polygon: { chainId: 137, chainType: "l1", rpc: "https://rpc-mainnet.matic.quiknode.pro/" },
  base: { chainId: 8453, chainType: "op", rpc: "https://mainnet.base.org" },
  arbitrum: { chainId: 42161, chainType: "generic", rpc: "https://arbitrum-one.public.blastapi.io" },
};

/**
 * PRIVATE_KEY takes precedence over MNEMONIC. With neither set, networks get no signers,
 * so the config still loads while deployments fail with an explicit error.
 */
function accounts() {
  const { PRIVATE_KEY, MNEMONIC } = process.env;

  if (PRIVATE_KEY) return [PRIVATE_KEY];
  if (MNEMONIC) return { mnemonic: MNEMONIC, initialIndex: 0 };

  return [];
}

/** `RPC_URL_<NETWORK>` (uppercased network name) overrides the default public RPC. */
function rpcUrl(name, defaultRpc) {
  return process.env[`RPC_URL_${name.toUpperCase()}`] || defaultRpc;
}

export function buildNetworks() {
  const signers = accounts();

  return Object.fromEntries(
    Object.entries(NETWORKS).map(([name, { chainId, chainType, rpc }]) => [
      name,
      { type: "http", chainId, chainType, url: rpcUrl(name, rpc), accounts: signers },
    ]),
  );
}
