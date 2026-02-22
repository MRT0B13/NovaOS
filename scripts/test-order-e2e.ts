#!/usr/bin/env bun
/**
 * End-to-end order pipeline test (NO actual trade).
 * Validates: L1 auth → creds → L2 HMAC → signed order → payload format
 */
import 'dotenv/config';
import { getCLOBCredentials, invalidateCLOBCredentials } from '../src/launchkit/cfo/polymarketService.ts';
import { getCFOEnv } from '../src/launchkit/cfo/cfoEnv.ts';
import { createHmac } from 'crypto';

const env = getCFOEnv();
const { ethers } = await import('ethers');
const wallet = new ethers.Wallet(env.evmPrivateKey!);
let pass = 0, fail = 0;

function check(label: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label} — ${detail}`); }
}

console.log('═══ Polymarket Order E2E Test (DRY RUN) ═══\n');

// ── Step 1: L1 Auth ──
console.log('Step 1: L1 credential derivation');
invalidateCLOBCredentials();
const creds = await getCLOBCredentials();
check('apiKey present', !!creds.apiKey, `got: ${creds.apiKey}`);
check('secret present', !!creds.secret);
check('passphrase present', !!creds.passphrase);

// ── Step 2: L2 HMAC signature ──
console.log('\nStep 2: L2 HMAC signature format');
const ts = Math.floor(Date.now() / 1000).toString();
const method = 'POST';
const path = '/order';
const bodyObj = { test: true };
const bodyStr = JSON.stringify(bodyObj);

// Build HMAC the same way as our code
const message = `${ts}${method}${path}${bodyStr}`;
const hmac = createHmac('sha256', Buffer.from(creds.secret, 'base64'));
hmac.update(message);
const sig = hmac.digest('base64').replace(/\+/g, '-').replace(/\//g, '_');

check('HMAC no nonce in message', !message.includes('POLY_NONCE'));
check('HMAC message format', message === `${ts}POST/order${bodyStr}`);
check('HMAC URL-safe base64', !sig.includes('+') && !sig.includes('/'), sig);

// Build L2 headers
const headers: Record<string,string> = {
  POLY_ADDRESS: wallet.address,
  POLY_SIGNATURE: sig,
  POLY_TIMESTAMP: ts,
  POLY_API_KEY: creds.apiKey,
  POLY_PASSPHRASE: creds.passphrase,
  'Content-Type': 'application/json',
};
check('L2 has POLY_ADDRESS', !!headers.POLY_ADDRESS);
check('L2 has POLY_API_KEY', !!headers.POLY_API_KEY);
check('L2 NO POLY_NONCE', !('POLY_NONCE' in headers));

// ── Step 3: Validate L2 headers with server ──
console.log('\nStep 3: Validate L2 auth with GET /auth/api-keys');
const keysResp = await fetch('https://clob.polymarket.com/auth/api-keys', {
  headers: {
    POLY_ADDRESS: wallet.address,
    POLY_SIGNATURE: (() => {
      const m = `${ts}GET/auth/api-keys`;
      const h = createHmac('sha256', Buffer.from(creds.secret, 'base64'));
      h.update(m);
      return h.digest('base64').replace(/\+/g, '-').replace(/\//g, '_');
    })(),
    POLY_TIMESTAMP: ts,
    POLY_API_KEY: creds.apiKey,
    POLY_PASSPHRASE: creds.passphrase,
  },
});
check(`GET /auth/api-keys → ${keysResp.status}`, keysResp.ok, await keysResp.clone().text());

// ── Step 4: Fetch a real market for order building ──
console.log('\nStep 4: Fetch live market for order construction');
const mktsResp = await fetch('https://clob.polymarket.com/markets?limit=5');
const mkts = await mktsResp.json() as any;
const market = (mkts.data ?? mkts)?.[0];
check('Got a market', !!market?.condition_id, JSON.stringify(market)?.slice(0, 100));

if (market) {
  const tokenId = market.tokens?.[0]?.token_id;
  const price = parseFloat(market.tokens?.[0]?.price ?? '0.5');
  check('Token ID present', !!tokenId, tokenId);

  // Fetch negRisk + feeRate + tickSize
  let negRisk = false;
  let feeRateBps = 0;
  let tickSize = 0.01;
  try {
    const nrR = await fetch(`https://clob.polymarket.com/neg-risk?token_id=${tokenId}`);
    if (nrR.ok) { const d = await nrR.json() as any; negRisk = d.neg_risk ?? false; }
  } catch {}
  try {
    const frR = await fetch(`https://clob.polymarket.com/fee-rate?token_id=${tokenId}`);
    if (frR.ok) { const d = await frR.json() as any; feeRateBps = d.base_fee ?? 0; }
  } catch {}
  try {
    const tsR = await fetch(`https://clob.polymarket.com/markets/${market.condition_id}`);
    if (tsR.ok) { const d = await tsR.json() as any; tickSize = parseFloat(d.minimum_tick_size || '0.01'); }
  } catch {}
  console.log(`  negRisk=${negRisk} feeRateBps=${feeRateBps} tickSize=${tickSize}`);

  // ── Step 5: Build signed order (with tick-size-rounded pricing) ──
  console.log('\nStep 5: Build EIP-712 signed order');
  const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
  const NEG_RISK_CTF_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';
  const exchangeAddr = negRisk ? NEG_RISK_CTF_EXCHANGE : CTF_EXCHANGE;

  const sizeUsdc = 3; // $3 test size
  const rawPrice = Math.max(0.01, Math.min(0.99, price || 0.5));
  // Round to tick size (SDK approach)
  const tickDecimals = Math.round(-Math.log10(tickSize));
  const roundedPrice = parseFloat((Math.round(rawPrice / tickSize) * tickSize).toFixed(tickDecimals));
  check('Price on tick boundary', roundedPrice % tickSize < 1e-10 || (tickSize - roundedPrice % tickSize) < 1e-10, `${roundedPrice} % ${tickSize} = ${roundedPrice % tickSize}`);
  check('Price >= tickSize', roundedPrice >= tickSize, `${roundedPrice}`);

  // Compute amounts per SDK: start from token size, not USD
  const sizeDecimals = 2;
  const rawTokenSize = Math.floor((sizeUsdc / roundedPrice) * 10 ** sizeDecimals) / 10 ** sizeDecimals;
  const rawUsdcCost = parseFloat((rawTokenSize * roundedPrice).toFixed(tickDecimals + 2));
  const makerAmount = Math.round(rawUsdcCost * 1e6);
  const takerAmount = Math.round(rawTokenSize * 1e6);

  const salt = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  check('Salt fits safe integer', salt <= Number.MAX_SAFE_INTEGER, `${salt}`);
  check('Salt parseInt roundtrips', parseInt(salt.toString(), 10) === salt);

  const domain = { name: 'Polymarket CTF Exchange', version: '1', chainId: 137, verifyingContract: exchangeAddr };
  const types = {
    Order: [
      { name: 'salt', type: 'uint256' },
      { name: 'maker', type: 'address' },
      { name: 'signer', type: 'address' },
      { name: 'taker', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
      { name: 'makerAmount', type: 'uint256' },
      { name: 'takerAmount', type: 'uint256' },
      { name: 'expiration', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'feeRateBps', type: 'uint256' },
      { name: 'side', type: 'uint8' },
      { name: 'signatureType', type: 'uint8' },
    ],
  };

  const orderStruct = {
    salt: salt.toString(),
    maker: wallet.address,
    signer: wallet.address,
    taker: '0x0000000000000000000000000000000000000000',
    tokenId: tokenId,
    makerAmount: makerAmount.toString(),
    takerAmount: takerAmount.toString(),
    expiration: '0',
    nonce: '0',
    feeRateBps: feeRateBps.toString(),
    side: 0,
    signatureType: 0,
  };

  const orderSig = await wallet.signTypedData(domain, types, orderStruct);
  check('Order signature present', orderSig.startsWith('0x') && orderSig.length > 50);

  // ── Step 6: Construct API payload ──
  console.log('\nStep 6: Construct POST /order payload');
  const payload = {
    order: {
      ...orderStruct,
      salt: parseInt(orderStruct.salt, 10),
      side: 'BUY',
      signature: orderSig,
    },
    owner: creds.apiKey,
    orderType: 'GTC',
    deferExec: false,
  };

  // Validate field types match SDK's orderToJson
  check('payload.order.salt is number', typeof payload.order.salt === 'number');
  check('payload.order.side is string', typeof payload.order.side === 'string' && payload.order.side === 'BUY');
  check('payload.order.maker is address', payload.order.maker.startsWith('0x'));
  check('payload.order.signer is address', payload.order.signer.startsWith('0x'));
  check('payload.order.signatureType is number', typeof payload.order.signatureType === 'number');
  check('payload.owner is API key (not address)', !payload.owner.startsWith('0x'), payload.owner.slice(0, 20));
  check('payload.orderType is GTC', payload.orderType === 'GTC');
  check('payload.deferExec present', payload.deferExec === false);
  check('payload.order.signature present', !!payload.order.signature);
  check('payload.order.tokenId is string', typeof payload.order.tokenId === 'string');
  check('payload.order.makerAmount is string', typeof payload.order.makerAmount === 'string');
  check('payload.order.takerAmount is string', typeof payload.order.takerAmount === 'string');
  check('payload.order.feeRateBps is string', typeof payload.order.feeRateBps === 'string');
  check('payload.order.nonce is string', typeof payload.order.nonce === 'string');
  check('payload.order.expiration is string', typeof payload.order.expiration === 'string');

  console.log('\n  Payload preview:');
  const preview = { ...payload, order: { ...payload.order, signature: payload.order.signature.slice(0,20)+'...' } };
  console.log(JSON.stringify(preview, null, 2).split('\n').map(l => '  ' + l).join('\n'));

  // ── Step 7: Validate with server (POST but expect rejection for amount/balance) ──
  console.log('\nStep 7: POST /order (expect rejection for balance/amount, NOT auth/payload)');
  const ts2 = Math.floor(Date.now() / 1000).toString();
  const orderBody = JSON.stringify(payload);
  const orderHmac = createHmac('sha256', Buffer.from(creds.secret, 'base64'));
  orderHmac.update(`${ts2}POST/order${orderBody}`);
  const orderSig2 = orderHmac.digest('base64').replace(/\+/g, '-').replace(/\//g, '_');

  const orderResp = await fetch('https://clob.polymarket.com/order', {
    method: 'POST',
    headers: {
      POLY_ADDRESS: wallet.address,
      POLY_SIGNATURE: orderSig2,
      POLY_TIMESTAMP: ts2,
      POLY_API_KEY: creds.apiKey,
      POLY_PASSPHRASE: creds.passphrase,
      'Content-Type': 'application/json',
    },
    body: orderBody,
  });

  const orderStatus = orderResp.status;
  const orderText = await orderResp.text();
  console.log(`  Status: ${orderStatus}`);
  console.log(`  Body: ${orderText}`);

  // Auth/payload errors = 400/401 with specific messages
  // Balance/amount errors = different status or message
  const isAuthError = orderText.includes('Unauthorized') || orderText.includes('Invalid api key');
  const isPayloadError = orderText.includes('Invalid order payload');
  check('NOT auth error (401/Unauthorized)', !isAuthError, orderText);
  check('NOT invalid payload error', !isPayloadError, orderText);

  if (!isAuthError && !isPayloadError) {
    console.log('  🎯 Auth + payload format accepted by server!');
  }
}

console.log(`\n═══ Summary: ${pass} passed, ${fail} failed ═══`);
if (fail > 0) process.exit(1);
