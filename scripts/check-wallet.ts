/**
 * Utility to verify wallet configuration and check balances
 * Run: bun run scripts/check-wallet.ts
 */

import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import * as dotenv from 'dotenv';

dotenv.config();

async function main() {
  console.log('\n🔍 LaunchKit Wallet Configuration Check\n');
  console.log('═'.repeat(60));

  const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');

  // Check funding wallet
  const fundingSecret = process.env.AGENT_FUNDING_WALLET_SECRET;
  if (!fundingSecret) {
    console.log('\n❌ AGENT_FUNDING_WALLET_SECRET not found in .env');
    console.log('\n📝 To fix:');
    console.log('   1. Export private key from Phantom (Settings → Security → Export Private Key)');
    console.log('   2. Add to .env: AGENT_FUNDING_WALLET_SECRET=your_private_key');
    console.log('   3. Run this script again\n');
    process.exit(1);
  }

  try {
    const fundingKeypair = Keypair.fromSecretKey(bs58.decode(fundingSecret));
    const fundingPubkey = fundingKeypair.publicKey.toBase58();
    const fundingBalance = await connection.getBalance(fundingKeypair.publicKey);
    const fundingBalanceSol = fundingBalance / LAMPORTS_PER_SOL;

    console.log('\n✅ Agent Funding Wallet (AGENT_FUNDING_WALLET_SECRET)');
    console.log('   Address:', fundingPubkey);
    console.log('   Balance:', fundingBalanceSol.toFixed(4), 'SOL');
    
    if (fundingBalanceSol < 0.1) {
      console.log('   ⚠️  Low balance! Send SOL to:', fundingPubkey);
      console.log('   Recommended: 1-5 SOL for multiple launches');
    } else if (fundingBalanceSol < 1) {
      console.log('   ⚠️  Balance OK for testing, but add more for production');
    } else {
      console.log('   ✅ Good balance for launches');
    }
  } catch (error) {
    console.log('\n❌ Invalid AGENT_FUNDING_WALLET_SECRET');
    console.log('   Error:', error.message);
    console.log('\n📝 Make sure it\'s a valid base58-encoded private key from Phantom');
    process.exit(1);
  }

  // Check pump wallet
  const pumpWalletAddress = process.env.PUMP_PORTAL_WALLET_ADDRESS;
  if (!pumpWalletAddress) {
    console.log('\n⚠️  PUMP_PORTAL_WALLET_ADDRESS not found in .env');
    console.log('   This is needed for token launches on pump.fun\n');
  } else {
    try {
      const pumpPubkey = new PublicKey(pumpWalletAddress);
      const pumpBalance = await connection.getBalance(pumpPubkey);
      const pumpBalanceSol = pumpBalance / LAMPORTS_PER_SOL;

      console.log('\n✅ Pump Portal Wallet (PUMP_PORTAL_WALLET_ADDRESS)');
      console.log('   Address:', pumpWalletAddress);
      console.log('   Balance:', pumpBalanceSol.toFixed(4), 'SOL');
      
      if (pumpBalanceSol < 0.3) {
        console.log('   ⚠️  Needs funding for launches');
        console.log('   Agent will auto-deposit from funding wallet when launching');
      } else {
        console.log('   ✅ Ready for token launches');
      }
    } catch (error) {
      console.log('\n❌ Invalid PUMP_PORTAL_WALLET_ADDRESS');
      console.log('   Error:', error.message);
    }
  }

  // Check pump wallet secret
  const pumpSecret = process.env.PUMP_PORTAL_WALLET_SECRET;
  if (!pumpSecret) {
    console.log('\n⚠️  PUMP_PORTAL_WALLET_SECRET not found in .env');
    console.log('   This is needed for signing pump.fun transactions\n');
  } else {
    console.log('\n✅ PUMP_PORTAL_WALLET_SECRET configured');
  }

  // Check pump portal API key
  const pumpApiKey = process.env.PUMP_PORTAL_API_KEY;
  if (!pumpApiKey) {
    console.log('\n❌ PUMP_PORTAL_API_KEY not found in .env');
    console.log('   This is required for pump.fun API authentication');
    console.log('   Get one from: https://pumpportal.fun\n');
  } else {
    console.log('\n✅ PUMP_PORTAL_API_KEY configured');
  }

  // Summary
  console.log('\n' + '═'.repeat(60));
  console.log('\n📊 Configuration Status:');
  
  const hasAllRequired = fundingSecret && pumpWalletAddress && pumpSecret && pumpApiKey;
  if (hasAllRequired) {
    console.log('   ✅ All required wallet configs present');
    console.log('\n🚀 Ready to launch! Test with:');
    console.log('   User: "check wallet balances"');
    console.log('   User: "deposit 0.5 sol to pump wallet"');
  } else {
    console.log('   ⚠️  Missing required configuration');
    console.log('\n📝 See WALLET_SETUP.md for complete setup instructions');
  }

  console.log('\n');
}

main().catch(console.error);
