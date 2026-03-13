/**
 * Deploy ArbFlashReceiver to any supported EVM chain.
 *
 * Prerequisites:
 *   Pre-compiled bytecode in contracts/out/ (run solc if missing):
 *   solc-select install 0.8.20 && solc-select use 0.8.20
 *   solc --via-ir --abi --bin --optimize --optimize-runs 200 -o contracts/out --overwrite contracts/ArbFlashReceiver.sol
 *
 * Usage:
 *   # Deploy to all enabled chains (from CFO_EVM_ARB_CHAINS env var)
 *   bun run contracts/deploy.ts
 *
 *   # Deploy to a specific chain
 *   bun run contracts/deploy.ts --chain base
 *   bun run contracts/deploy.ts --chain polygon
 *   bun run contracts/deploy.ts --chain optimism
 *   bun run contracts/deploy.ts --chain arbitrum
 *
 *   # Compile first, then deploy
 *   bun run contracts/deploy.ts --compile --chain base
 *
 * After deployment:
 *   Addresses are printed. Set in .env or let auto-deploy save to DB.
 */

import { ethers } from 'ethers';
import { readFileSync, mkdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { resolve } from 'path';

// Aave v3 PoolAddressesProvider per chain (mainnet)
const AAVE_PROVIDER: Record<string, string> = {
  arbitrum: '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb',
  base:     '0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D',
  polygon:  '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb',
  optimism: '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb',
};

const CHAIN_IDS: Record<string, number> = {
  arbitrum: 42161,
  base: 8453,
  polygon: 137,
  optimism: 10,
};

async function deployToChain(chainKey: string, privateKey: string, rpcUrl: string) {
  const aaveProvider = AAVE_PROVIDER[chainKey];
  if (!aaveProvider) {
    console.error(`❌ Unknown chain: ${chainKey}`);
    return null;
  }

  const outPath = resolve(process.cwd(), 'contracts', 'out');
  const abiPath = resolve(outPath, 'ArbFlashReceiver.abi');
  const binPath = resolve(outPath, 'ArbFlashReceiver.bin');

  if (!existsSync(abiPath) || !existsSync(binPath)) {
    console.error('❌ Pre-compiled artifacts not found. Run with --compile flag first.');
    return null;
  }

  const abi = JSON.parse(readFileSync(abiPath, 'utf8'));
  const bytecode = '0x' + readFileSync(binPath, 'utf8').trim();

  console.log(`\n═══ Deploying to ${chainKey.toUpperCase()} ═══`);
  console.log(`Aave PoolAddressesProvider: ${aaveProvider}`);

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);

  const chainId = (await provider.getNetwork()).chainId;
  const balance = await provider.getBalance(wallet.address);
  console.log(`Chain ID: ${chainId} | Deployer: ${wallet.address}`);
  console.log(`Balance: ${ethers.formatEther(balance)} ETH`);

  if (balance === 0n) {
    console.error(`❌ No ETH on ${chainKey} — need gas for deployment`);
    return null;
  }

  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const contract = await factory.deploy(aaveProvider, { gasLimit: 2_500_000 });
  console.log(`Tx: ${contract.deploymentTransaction()?.hash}`);
  console.log('Waiting for confirmation...');
  await contract.waitForDeployment();

  const address = await contract.getAddress();

  // Verify
  const deployed = new ethers.Contract(address, abi, provider);
  const owner = await deployed.owner();
  const resolvedPool = await deployed.aavePool();

  console.log(`✅ ${chainKey.toUpperCase()} deployed!`);
  console.log(`   Address:   ${address}`);
  console.log(`   Owner:     ${owner}`);
  console.log(`   Aave Pool: ${resolvedPool}`);

  return address;
}

async function main() {
  const args = process.argv.slice(2);
  const shouldCompile = args.includes('--compile');
  const chainIdx = args.indexOf('--chain');
  const specificChain = chainIdx >= 0 ? args[chainIdx + 1]?.toLowerCase() : undefined;

  // Compile if requested
  if (shouldCompile) {
    console.log('Compiling ArbFlashReceiver.sol (--via-ir)...');
    mkdirSync('contracts/out', { recursive: true });
    execSync(
      'solc --via-ir --abi --bin --optimize --optimize-runs 200 -o contracts/out --overwrite contracts/ArbFlashReceiver.sol',
      { stdio: 'inherit' }
    );
    console.log('Compilation complete.\n');
  }

  // Load env
  let privateKey: string | undefined;
  let rpcUrls: Record<number, string> = {};
  try {
    const { getCFOEnv } = await import('../src/launchkit/cfo/cfoEnv.ts');
    const env = getCFOEnv(true);
    privateKey = env.evmPrivateKey;
    rpcUrls = env.evmRpcUrls;
  } catch {
    privateKey = process.env.CFO_EVM_PRIVATE_KEY;
  }

  if (!privateKey) {
    console.error('CFO_EVM_PRIVATE_KEY required');
    process.exit(1);
  }

  // Determine which chains to deploy
  const chains = specificChain
    ? [specificChain]
    : (process.env.CFO_EVM_ARB_CHAINS ?? 'arbitrum').split(',').map(s => s.trim().toLowerCase());

  const results: Record<string, string> = {};

  for (const chain of chains) {
    const chainId = CHAIN_IDS[chain];
    if (!chainId) {
      console.error(`Unknown chain: ${chain}`);
      continue;
    }

    const rpcUrl = rpcUrls[chainId];
    if (!rpcUrl) {
      console.error(`No RPC URL for ${chain} (chainId ${chainId}). Set CFO_ALCHEMY_API_KEY or CFO_EVM_RPC_URLS.`);
      continue;
    }

    try {
      const address = await deployToChain(chain, privateKey, rpcUrl);
      if (address) results[chain] = address;
    } catch (err) {
      console.error(`Failed to deploy to ${chain}:`, err);
    }
  }

  // Summary
  if (Object.keys(results).length > 0) {
    console.log('\n═══ DEPLOYMENT SUMMARY ═══');
    console.log('Add to .env:');
    for (const [chain, addr] of Object.entries(results)) {
      const envKey = chain === 'arbitrum'
        ? 'CFO_EVM_ARB_RECEIVER_ADDRESS'
        : `CFO_EVM_ARB_RECEIVER_${chain.toUpperCase()}`;
      console.log(`${envKey}=${addr}`);
    }
  }
}

main().catch(console.error);
