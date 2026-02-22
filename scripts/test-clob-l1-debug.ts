#!/usr/bin/env bun
/**
 * Debug L1 auth — compare our signature format with Polymarket's py-clob-client
 * Reference: https://github.com/Polymarket/py-clob-client
 */
import 'dotenv/config';
import { getCFOEnv } from '../src/launchkit/cfo/cfoEnv.ts';

const env = getCFOEnv();
if (!env.evmPrivateKey) { console.log('No CFO_EVM_PRIVATE_KEY'); process.exit(1); }

const { ethers } = await import('ethers');
const wallet = new ethers.Wallet(env.evmPrivateKey);
console.log('Wallet:', wallet.address);

const CLOB_BASE = 'https://clob.polymarket.com';
const POLYGON_CHAIN_ID = 137;

// ── Our current approach ──
const timestamp = Math.floor(Date.now() / 1000).toString();
const nonce = Math.floor(Date.now() / 1000);

const domain1 = { name: 'ClobAuthDomain', version: '1', chainId: POLYGON_CHAIN_ID };
const types1 = {
  ClobAuth: [
    { name: 'address', type: 'address' },
    { name: 'timestamp', type: 'string' },
    { name: 'nonce', type: 'int256' },
    { name: 'message', type: 'string' },
  ],
};
const message1 = 'This message attests that I am the owner of the Ethereum address associated with this API key.';

const sig1 = await wallet.signTypedData(domain1, types1, {
  address: wallet.address,
  timestamp,
  nonce,
  message: message1,
});

console.log('\n--- Attempt 1: Our current approach ---');
console.log('Headers:', JSON.stringify({
  POLY_ADDRESS: wallet.address,
  POLY_SIGNATURE: sig1,
  POLY_TIMESTAMP: timestamp,
  POLY_NONCE: nonce.toString(),
}, null, 2));

// Test with GET /auth/derive-api-key
let resp = await fetch(`${CLOB_BASE}/auth/derive-api-key`, {
  headers: {
    POLY_ADDRESS: wallet.address,
    POLY_SIGNATURE: sig1,
    POLY_TIMESTAMP: timestamp,
    POLY_NONCE: nonce.toString(),
  },
});
console.log(`GET /auth/derive-api-key → ${resp.status}`);
if (!resp.ok) console.log('  body:', await resp.text());

// ── Attempt 2: nonce = 0 (Polymarket SDK default) ──
const sig2 = await wallet.signTypedData(domain1, types1, {
  address: wallet.address,
  timestamp,
  nonce: 0,
  message: message1,
});

console.log('\n--- Attempt 2: nonce=0 ---');
resp = await fetch(`${CLOB_BASE}/auth/derive-api-key`, {
  headers: {
    POLY_ADDRESS: wallet.address,
    POLY_SIGNATURE: sig2,
    POLY_TIMESTAMP: timestamp,
    POLY_NONCE: '0',
  },
});
console.log(`GET /auth/derive-api-key → ${resp.status}`);
if (resp.ok) {
  const data = await resp.json();
  console.log('  SUCCESS:', JSON.stringify(data).slice(0, 100));
} else {
  console.log('  body:', await resp.text());
}

// ── Attempt 3: POST /auth/api-key with nonce=0 ──
const sig3 = await wallet.signTypedData(domain1, types1, {
  address: wallet.address,
  timestamp,
  nonce: 0,
  message: message1,
});

console.log('\n--- Attempt 3: POST /auth/api-key with nonce=0 ---');
resp = await fetch(`${CLOB_BASE}/auth/api-key`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    POLY_ADDRESS: wallet.address,
    POLY_SIGNATURE: sig3,
    POLY_TIMESTAMP: timestamp,
    POLY_NONCE: '0',
  },
});
console.log(`POST /auth/api-key → ${resp.status}`);
if (resp.ok) {
  const data = await resp.json();
  console.log('  SUCCESS:', JSON.stringify(data).slice(0, 100));
} else {
  console.log('  body:', await resp.text());
}

// ── Attempt 4: nonce as string "0" in signature payload ──
const sig4 = await wallet.signTypedData(domain1, types1, {
  address: wallet.address,
  timestamp,
  nonce: '0',
  message: message1,
});

console.log('\n--- Attempt 4: POST with nonce as string "0" ---');
resp = await fetch(`${CLOB_BASE}/auth/api-key`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    POLY_ADDRESS: wallet.address,
    POLY_SIGNATURE: sig4,
    POLY_TIMESTAMP: timestamp,
    POLY_NONCE: '0',
  },
});
console.log(`POST /auth/api-key → ${resp.status}`);
if (resp.ok) {
  const data = await resp.json();
  console.log('  SUCCESS:', JSON.stringify(data).slice(0, 100));
} else {
  console.log('  body:', await resp.text());
}
