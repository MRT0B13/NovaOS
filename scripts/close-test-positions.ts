/**
 * Close the orphaned test positions and verify close works
 */
import 'dotenv/config';
import { ethers } from 'ethers';

const log = (msg: string) => console.log(`[CLOSE] ${msg}`);

const pk = process.env.CFO_EVM_PRIVATE_KEY!;
const rpc = process.env.CFO_POLYGON_RPC_URL!;
const provider = new ethers.JsonRpcProvider(rpc);
const wallet = new ethers.Wallet(pk, provider);

log(`Wallet: ${wallet.address}`);

// Check NFPM balance
const NFPM = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';
const nfpm = new ethers.Contract(NFPM, [
  'function balanceOf(address) view returns (uint256)',
  'function tokenOfOwnerByIndex(address,uint256) view returns (uint256)',
], provider);

const balance = await nfpm.balanceOf(wallet.address);
log(`LP NFTs owned: ${balance.toString()}`);

if (Number(balance) === 0) {
  log('No positions to close. Done.');
  process.exit(0);
}

// Get all tokenIds
const tokenIds: string[] = [];
for (let i = 0; i < Number(balance); i++) {
  const tid = await nfpm.tokenOfOwnerByIndex(wallet.address, i);
  tokenIds.push(tid.toString());
  log(`  Found: tokenId=${tid.toString()}`);
}

// Import the close function
const { closeEvmLpPosition } = await import('../src/launchkit/cfo/krystalService.ts');

// Close each position
for (const tokenId of tokenIds) {
  log(`\n=== Closing tokenId=${tokenId} ===`);
  try {
    const result = await closeEvmLpPosition({
      posId: tokenId,
      chainId: 'polygon@137',
      chainNumericId: 137,
    });
    
    log(`Success: ${result.success}`);
    if (result.txHash) log(`TX: ${result.txHash}`);
    log(`Recovered: token0=${result.amount0Recovered}, token1=${result.amount1Recovered}`);
    log(`Value: $${result.valueRecoveredUsd?.toFixed(2) ?? '?'}`);
    
    if (!result.success) {
      log(`ERROR: ${result.error}`);
    }
  } catch (err: any) {
    log(`THREW: ${err.message}`);
  }
}

// Final balance check
const WPOL = '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270';
const USDC = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';
const wpolC = new ethers.Contract(WPOL, ['function balanceOf(address) view returns (uint256)'], provider);
const usdcC = new ethers.Contract(USDC, ['function balanceOf(address) view returns (uint256)'], provider);

log('\n=== Final Balances ===');
log(`MATIC: ${ethers.formatEther(await provider.getBalance(wallet.address))}`);
log(`WPOL: ${ethers.formatEther(await wpolC.balanceOf(wallet.address))}`);
log(`USDC: ${ethers.formatUnits(await usdcC.balanceOf(wallet.address), 6)}`);

const finalBalance = await nfpm.balanceOf(wallet.address);
log(`LP NFTs remaining: ${finalBalance.toString()}`);

log('\nDone.');
