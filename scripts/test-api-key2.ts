import 'dotenv/config';
import { ethers } from 'ethers';
import { createHmac } from 'crypto';

const wallet = new ethers.Wallet(process.env.CFO_EVM_PRIVATE_KEY!);

// Derive key
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

const r = await fetch('https://clob.polymarket.com/auth/derive-api-key', { headers: l1h });
const creds = await r.json() as any;
console.log('Derived:', creds.apiKey);
console.log('Secret:', creds.secret);
console.log('Passphrase:', creds.passphrase);

// Now test L2 with the derived key at multiple endpoints
function makeL2(method: string, path: string, body?: string) {
  const ts = String(Math.floor(Date.now() / 1000));
  let pre = ts + method + path;
  if (body) pre += body;
  const hmac = createHmac('sha256', Buffer.from(creds.secret, 'base64')).update(pre).digest('base64');
  const sig = hmac.replace(/\+/g, '-').replace(/\//g, '_');
  return {
    POLY_ADDRESS: wallet.address,
    POLY_SIGNATURE: sig,
    POLY_TIMESTAMP: ts,
    POLY_API_KEY: creds.apiKey,
    POLY_PASSPHRASE: creds.passphrase,
    'Content-Type': 'application/json',
  };
}

// Test various endpoints
const endpoints = [
  { method: 'GET', path: '/auth/api-keys' },
  { method: 'GET', path: '/data/orders?market=&asset_id=&state=LIVE' },
  { method: 'GET', path: '/profile' },
  { method: 'GET', path: '/positions' },
  { method: 'GET', path: '/balance-allowance?asset_type=COLLATERAL' },
];

for (const ep of endpoints) {
  try {
    const h = makeL2(ep.method, ep.path);
    const resp = await fetch('https://clob.polymarket.com' + ep.path, { headers: h });
    const body = await resp.text();
    console.log(`\n${ep.method} ${ep.path}: ${resp.status}`);
    console.log('  Response:', body.slice(0, 300));
  } catch (e) {
    console.log(`${ep.method} ${ep.path}: ERROR - ${(e as Error).message}`);
  }
}

// Also try: delete old keys then create new
console.log('\n=== Trying to delete old keys and create fresh ===');
// List keys first
const r2 = await fetch('https://clob.polymarket.com/auth/api-keys', { headers: makeL2('GET', '/auth/api-keys') });
const keysList = await r2.json() as any;
console.log('Current keys:', JSON.stringify(keysList));

// Try deleting old env key via L1
const l1hFresh = {
  POLY_ADDRESS: wallet.address,
  POLY_SIGNATURE: (await wallet.signTypedData(domain, types, {
    address: wallet.address,
    timestamp: String(Math.floor(Date.now() / 1000)),
    nonce: 0,
    message: 'This message attests that I control the given wallet',
  })),
  POLY_TIMESTAMP: String(Math.floor(Date.now() / 1000)),
  POLY_NONCE: '0',
};

// Delete old key
const delResp = await fetch('https://clob.polymarket.com/auth/api-key/' + process.env.CFO_POLYMARKET_API_KEY, {
  method: 'DELETE',
  headers: { ...l1hFresh, 'Content-Type': 'application/json' },
});
console.log('Delete old key:', delResp.status, await delResp.text());

// Now try creating new key
const ts2 = Math.floor(Date.now() / 1000);
const sig2 = await wallet.signTypedData(domain, types, {
  address: wallet.address,
  timestamp: String(ts2),
  nonce: 0,
  message: 'This message attests that I control the given wallet',
});
const createResp = await fetch('https://clob.polymarket.com/auth/api-key', {
  method: 'POST',
  headers: {
    POLY_ADDRESS: wallet.address,
    POLY_SIGNATURE: sig2,
    POLY_TIMESTAMP: String(ts2),
    POLY_NONCE: '0',
    'Content-Type': 'application/json',
  },
});
const createData = await createResp.json() as any;
console.log('Create new key:', createResp.status, createData.apiKey ? 'OK: ' + createData.apiKey : JSON.stringify(createData));

if (createData.apiKey) {
  console.log('\n=== NEW CREDENTIALS ===');
  console.log('API Key:', createData.apiKey);
  console.log('Secret:', createData.secret);
  console.log('Passphrase:', createData.passphrase);
  
  // Test the new key  
  const ts3 = String(Math.floor(Date.now() / 1000));
  let pre3 = ts3 + 'GET' + '/data/orders?market=&asset_id=&state=LIVE';
  const hmac3 = createHmac('sha256', Buffer.from(createData.secret, 'base64')).update(pre3).digest('base64');
  const sig3 = hmac3.replace(/\+/g, '-').replace(/\//g, '_');
  const testH = {
    POLY_ADDRESS: wallet.address,
    POLY_SIGNATURE: sig3,
    POLY_TIMESTAMP: ts3,
    POLY_API_KEY: createData.apiKey,
    POLY_PASSPHRASE: createData.passphrase,
    'Content-Type': 'application/json',
  };
  const testR = await fetch('https://clob.polymarket.com/data/orders?market=&asset_id=&state=LIVE', { headers: testH });
  const testD = await testR.json();
  console.log('New key test /data/orders:', testR.status, JSON.stringify(testD).slice(0, 300));
}
