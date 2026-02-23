import 'dotenv/config';
import { ethers } from 'ethers';
import { createHmac } from 'crypto';

const wallet = new ethers.Wallet(process.env.CFO_EVM_PRIVATE_KEY!);
console.log('Wallet:', wallet.address);

// ── Helper: build L2 HMAC headers ──
function makeL2(apiKey: string, secret: string, passphrase: string, method: string, path: string, body?: string) {
  const ts = String(Math.floor(Date.now() / 1000));
  let pre = ts + method + path;
  if (body) pre += body;
  const hmac = createHmac('sha256', Buffer.from(secret, 'base64')).update(pre).digest('base64');
  const sig = hmac.replace(/\+/g, '-').replace(/\//g, '_');
  return {
    POLY_ADDRESS: wallet.address,
    POLY_SIGNATURE: sig,
    POLY_TIMESTAMP: ts,
    POLY_API_KEY: apiKey,
    POLY_PASSPHRASE: passphrase,
    'Content-Type': 'application/json',
  };
}

// ── Test 1: Env-provided API key ──
console.log('\n=== TEST 1: Env API key ===');
const envKey = process.env.CFO_POLYMARKET_API_KEY!;
const envSecret = process.env.CFO_POLYMARKET_API_SECRET!;
const envPass = process.env.CFO_POLYMARKET_PASSPHRASE!;
console.log('Key:', envKey.slice(0, 12) + '...');

try {
  const h1 = makeL2(envKey, envSecret, envPass, 'GET', '/auth/api-keys');
  const r1 = await fetch('https://clob.polymarket.com/auth/api-keys', { headers: h1 });
  const d1 = await r1.json();
  console.log('GET /auth/api-keys:', r1.status, Array.isArray(d1) ? `${d1.length} keys` : JSON.stringify(d1).slice(0, 200));
} catch (e) {
  console.log('ERROR:', (e as Error).message);
}

// ── Test 2: Derive fresh key via L1 ──
console.log('\n=== TEST 2: Derive fresh key ===');
const timestamp = Math.floor(Date.now() / 1000);
const domain = { name: 'ClobAuthDomain', version: '1', chainId: 137 };
const types = {
  ClobAuth: [
    { name: 'address', type: 'address' },
    { name: 'timestamp', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'message', type: 'string' },
  ],
};
const sig = await wallet.signTypedData(domain, types, {
  address: wallet.address,
  timestamp: String(timestamp),
  nonce: 0,
  message: 'This message attests that I control the given wallet',
});
const l1h = {
  POLY_ADDRESS: wallet.address,
  POLY_SIGNATURE: sig,
  POLY_TIMESTAMP: String(timestamp),
  POLY_NONCE: '0',
};

// POST /auth/api-key
const r2 = await fetch('https://clob.polymarket.com/auth/api-key', {
  method: 'POST',
  headers: { ...l1h, 'Content-Type': 'application/json' },
});
const d2 = await r2.json() as any;
console.log('POST /auth/api-key:', r2.status, d2.apiKey ? 'got key: ' + d2.apiKey.slice(0, 12) + '...' : JSON.stringify(d2));

// GET /auth/derive-api-key
const r3 = await fetch('https://clob.polymarket.com/auth/derive-api-key', { headers: l1h });
const d3 = await r3.json() as any;
console.log('GET /auth/derive-api-key:', r3.status, d3.apiKey ? 'got key: ' + d3.apiKey.slice(0, 12) + '...' : JSON.stringify(d3));

// Compare keys
if (d3.apiKey) {
  console.log('\nEnv key matches derived?', envKey === d3.apiKey);
  
  // Test the derived key
  const h3 = makeL2(d3.apiKey, d3.secret, d3.passphrase, 'GET', '/auth/api-keys');
  const r4 = await fetch('https://clob.polymarket.com/auth/api-keys', { headers: h3 });
  const d4 = await r4.json();
  console.log('Derived key test (GET /auth/api-keys):', r4.status, Array.isArray(d4) ? `${d4.length} keys` : JSON.stringify(d4).slice(0, 200));
  
  // Test order-related endpoint
  const oP = '/data/orders?market=&asset_id=&state=LIVE';
  const h5 = makeL2(d3.apiKey, d3.secret, d3.passphrase, 'GET', oP);
  const r5 = await fetch('https://clob.polymarket.com' + oP, { headers: h5 });
  const d5 = await r5.json();
  console.log('Derived key test (GET /data/orders):', r5.status, Array.isArray(d5) ? `${d5.length} orders` : JSON.stringify(d5).slice(0, 200));
}

// If POST gave a different key, test that too
if (d2.apiKey && d2.apiKey !== d3.apiKey) {
  console.log('\n=== TEST 3: POST-created key ===');
  console.log('POST key differs from derived key!');
  const h6 = makeL2(d2.apiKey, d2.secret, d2.passphrase, 'GET', '/auth/api-keys');
  const r6 = await fetch('https://clob.polymarket.com/auth/api-keys', { headers: h6 });
  const d6 = await r6.json();
  console.log('POST key test:', r6.status, Array.isArray(d6) ? `${d6.length} keys` : JSON.stringify(d6).slice(0, 200));
}
