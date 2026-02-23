import 'dotenv/config';
import { ethers } from 'ethers';
import { createHmac } from 'crypto';

const wallet = new ethers.Wallet(process.env.CFO_EVM_PRIVATE_KEY!);

// Always derive fresh creds via L1 (env creds may not work locally)
console.log('Deriving CLOB creds via L1...');
const timestamp = Math.floor(Date.now() / 1000);
const domain = { name: 'ClobAuthDomain', version: '1', chainId: 137 };
const types = { ClobAuth: [
  { name: 'address', type: 'address' },
  { name: 'timestamp', type: 'string' },
  { name: 'nonce', type: 'uint256' },
  { name: 'message', type: 'string' },
]};
const sig = await wallet.signTypedData(domain, types, {
  address: wallet.address, timestamp: String(timestamp), nonce: 0,
  message: 'This message attests that I control the given wallet',
});
const l1h = { POLY_ADDRESS: wallet.address, POLY_SIGNATURE: sig, POLY_TIMESTAMP: String(timestamp), POLY_NONCE: '0' };

// Try POST first, then derive
let credsData: any;
const r0 = await fetch('https://clob.polymarket.com/auth/api-key', {
  method: 'POST',
  headers: { ...l1h, 'Content-Type': 'application/json' },
});
if (r0.ok) {
  credsData = await r0.json();
  console.log('L1 POST /auth/api-key:', r0.status, 'OK');
} else {
  console.log('L1 POST failed:', r0.status, '- trying derive...');
  const r1 = await fetch('https://clob.polymarket.com/auth/derive-api-key', { headers: l1h });
  credsData = await r1.json();
  console.log('L1 GET /auth/derive-api-key:', r1.status, credsData.apiKey ? 'OK' : JSON.stringify(credsData));
}

const creds = { apiKey: credsData.apiKey, secret: credsData.secret, passphrase: credsData.passphrase };

function l2(method: string, path: string, body?: string) {
  const ts = String(Math.floor(Date.now() / 1000));
  let pre = ts + method + path;
  if (body) pre += body;
  const hmac = createHmac('sha256', Buffer.from(creds.secret, 'base64')).update(pre).digest('base64');
  const s = hmac.replace(/\+/g, '-').replace(/\//g, '_');
  return { POLY_ADDRESS: wallet.address, POLY_SIGNATURE: s, POLY_TIMESTAMP: ts, POLY_API_KEY: creds.apiKey, POLY_PASSPHRASE: creds.passphrase, 'Content-Type': 'application/json' };
}

// Open LIVE orders
const oP = '/data/orders?market=&asset_id=&state=LIVE';
const r2 = await fetch('https://clob.polymarket.com' + oP, { headers: l2('GET', oP) });
const orders = await r2.json() as any;
if (!Array.isArray(orders)) {
  console.log('Orders response:', JSON.stringify(orders).slice(0, 500));
} else {
  console.log(`\nOpen LIVE orders: ${orders.length}`);
  let totalLocked = 0;
  for (const o of orders) {
    const locked = parseFloat(o.original_size || '0') * parseFloat(o.price || '0');
    totalLocked += locked;
    console.log(`  ${o.side} sz=${o.original_size} @${o.price} $locked=${locked.toFixed(2)}`);
  }
  console.log(`  Total locked: ~$${totalLocked.toFixed(2)}`);
  console.log(`  Free balance: ~$${(54.05 - totalLocked).toFixed(2)}`);
}

// MATCHED orders
const mP = '/data/orders?market=&asset_id=&state=MATCHED';
const r3 = await fetch('https://clob.polymarket.com' + mP, { headers: l2('GET', mP) });
const matched = await r3.json() as any;
console.log(`\nMATCHED orders: ${Array.isArray(matched) ? matched.length : JSON.stringify(matched).slice(0,200)}`);
if (Array.isArray(matched)) {
  for (const o of matched.slice(0, 10)) {
    console.log(`  ${o.side} matched=${o.size_matched} @${o.price}`);
  }
}

// Search Alibaba on Gamma (use text_query which is more reliable)
const queries = [
  'https://gamma-api.polymarket.com/markets?closed=false&limit=5&title=Alibaba%20third-best%20AI',
  'https://gamma-api.polymarket.com/markets?closed=false&limit=5&title=Alibaba%20AI%20model',
  'https://gamma-api.polymarket.com/markets?closed=false&limit=5&question=Alibaba',
];
for (const url of queries) {
  const g = await fetch(url);
  const gd = await g.json() as any[];
  if (Array.isArray(gd) && gd.length > 0) {
    console.log(`\nGamma results from: ${url.split('?')[1]}`);
    for (const m of gd) {
      console.log(`  Q: ${m.question}`);
      console.log(`    neg_risk: ${m.neg_risk} | condition: ${m.conditionId?.slice(0,30)} | tick: ${m.minimum_tick_size}`);
      // Check CLOB neg_risk too
      try {
        const tokens = JSON.parse(m.clobTokenIds || '[]');
        if (tokens.length > 0) {
          const nrP = `/neg-risk?token_id=${tokens[0]}`;
          const nrR = await fetch('https://clob.polymarket.com' + nrP, { headers: l2('GET', nrP) });
          const nrD = await nrR.json();
          console.log(`    CLOB neg_risk: ${JSON.stringify(nrD)}`);
        }
      } catch {}
    }
    break;
  }
}
