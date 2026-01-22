/**
 * Generate a new Solana wallet for agent funding
 * Run: bun run scripts/generate-wallet.ts
 */

import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

console.log('\n🔐 Generating New Solana Wallet for LaunchKit Agent\n');
console.log('═'.repeat(60));

const keypair = Keypair.generate();
const publicKey = keypair.publicKey.toBase58();
const privateKey = bs58.encode(keypair.secretKey);

console.log('\n✅ New wallet generated!\n');
console.log('📍 Public Key (wallet address):');
console.log(`   ${publicKey}\n`);
console.log('🔑 Private Key (add to .env):');
console.log(`   ${privateKey}\n`);

console.log('═'.repeat(60));
console.log('\n⚠️  IMPORTANT - Security Notes:\n');
console.log('1. The private key above gives FULL ACCESS to this wallet');
console.log('2. NEVER share the private key with anyone');
console.log('3. NEVER commit the private key to git');
console.log('4. Add it ONLY to your .env file (which is gitignored)\n');

console.log('📝 Next steps:\n');
console.log('1. Add to your .env file:');
console.log(`   AGENT_FUNDING_WALLET_SECRET=${privateKey}\n`);
console.log('2. Send SOL to the public address:');
console.log(`   ${publicKey}\n`);
console.log('3. Verify with: bun run scripts/check-wallet.ts\n');

console.log('💰 How much SOL to send?');
console.log('   • Testing: 0.5-1 SOL');
console.log('   • Production: 5-10 SOL (for multiple launches)\n');
