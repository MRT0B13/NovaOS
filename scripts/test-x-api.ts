/**
 * Quick X API connectivity & rate-limit test
 * Usage: npx tsx scripts/test-x-api.ts
 * 
 * Tests:
 * 1. Auth (GET /2/users/me)
 * 2. Search (GET /2/tweets/search/recent) — checks read limits
 * 3. Tweet (POST /2/tweets) — optional, pass --tweet flag
 * 
 * Prints full rate-limit headers so we can confirm pay-per-use vs free tier.
 */

import 'dotenv/config';

const API_KEY = process.env.TWITTER_API_KEY || process.env.X_API_KEY || '';
const API_SECRET = process.env.TWITTER_API_SECRET_KEY || process.env.X_API_SECRET || '';
const ACCESS_TOKEN = process.env.TWITTER_ACCESS_TOKEN || process.env.X_ACCESS_TOKEN || '';
const ACCESS_SECRET = process.env.TWITTER_ACCESS_TOKEN_SECRET || process.env.X_ACCESS_SECRET || '';
const BEARER = process.env.TWITTER_BEARER_TOKEN || process.env.X_BEARER_TOKEN || '';

// ─── OAuth 1.0a signing ───────────────────────────────

import crypto from 'crypto';

function percentEncode(str: string): string {
  return encodeURIComponent(str)
    .replace(/!/g, '%21')
    .replace(/\*/g, '%2A')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
}

function buildOAuthHeader(method: string, url: string, params: Record<string, string> = {}): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: API_KEY,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: ACCESS_TOKEN,
    oauth_version: '1.0',
  };

  // Combine params for signature base
  const allParams = { ...params, ...oauthParams };
  const paramString = Object.keys(allParams)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(allParams[k])}`)
    .join('&');

  const signatureBase = `${method.toUpperCase()}&${percentEncode(url)}&${percentEncode(paramString)}`;
  const signingKey = `${percentEncode(API_SECRET)}&${percentEncode(ACCESS_SECRET)}`;
  const signature = crypto.createHmac('sha1', signingKey).update(signatureBase).digest('base64');

  oauthParams['oauth_signature'] = signature;

  return (
    'OAuth ' +
    Object.keys(oauthParams)
      .sort()
      .map((k) => `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`)
      .join(', ')
  );
}

// ─── Helpers ──────────────────────────────────────────

function printRateLimitHeaders(headers: Headers) {
  const interesting = [
    'x-rate-limit-limit',
    'x-rate-limit-remaining',
    'x-rate-limit-reset',
    'x-app-limit-24hour-limit',
    'x-app-limit-24hour-remaining',
    'x-app-limit-24hour-reset',
    'x-user-limit-24hour-limit',
    'x-user-limit-24hour-remaining',
    'x-user-limit-24hour-reset',
    'x-monthly-usage',
    'x-monthly-budget',
    'x-credits-remaining',
    'api-version',
  ];

  console.log('\n  Rate-Limit Headers:');
  let found = false;
  for (const [key, value] of headers.entries()) {
    if (key.startsWith('x-rate-limit') || key.startsWith('x-app-limit') || 
        key.startsWith('x-user-limit') || key.startsWith('x-monthly') ||
        key.startsWith('x-credits') || key === 'api-version') {
      const resetKey = key.includes('reset') ? ` (${new Date(parseInt(value) * 1000).toLocaleTimeString()})` : '';
      console.log(`    ${key}: ${value}${resetKey}`);
      found = true;
    }
  }
  if (!found) {
    // Print ALL headers for debugging
    console.log('    (No rate-limit headers found. All headers:)');
    for (const [key, value] of headers.entries()) {
      console.log(`    ${key}: ${value}`);
    }
  }
}

async function apiCall(method: string, url: string, queryParams?: Record<string, string>, body?: object) {
  let fullUrl = url;
  if (queryParams) {
    const qs = new URLSearchParams(queryParams).toString();
    fullUrl = `${url}?${qs}`;
  }

  const auth = buildOAuthHeader(method, url, queryParams || {});

  const options: RequestInit = {
    method,
    headers: {
      Authorization: auth,
      'Content-Type': 'application/json',
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(fullUrl, options);
  const json = await res.json();

  return { status: res.status, headers: res.headers, json };
}

// ─── Tests ────────────────────────────────────────────

async function testAuth() {
  console.log('═══════════════════════════════════════');
  console.log('TEST 1: Auth — GET /2/users/me');
  console.log('═══════════════════════════════════════');

  const { status, headers, json } = await apiCall('GET', 'https://api.x.com/2/users/me');
  console.log(`  Status: ${status}`);
  console.log(`  Response:`, JSON.stringify(json, null, 2));
  printRateLimitHeaders(headers);

  if (status === 200) {
    console.log(`\n  ✅ Auth OK — @${json.data?.username} (ID: ${json.data?.id})`);
  } else {
    console.log(`\n  ❌ Auth FAILED — ${json.title || json.detail || JSON.stringify(json)}`);
  }
  return status === 200;
}

async function testSearch() {
  console.log('\n═══════════════════════════════════════');
  console.log('TEST 2: Search — GET /2/tweets/search/recent');
  console.log('═══════════════════════════════════════');

  const { status, headers, json } = await apiCall('GET', 'https://api.x.com/2/tweets/search/recent', {
    query: 'solana memecoin -is:retweet lang:en',
    max_results: '10',
    'tweet.fields': 'created_at,author_id,public_metrics',
  });

  console.log(`  Status: ${status}`);
  if (status === 200) {
    const count = json.data?.length || 0;
    console.log(`  Got ${count} tweets`);
    if (json.data?.[0]) {
      console.log(`  Sample: "${json.data[0].text.substring(0, 100)}..."`);
    }
    console.log(`\n  ✅ Search OK`);
  } else {
    console.log(`  Response:`, JSON.stringify(json, null, 2));
    console.log(`\n  ❌ Search FAILED`);
  }
  printRateLimitHeaders(headers);
  return status === 200;
}

async function testTweet() {
  console.log('\n═══════════════════════════════════════');
  console.log('TEST 3: Tweet — POST /2/tweets');
  console.log('═══════════════════════════════════════');

  const testText = `🧪 API test — ${new Date().toISOString().slice(0, 19)}`;
  console.log(`  Posting: "${testText}"`);

  const { status, headers, json } = await apiCall('POST', 'https://api.x.com/2/tweets', undefined, {
    text: testText,
  });

  console.log(`  Status: ${status}`);
  console.log(`  Response:`, JSON.stringify(json, null, 2));
  printRateLimitHeaders(headers);

  if (status === 201) {
    console.log(`\n  ✅ Tweet posted! ID: ${json.data?.id}`);
    console.log(`  https://x.com/i/status/${json.data?.id}`);
  } else {
    console.log(`\n  ❌ Tweet FAILED`);
  }
  return status === 201;
}

