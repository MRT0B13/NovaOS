#!/usr/bin/env bun
/**
 * Test L1 auth with EXACT values from Polymarket official SDK:
 * MSG_TO_SIGN = "This message attests that I control the given wallet"
 * nonce type = uint256, default = 0
 * chainId = 137 (Polygon)
 */
import 'dotenv/config';
import { getCFOEnv } from '../src/launchkit/cfo/cfoEnv.ts';

const env = getCFOEnv();
const { ethers } = await import('ethers');
const wallet = new ethers.Wallet(env.evmPrivateKey!);
console.log('Wallet:', wallet.address);

const CLOB = 'https://clob.polymarket.com';
const ts = Math.floor(Date.now() / 1000);

const domain = {
  name: 'ClobAuthDomain',
  version: '1',
  chainId: 137,
};

const types = {
  ClobAuth: [
    { name: 'address', type: 'address' },
    { name: 'timestamp', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'message', type: 'string' },
  ],
};

// EXACT message from SDK constants.ts
const MSG_TO_SIGN = 'This message attests that I control the given wallet';

const sig = await wallet.signTypedData(domain, types, {
  address: wallet.address,
  timestamp: `${ts}`,
  nonce: 0,
  message: MSG_TO_SIGN,
});

console.log('Timestamp:', ts);
console.log('Signature:', sig.slice(0, 20) + '...');

const headers = {
  POLY_ADDRESS: wallet.address,
  POLY_SIGNATURE: sig,
  POLY_TIMESTAMP: `${ts}`,
  POLY_NONCE: '0',
};

// Test 1: GET /auth/derive-api-key
console.log('\n--- GET /auth/derive-api-key ---');
let resp = await fetch(`${CLOB}/auth/derive-api-key`, { headers });
console.log(`Status: ${resp.status}`);
const body1 = await resp.text();
console.log(`Body: ${body1}`);

if (!resp.ok) {
  // Test 2: POST /auth/api-key
  console.log('\n--- POST /auth/api-key ---');
  const sig2 = await wallet.signTypedData(domain, types, {
    address: wallet.address,
    timestamp: `${ts}`,
    nonce: 0,
    message: MSG_TO_SIGN,
  });
  resp = await fetch(`${CLOB}/auth/api-key`, {
    method: 'POST',
    headers: { ...headers, POLY_SIGNATURE: sig2, 'Content-Type': 'application/json' },
  });
  console.log(`Status: ${resp.status}`);
  console.log(`Body: ${await resp.text()}`);
}
