import 'dotenv/config';
import { ethers } from 'ethers';
import { createHmac } from 'crypto';

const wallet = new ethers.Wallet(process.env.CFO_EVM_PRIVATE_KEY!);
console.log('Wallet:', wallet.address);

async function getL1Headers() {
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
  return {
    POLY_ADDRESS: wallet.address,
    POLY_SIGNATURE: sig,
    POLY_TIMESTAMP: String(timestamp),
    POLY_NONCE: '0',
  };
}

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

// Step 1: List current keys
console.log('\n=== Step 1: List current API keys ===');
const l1 = await getL1Headers();
const listR = await fetch('https://clob.polymarket.com/auth/api-keys', { headers: { ...l1, 'Content-Type': 'application/json' } });
// Actually api-keys needs L2... use derive first
const deriveR = await fetch('https://clob.polymarket.com/auth/derive-api-key', { headers: l1 });
const derived = await deriveR.json() as any;
console.log('Current derived key:', derived.apiKey);

const listH = makeL2(derived.apiKey, derived.secret, derived.passphrase, 'GET', '/auth/api-keys');
const listResp = await fetch('https://clob.polymarket.com/auth/api-keys', { headers: listH });
const keys = await listResp.json() as any;
console.log('All keys:', JSON.stringify(keys));

// Step 2: Delete ALL existing keys
console.log('\n=== Step 2: Delete existing keys ===');
const keyList = keys.apiKeys || [];
for (const key of keyList) {
  console.log(`Deleting key: ${key}...`);
  const delL1 = await getL1Headers();
  const delResp = await fetch(`https://clob.polymarket.com/auth/api-key/${key}`, {
    method: 'DELETE',
    headers: { ...delL1, 'Content-Type': 'application/json' },
  });
  console.log(`  Status: ${delResp.status}`, await delResp.text());
}

// Step 3: Create fresh key via POST
console.log('\n=== Step 3: Create fresh API key ===');
// Small delay to ensure deletion propagated
await new Promise(r => setTimeout(r, 2000));

const createL1 = await getL1Headers();
const createResp = await fetch('https://clob.polymarket.com/auth/api-key', {
  method: 'POST',
  headers: { ...createL1, 'Content-Type': 'application/json' },
});
const newCreds = await createResp.json() as any;
console.log('Create status:', createResp.status);
if (newCreds.apiKey) {
  console.log('\n✓ NEW CREDENTIALS:');
  console.log(`  API Key:    ${newCreds.apiKey}`);
  console.log(`  Secret:     ${newCreds.secret}`);
  console.log(`  Passphrase: ${newCreds.passphrase}`);

  // Step 4: Test the new key
  console.log('\n=== Step 4: Test new key ===');
  await new Promise(r => setTimeout(r, 1000));

  const endpoints = [
    '/auth/api-keys',
    '/data/orders?market=&asset_id=&state=LIVE',
    '/balance-allowance?asset_type=COLLATERAL',
  ];
  for (const ep of endpoints) {
    const h = makeL2(newCreds.apiKey, newCreds.secret, newCreds.passphrase, 'GET', ep);
    const r = await fetch('https://clob.polymarket.com' + ep, { headers: h });
    const body = await r.text();
    console.log(`GET ${ep}: ${r.status} → ${body.slice(0, 200)}`);
  }

  console.log('\n=== UPDATE YOUR .env WITH: ===');
  console.log(`CFO_POLYMARKET_API_KEY="${newCreds.apiKey}"`);
  console.log(`CFO_POLYMARKET_API_SECRET="${newCreds.secret}"`);
  console.log(`CFO_POLYMARKET_PASSPHRASE="${newCreds.passphrase}"`);
} else {
  console.log('Failed to create key:', JSON.stringify(newCreds));
  
  // Fallback: re-derive and test
  console.log('\n=== Fallback: Re-derive and test ===');
  const reL1 = await getL1Headers();
  const reR = await fetch('https://clob.polymarket.com/auth/derive-api-key', { headers: reL1 });
  const reCreds = await reR.json() as any;
  console.log('Re-derived key:', reCreds.apiKey);
  
  if (reCreds.apiKey) {
    const endpoints = [
      '/auth/api-keys',
      '/data/orders?market=&asset_id=&state=LIVE',
      '/balance-allowance?asset_type=COLLATERAL',
    ];
    for (const ep of endpoints) {
      const h = makeL2(reCreds.apiKey, reCreds.secret, reCreds.passphrase, 'GET', ep);
      const r = await fetch('https://clob.polymarket.com' + ep, { headers: h });
      const body = await r.text();
      console.log(`GET ${ep}: ${r.status} → ${body.slice(0, 200)}`);
    }
    
    console.log('\n=== UPDATE YOUR .env WITH: ===');
    console.log(`CFO_POLYMARKET_API_KEY="${reCreds.apiKey}"`);
    console.log(`CFO_POLYMARKET_API_SECRET="${reCreds.secret}"`);
    console.log(`CFO_POLYMARKET_PASSPHRASE="${reCreds.passphrase}"`);
  }
}