async function testMentions(userId: string) {
  console.log('\n═══════════════════════════════════════');
  console.log('TEST 4: Mentions — GET /2/users/:id/mentions');
  console.log('═══════════════════════════════════════');

  const { status, headers, json } = await apiCall('GET', `https://api.x.com/2/users/${userId}/mentions`, {
    max_results: '5',
    'tweet.fields': 'created_at,author_id',
  });

  console.log(`  Status: ${status}`);
  if (status === 200) {
    const count = json.data?.length || 0;
    console.log(`  Got ${count} mentions`);
    console.log(`\n  ✅ Mentions OK`);
  } else {
    console.log(`  Response:`, JSON.stringify(json, null, 2));
    console.log(`\n  ❌ Mentions FAILED`);
  }
  printRateLimitHeaders(headers);
}

// ─── Main ─────────────────────────────────────────────

async function main() {
  console.log('X / Twitter API Test');
  console.log('────────────────────────────────────────');
  
  if (!API_KEY || !API_SECRET || !ACCESS_TOKEN || !ACCESS_SECRET) {
    console.error('❌ Missing credentials. Set TWITTER_API_KEY, TWITTER_API_SECRET_KEY, TWITTER_ACCESS_TOKEN, TWITTER_ACCESS_TOKEN_SECRET');
    process.exit(1);
  }

  console.log(`  API Key: ${API_KEY.slice(0, 6)}...${API_KEY.slice(-4)}`);
  console.log(`  Access Token: ${ACCESS_TOKEN.slice(0, 6)}...${ACCESS_TOKEN.slice(-4)}`);
  console.log('');

  // Test 1: Auth
  const authOk = await testAuth();
  if (!authOk) {
    console.log('\n⛔ Stopping — auth failed');
    process.exit(1);
  }

  // Test 2: Search (read endpoint)
  await testSearch();

  // Get user ID for mentions test
  const { json: meJson } = await apiCall('GET', 'https://api.x.com/2/users/me');
  const userId = meJson.data?.id;

  // Test 3: Mentions
  if (userId) {
    await testMentions(userId);
  }

  // Test 4: Tweet (only if --tweet flag passed)
  const doTweet = process.argv.includes('--tweet');
  if (doTweet) {
    await testTweet();
  } else {
    console.log('\n  ℹ️  Skipping tweet test (pass --tweet to post a test tweet)');
  }

  console.log('\n════════════════════════════════════════');
  console.log('DONE — Check rate-limit headers above.');
  console.log('  • x-rate-limit-limit > 1 → pay-per-use ✅');
  console.log('  • x-rate-limit-limit = 1 → free tier ❌');
  console.log('════════════════════════════════════════');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
