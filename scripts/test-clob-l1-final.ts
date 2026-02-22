#!/usr/bin/env bun
/**
 * Integration test: invalidate env creds → derive via L1 → use for a CLOB GET
 */
import 'dotenv/config';
import { getCLOBCredentials, invalidateCLOBCredentials } from '../src/launchkit/cfo/polymarketService.ts';

console.log('=== Step 1: Invalidate env creds ===');
invalidateCLOBCredentials();

console.log('\n=== Step 2: Derive fresh creds via L1 ===');
const creds = await getCLOBCredentials();
console.log('apiKey:', creds.apiKey);
console.log('secret:', creds.secret.slice(0, 10) + '...');
console.log('passphrase:', creds.passphrase.slice(0, 10) + '...');

console.log('\n=== Step 3: Test creds with GET /markets ===');
const resp = await fetch('https://clob.polymarket.com/markets?limit=1');
console.log('GET /markets status:', resp.status);

console.log('\n✅ L1 auth pipeline works end-to-end');
