import 'dotenv/config';
import { ethers } from 'ethers';
import { createHmac } from 'crypto';

const wallet = new ethers.Wallet(process.env.CFO_EVM_PRIVATE_KEY!);
console.log('Wallet:', wallet.address);

// ── L1 auth ──
async function getL1() {
  const ts = Math.floor(Date.now() / 1000);
  const sig = await wallet.signTypedData(
    { name: 'ClobAuthDomain', version: '1', chainId: 137 },
    { ClobAuth: [
      { name: 'address', type: 'address' }, { name: 'timestamp', type: 'string' },
      { name: 'nonce', type: 'uint256' }, { name: 'message', type: 'string' },
    ]},
    { address: wallet.address, timestamp: String(ts), nonce: 0,
      message: 'This message attests that I control the given wallet' }
  );
  return { POLY_ADDRESS: wallet.address, POLY_SIGNATURE: sig, POLY_TIMESTAMP: String(ts), POLY_NONCE: '0' };
}

// Derive creds
const l1 = await getL1();
const r0 = await fetch('https://clob.polymarket.com/auth/derive-api-key', { headers: l1 });
const creds = await r0.json() as any;
console.log('API key:', creds.apiKey);

function l2(method: string, path: string, body?: string) {
  const ts = String(Math.floor(Date.now() / 1000));
  let pre = ts + method + path;
  if (body) pre += body;
  const hmac = createHmac('sha256', Buffer.from(creds.secret, 'base64')).update(pre).digest('base64');
  const sig = hmac.replace(/\+/g, '-').replace(/\//g, '_');
  return { POLY_ADDRESS: wallet.address, POLY_SIGNATURE: sig, POLY_TIMESTAMP: ts,
    POLY_API_KEY: creds.apiKey, POLY_PASSPHRASE: creds.passphrase, 'Content-Type': 'application/json' };
}

// ── 1. Check CLOB balance-allowance (no query params—avoids HMAC issue) ──
console.log('\n=== CLOB Balance/Allowance Check ===');
const balPaths = [
  '/balance-allowance',
  '/collateral-balance',
];
for (const p of balPaths) {
  try {
    const r = await fetch('https://clob.polymarket.com' + p, { headers: l2('GET', p) });
    console.log(`GET ${p}: ${r.status} → ${(await r.text()).slice(0, 300)}`);
  } catch (e) { console.log(`${p}: ERROR ${(e as Error).message}`); }
}

// ── 2. Check on-chain state ──
console.log('\n=== On-chain State ===');
const provider = new ethers.JsonRpcProvider(process.env.CFO_POLYGON_RPC_URL);
const USDC = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const CTF_EX = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const NR_EX = '0xC5d563A36AE78145C45a50134d48A1215220f80a';
const CT = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const NR_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';

const erc20 = new ethers.Contract(USDC, [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
], provider);
const ct = new ethers.Contract(CT, [
  'function isApprovedForAll(address,address) view returns (bool)',
], provider);

const [bal, aCTF, aNR, aNRA, ctCTF, ctNR, ctNRA] = await Promise.all([
  erc20.balanceOf(wallet.address),
  erc20.allowance(wallet.address, CTF_EX),
  erc20.allowance(wallet.address, NR_EX),
  erc20.allowance(wallet.address, NR_ADAPTER),
  ct.isApprovedForAll(wallet.address, CTF_EX),
  ct.isApprovedForAll(wallet.address, NR_EX),
  ct.isApprovedForAll(wallet.address, NR_ADAPTER),
]);
console.log('USDC.e bal:', ethers.formatUnits(bal, 6));
console.log('USDC.e → CTF Exchange:', aCTF > 1000000000n ? 'MAX ✓' : ethers.formatUnits(aCTF, 6));
console.log('USDC.e → NegRisk Exchange:', aNR > 1000000000n ? 'MAX ✓' : ethers.formatUnits(aNR, 6));
console.log('USDC.e → NegRisk Adapter:', aNRA > 1000000000n ? 'MAX ✓' : ethers.formatUnits(aNRA, 6) + ' ⚠️');
console.log('CT → CTF Exchange:', ctCTF ? '✓' : '✗');
console.log('CT → NegRisk Exchange:', ctNR ? '✓' : '✗');
console.log('CT → NegRisk Adapter:', ctNRA ? '✓' : '✗ ⚠️');

// ── 3. Check the failing markets via Gamma ──
console.log('\n=== Failing Market Analysis ===');
const queries = [
  'I Can Only Imagine 2',
  'Alibaba third-best AI model',
];
for (const q of queries) {
  const url = `https://gamma-api.polymarket.com/markets?closed=false&limit=3&question=${encodeURIComponent(q)}`;
  const r = await fetch(url);
  const markets = await r.json() as any[];
  if (!Array.isArray(markets) || markets.length === 0) {
    console.log(`\n"${q}": NOT FOUND on Gamma`);
    continue;
  }
  const m = markets[0];
  console.log(`\n"${q}":`);
  console.log('  Question:', m.question);
  console.log('  conditionId:', m.conditionId);
  console.log('  neg_risk:', m.neg_risk);
  console.log('  min_tick:', m.minimum_tick_size);
  console.log('  active:', m.active, '| closed:', m.closed);
  
  // Check neg_risk via CLOB
  const tokens = JSON.parse(m.clobTokenIds || '[]');
  if (tokens.length > 0) {
    const nrPath = `/neg-risk?token_id=${tokens[0]}`;
    const nrR = await fetch('https://clob.polymarket.com' + nrPath);
    const nrD = await nrR.json();
    console.log('  CLOB neg_risk:', JSON.stringify(nrD));
    
    // Check market details on CLOB
    const mkPath = `/markets/${tokens[0]}`;
    const mkR = await fetch('https://clob.polymarket.com' + mkPath);
    if (mkR.ok) {
      const mkD = await mkR.json() as any;
      console.log('  CLOB market active:', mkD.active, '| accepting_orders:', mkD.accepting_orders);
      console.log('  CLOB min_tick:', mkD.minimum_tick_size, '| min_order_size:', mkD.minimum_order_size);
    }
  }
}

// ── 4. Check a previously SUCCESSFUL market for comparison ──
console.log('\n=== Successful Market Comparison ===');
const r_orders = await fetch('https://clob.polymarket.com/data/orders', { headers: l2('GET', '/data/orders') });
const ordersData = await r_orders.json() as any;
const orders = ordersData.data || ordersData;
if (Array.isArray(orders) && orders.length > 0) {
  const o = orders[0];
  console.log('Working order asset_id:', o.asset_id?.slice(0, 40) + '...');
  console.log('Working order side:', o.side, '| size:', o.original_size, '| price:', o.price);
  console.log('Working order maker:', o.maker_address);
  console.log('Working order owner:', o.owner);
  
  // Check neg_risk for this working market
  const nrPath = `/neg-risk?token_id=${o.asset_id}`;
  const nrR = await fetch('https://clob.polymarket.com' + nrPath);
  const nrD = await nrR.json();
  console.log('Working order neg_risk:', JSON.stringify(nrD));
}

// ── 5. Try order on a working market vs failing market ──
console.log('\n=== Dry-Run Order Comparison ===');
// Check if there's a /order/check or similar endpoint
const checkPaths = ['/order/check', '/orders/check', '/order/validate'];
for (const p of checkPaths) {
  const r = await fetch('https://clob.polymarket.com' + p, { method: 'POST', headers: l2('POST', p, '{}'), body: '{}' });
  console.log(`POST ${p}: ${r.status}`);
}
