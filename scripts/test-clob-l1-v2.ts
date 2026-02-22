#!/usr/bin/env bun
/**
 * Test L1 auth using the EXACT format from Polymarket's py-clob-client:
 * https://github.com/Polymarket/py-clob-client/blob/main/py_clob_client/signer.py
 *
 * Key differences from our code:
 * - nonce type might need to be 'uint256' not 'int256'
 * - message might be different
 * - chainId might need to be a number not bigint
 */
import 'dotenv/config';
import { getCFOEnv } from '../src/launchkit/cfo/cfoEnv.ts';

const env = getCFOEnv();
const { ethers } = await import('ethers');
const wallet = new ethers.Wallet(env.evmPrivateKey!);
console.log('Wallet:', wallet.address);

const CLOB = 'https://clob.polymarket.com';
const ts = Math.floor(Date.now() / 1000).toString();

// ── Approach A: Polymarket JS SDK format ──
// From @polymarket/clob-client (npm), signer.ts
const domainA = {
  name: 'ClobAuthDomain',
  version: '1',
  chainId: 137,
};
const typesA = {
  ClobAuth: [
    { name: 'address', type: 'address' },
    { name: 'timestamp', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'message', type: 'string' },
  ],
};
const msgA = 'This message attests that I am the owner of the address associated with this API key';

const sigA = await wallet.signTypedData(domainA, typesA, {
  address: wallet.address,
  timestamp: ts,
  nonce: 0,
  message: msgA,
});

console.log('\n--- A: JS SDK format (uint256, short message) ---');
let resp = await fetch(`${CLOB}/auth/derive-api-key`, {
  headers: { POLY_ADDRESS: wallet.address, POLY_SIGNATURE: sigA, POLY_TIMESTAMP: ts, POLY_NONCE: '0' },
});
console.log(`  GET /auth/derive-api-key → ${resp.status}`);
if (resp.ok) { console.log('  ✅', await resp.json()); }
else {
  const body = await resp.text();
  console.log(`  body: ${body}`);
  
  // Also try POST
  const sigA2 = await wallet.signTypedData(domainA, typesA, {
    address: wallet.address, timestamp: ts, nonce: 0, message: msgA,
  });
  resp = await fetch(`${CLOB}/auth/api-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', POLY_ADDRESS: wallet.address, POLY_SIGNATURE: sigA2, POLY_TIMESTAMP: ts, POLY_NONCE: '0' },
  });
  console.log(`  POST /auth/api-key → ${resp.status}`);
  if (resp.ok) console.log('  ✅', await resp.json());
  else console.log(`  body: ${await resp.text()}`);
}

// ── Approach B: Try different message texts ──
const messages = [
  'This message attests that I am the owner of the address associated with this API key',
  'This message attests that I am the owner of the Ethereum address associated with this API key.',
  'I want to create an API key',
];

for (const msg of messages) {
  const sig = await wallet.signTypedData(domainA, typesA, {
    address: wallet.address, timestamp: ts, nonce: 0, message: msg,
  });
  resp = await fetch(`${CLOB}/auth/derive-api-key`, {
    headers: { POLY_ADDRESS: wallet.address, POLY_SIGNATURE: sig, POLY_TIMESTAMP: ts, POLY_NONCE: '0' },
  });
  console.log(`\n--- msg="${msg.slice(0,60)}..." → ${resp.status} ---`);
  if (resp.ok) { console.log('  ✅', await resp.json()); break; }
}

// ── Approach C: Try POST /auth/derive-api-key with JSON body ──
console.log('\n--- C: POST /auth/derive-api-key with JSON body ---');
const sigC = await wallet.signTypedData(domainA, typesA, {
  address: wallet.address, timestamp: ts, nonce: 0, message: msgA,
});
resp = await fetch(`${CLOB}/auth/derive-api-key`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', POLY_ADDRESS: wallet.address, POLY_SIGNATURE: sigC, POLY_TIMESTAMP: ts, POLY_NONCE: '0' },
  body: JSON.stringify({}),
});
console.log(`  → ${resp.status}`);
if (resp.ok) console.log('  ✅', await resp.json());
else console.log(`  body: ${await resp.text()}`);
