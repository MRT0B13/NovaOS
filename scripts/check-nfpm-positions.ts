#!/usr/bin/env bun
/**
 * check-nfpm-positions.ts — Check if wallet owns any NFPM NFTs on Base
 */

import 'dotenv/config';

async function main() {
  const { getEvmProvider } = await import('../src/launchkit/cfo/krystalService.ts');
  const { getCFOEnv } = await import('../src/launchkit/cfo/cfoEnv.ts');
  const ethers = await import('ethers' as string);

  const env = getCFOEnv();
  if (!env.evmPrivateKey) { console.log('No EVM private key'); return; }

  const wallet = ethers.computeAddress(env.evmPrivateKey);
  console.log(`Wallet: ${wallet}`);

  const provider = await getEvmProvider(8453); // Base

  const NFPM_ADDRESS = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';
  const NFPM_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
    'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  ];
  const nfpm = new ethers.Contract(NFPM_ADDRESS, NFPM_ABI, provider);

  // Check balance
  const balance = await nfpm.balanceOf(wallet);
  console.log(`NFPM NFT balance: ${balance.toString()}`);

  if (balance === BigInt(0)) {
    console.log('No NFPM positions owned on Base');
    
    // Also try the Uniswap V3 NFPM on Base (v1.3.0)
    const ALT_NFPM = '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1';
    try {
      const altNfpm = new ethers.Contract(ALT_NFPM, NFPM_ABI, provider);
      const altBal = await altNfpm.balanceOf(wallet);
      console.log(`\nAlt NFPM (${ALT_NFPM}) balance: ${altBal.toString()}`);
      
      if (altBal > BigInt(0)) {
        for (let i = 0; i < Number(altBal); i++) {
          const tokenId = await altNfpm.tokenOfOwnerByIndex(wallet, BigInt(i));
          const pos = await altNfpm.positions(tokenId);
          console.log(`  Token #${tokenId}: liquidity=${pos.liquidity}, fee=${pos.fee}, token0=${pos.token0.slice(0,10)}, token1=${pos.token1.slice(0,10)}`);
        }
      }
    } catch (e: any) {
      console.log(`Alt NFPM not available: ${e.message?.slice(0, 100)}`);
    }
    return;
  }

  // Enumerate positions
  for (let i = 0; i < Number(balance); i++) {
    const tokenId = await nfpm.tokenOfOwnerByIndex(wallet, BigInt(i));
    const pos = await nfpm.positions(tokenId);
    console.log(`\nPosition #${tokenId}:`);
    console.log(`  token0: ${pos.token0}`);
    console.log(`  token1: ${pos.token1}`);
    console.log(`  fee: ${pos.fee}`);
    console.log(`  ticks: [${pos.tickLower}, ${pos.tickUpper}]`);
    console.log(`  liquidity: ${pos.liquidity}`);
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
