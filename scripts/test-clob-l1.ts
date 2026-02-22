#!/usr/bin/env bun
import 'dotenv/config';
import { getCLOBCredentials, invalidateCLOBCredentials } from '../src/launchkit/cfo/polymarketService.ts';

console.log('\n=== CLOB L1 Auth Derivation Test ===\n');

// Force invalidation so env creds are skipped → triggers L1 derivation
console.log('Step 1: Invalidating cached/env creds to force L1 derivation...');
invalidateCLOBCredentials();

// Try to derive fresh creds via L1
console.log('Step 2: Deriving CLOB credentials via L1 auth...\n');
try {
  const creds = await getCLOBCredentials();
  console.log('✅ L1 derivation SUCCESS');
  console.log(`   apiKey: ${creds.apiKey.slice(0, 12)}...`);
  console.log(`   secret: ${creds.secret.slice(0, 8)}...`);
  console.log(`   passphrase: ${creds.passphrase.slice(0, 8)}...`);
} catch (err: any) {
  console.log(`❌ L1 derivation FAILED: ${err.message}`);
}
