#!/usr/bin/env bun
/**
 * Polymarket Position Tracking Diagnostic
 *
 * Tests all position-fetching paths to identify why CFO reports $0.00 deployed.
 */
import 'dotenv/config';

const CLOB_BASE = 'https://clob.polymarket.com';
const GAMMA_BASE = 'https://gamma-api.polymarket.com';

async function main() {
  console.log('\n=== Polymarket Position Diagnostic ===\n');

  // 1. Check env vars
  const pk = process.env.CFO_EVM_PRIVATE_KEY;
  const proxyAddr = process.env.CFO_POLY_PROXY_ADDRESS;
  const polyEnabled = process.env.CFO_POLYMARKET_ENABLE;
  const apiKey = process.env.CFO_POLYMARKET_API_KEY;
  const apiSecret = process.env.CFO_POLYMARKET_API_SECRET;
  const passphrase = process.env.CFO_POLYMARKET_PASSPHRASE;

  console.log('CFO_POLYMARKET_ENABLE:', polyEnabled ?? '(not set)');
  console.log('CFO_EVM_PRIVATE_KEY:', pk ? `${pk.slice(0, 6)}...${pk.slice(-4)}` : '(not set)');
  console.log('CFO_POLY_PROXY_ADDRESS:', proxyAddr ?? '(not set)');
  console.log('CFO_POLYMARKET_API_KEY:', apiKey ? `${apiKey.slice(0, 8)}...` : '(not set)');
  console.log('CFO_POLYMARKET_API_SECRET:', apiSecret ? '(set)' : '(not set)');
  console.log('CFO_POLYMARKET_PASSPHRASE:', passphrase ? '(set)' : '(not set)');

  if (!pk) {
    console.error('\n❌ CFO_EVM_PRIVATE_KEY not set — cannot proceed');
    process.exit(1);
  }

  // 2. Derive wallet address
  const { ethers } = await import('ethers');
  const wallet = new ethers.Wallet(pk);
  console.log('\nEOA wallet address:', wallet.address);

  // 3. Test unauthenticated CLOB API
  console.log('\n--- Test 1: CLOB /data/positions?user=<EOA> (no auth) ---');
  try {
    const resp = await fetch(`${CLOB_BASE}/data/positions?user=${wallet.address}`);
    console.log('Status:', resp.status, resp.statusText);
    const body = await resp.text();
    console.log('Body (first 500):', body.slice(0, 500));
  } catch (err) {
    console.error('Error:', (err as Error).message);
  }

  // 4. Test with proxy address (if set)
  if (proxyAddr) {
    console.log(`\n--- Test 2: CLOB /data/positions?user=<PROXY> (no auth) ---`);
    try {
      const resp = await fetch(`${CLOB_BASE}/data/positions?user=${proxyAddr}`);
      console.log('Status:', resp.status, resp.statusText);
      const body = await resp.text();
      console.log('Body (first 500):', body.slice(0, 500));
    } catch (err) {
      console.error('Error:', (err as Error).message);
    }
  }

  // 5. Test CLOB /data/positions (no user param, authed)
  if (apiKey && apiSecret && passphrase) {
    console.log('\n--- Test 3: CLOB /data/positions (authed, no user param) ---');
    try {
      const { createHmac } = await import('crypto');
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const path = '/data/positions';
      const message = `${timestamp}GET${path}`;
      const hmac = createHmac('sha256', Buffer.from(apiSecret, 'base64'));
      hmac.update(message);
      const sig = hmac.digest('base64').replace(/\+/g, '-').replace(/\//g, '_');

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        POLY_ADDRESS: wallet.address,
        POLY_SIGNATURE: sig,
        POLY_TIMESTAMP: timestamp,
        POLY_API_KEY: apiKey,
        POLY_PASSPHRASE: passphrase,
      };

      const resp = await fetch(`${CLOB_BASE}${path}`, { headers });
      console.log('Status:', resp.status, resp.statusText);
      const body = await resp.text();
      console.log('Body (first 500):', body.slice(0, 500));
    } catch (err) {
      console.error('Error:', (err as Error).message);
    }
  }

  // 6. Test Gamma API for positions (alternative path)
  console.log(`\n--- Test 4: Gamma API /positions?user=<EOA> ---`);
  try {
    const resp = await fetch(`${GAMMA_BASE}/positions?user=${wallet.address}`);
    console.log('Status:', resp.status, resp.statusText);
    const body = await resp.text();
    console.log('Body (first 500):', body.slice(0, 500));
  } catch (err) {
    console.error('Error:', (err as Error).message);
  }

  if (proxyAddr) {
    console.log(`\n--- Test 5: Gamma API /positions?user=<PROXY> ---`);
    try {
      const resp = await fetch(`${GAMMA_BASE}/positions?user=${proxyAddr}`);
      console.log('Status:', resp.status, resp.statusText);
      const body = await resp.text();
      console.log('Body (first 500):', body.slice(0, 500));
    } catch (err) {
      console.error('Error:', (err as Error).message);
    }
  }

  // 7. Try to determine the proxy wallet address on-chain
  console.log('\n--- Test 6: Polymarket proxy wallet lookup ---');
  // Polymarket's ProxyWalletFactory on Polygon
  // getSafeAddress(owner) returns the proxy wallet for a given EOA
  const RPC = process.env.CFO_POLYGON_RPC_URL ?? 'https://polygon-rpc.com';
  const PROXY_FACTORY = '0xaB45c5A4B0c941a2F231C04C3f49182e1A254052'; // Polymarket proxy factory
  try {
    const provider = new ethers.JsonRpcProvider(RPC);
    const factory = new ethers.Contract(PROXY_FACTORY, [
      'function getAddress(address owner) view returns (address)',
    ], provider);
    const proxyWallet = await factory.getAddress(wallet.address);
    console.log('Derived proxy wallet:', proxyWallet);

    // Check if proxy is deployed
    const code = await provider.getCode(proxyWallet);
    console.log('Proxy deployed:', code.length > 2 ? 'YES' : 'NO (not yet created)');

    // Query positions with proxy address
    if (code.length > 2) {
      console.log(`\n--- Test 7: CLOB /data/positions?user=<derived proxy> ---`);
      const resp = await fetch(`${CLOB_BASE}/data/positions?user=${proxyWallet}`);
      console.log('Status:', resp.status, resp.statusText);
      const body = await resp.text();
      console.log('Body (first 500):', body.slice(0, 500));
    }
  } catch (err) {
    console.error('Proxy lookup failed:', (err as Error).message);
  }

  // 8. Test the actual fetchPositions function
  console.log('\n--- Test 8: Full fetchPositions() via polymarketService ---');
  try {
    const polyMod = await import('../src/launchkit/cfo/polymarketService.ts');
    const positions = await polyMod.fetchPositions();
    console.log('Positions found:', positions.length);
    for (const p of positions) {
      console.log(`  - ${p.question} [${p.outcome}] size=${p.size} val=$${p.currentValueUsd.toFixed(2)}`);
    }
    const deployed = await polyMod.getTotalDeployed();
    console.log('Total deployed:', `$${deployed.toFixed(2)}`);
  } catch (err) {
    console.error('fetchPositions error:', (err as Error).message);
  }

  console.log('\n=== Done ===\n');
}

main().catch(console.error);
