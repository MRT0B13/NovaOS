/**
 * Deploy ArbFlashReceiver to Arbitrum (mainnet or Sepolia testnet).
 *
 * Prerequisites:
 *   solc-select install 0.8.20 && solc-select use 0.8.20
 *
 * Usage:
 *   # Mainnet
 *   bun run contracts/deploy.ts
 *
 *   # Testnet (Arbitrum Sepolia)
 *   bun run contracts/deploy.ts --testnet
 *
 * After deployment:
 *   Set CFO_EVM_ARB_RECEIVER_ADDRESS=<address> in .env
 */

import { ethers } from 'ethers';
import { readFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';

// Aave v3 PoolAddressesProvider per network
const AAVE_PROVIDER: Record<string, string> = {
  mainnet:  '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb', // Arbitrum One
  testnet:  '0x36616cf17557639614c1cdDb356b1B83fc0B2132', // Arbitrum Sepolia
};

async function main() {
  const isTestnet = process.argv.includes('--testnet');
  const network = isTestnet ? 'testnet' : 'mainnet';
  const aaveProvider = AAVE_PROVIDER[network];

  // Load env from cfoEnv if available, fallback to process.env
  let privateKey: string | undefined;
  let rpcUrl: string | undefined;
  try {
    const { getCFOEnv } = await import('../src/launchkit/cfo/cfoEnv.ts');
    const env = getCFOEnv(true);
    privateKey = env.evmPrivateKey;
    const alchKey = env.arbitrumRpcUrl?.split('/').pop();
    rpcUrl = isTestnet
      ? `https://arb-sepolia.g.alchemy.com/v2/${alchKey}`
      : env.arbitrumRpcUrl;
  } catch {
    privateKey = process.env.CFO_EVM_PRIVATE_KEY;
    rpcUrl = isTestnet
      ? 'https://sepolia-rollup.arbitrum.io/rpc'
      : (process.env.CFO_ARBITRUM_RPC_URL ?? 'https://arb1.arbitrum.io/rpc');
  }

  if (!privateKey) { console.error('CFO_EVM_PRIVATE_KEY required'); process.exit(1); }

  console.log(`Network: Arbitrum ${isTestnet ? 'Sepolia (testnet)' : 'One (mainnet)'}`);
  console.log(`Aave PoolAddressesProvider: ${aaveProvider}`);

  console.log('\nCompiling ArbFlashReceiver.sol (--via-ir)...');
  mkdirSync('contracts/out', { recursive: true });
  execSync(
    'solc --via-ir --abi --bin --optimize --optimize-runs 200 -o contracts/out --overwrite contracts/ArbFlashReceiver.sol',
    { stdio: 'inherit' }
  );

  const abi      = JSON.parse(readFileSync('contracts/out/ArbFlashReceiver.abi', 'utf8'));
  const bytecode = '0x' + readFileSync('contracts/out/ArbFlashReceiver.bin', 'utf8').trim();

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet   = new ethers.Wallet(privateKey, provider);

  const chainId = (await provider.getNetwork()).chainId;
  const balance = await provider.getBalance(wallet.address);
  console.log(`Chain ID: ${chainId}`);
  console.log(`Deploying from: ${wallet.address}`);
  console.log(`ETH balance: ${ethers.formatEther(balance)}`);

  if (balance === 0n) {
    console.error('\n❌ No ETH for gas. Get testnet ETH from https://faucet.quicknode.com/arbitrum/sepolia');
    process.exit(1);
  }

  const factory  = new ethers.ContractFactory(abi, bytecode, wallet);
  const contract = await factory.deploy(aaveProvider, { gasLimit: 2_000_000 });
  console.log(`\nTx sent: ${contract.deploymentTransaction()?.hash}`);
  console.log('Waiting for confirmation...');
  await contract.waitForDeployment();

  const address = await contract.getAddress();

  // Verify basic state
  const deployed = new ethers.Contract(address, abi, provider);
  const owner = await deployed.owner();
  const aavePool = await deployed.aavePool();

  console.log(`\n✅ ArbFlashReceiver deployed!`);
  console.log(`   Address:   ${address}`);
  console.log(`   Owner:     ${owner}`);
  console.log(`   Aave Pool: ${aavePool}`);
  console.log(`   Network:   Arbitrum ${isTestnet ? 'Sepolia' : 'One'} (chain ${chainId})`);

  if (!isTestnet) {
    console.log(`\nAdd to .env:\nCFO_EVM_ARB_RECEIVER_ADDRESS=${address}`);
  } else {
    console.log(`\n🧪 Testnet deployment verified. Ready for mainnet:\n   bun run contracts/deploy.ts`);
  }
}

main().catch(console.error);
