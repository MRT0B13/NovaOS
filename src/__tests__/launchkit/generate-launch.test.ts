import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import bs58 from 'bs58';
import { startLaunchKitServer } from '../../launchkit/api/server.ts';
import { createInMemoryLaunchPackStore } from '../../launchkit/db/launchPackRepository.ts';
import { CopyGeneratorService } from '../../launchkit/services/copyGenerator.ts';
import { PumpLauncherService, generateMintKeypair } from '../../launchkit/services/pumpLauncher.ts';
import { LaunchPackCreateInput } from '../../launchkit/model/launchPack.ts';
import { IAgentRuntime } from '@elizaos/core';

const adminToken = 'test-admin-token';

const baseInput: LaunchPackCreateInput = {
  brand: {
    name: 'Meme King',
    ticker: 'KING',
    tagline: 'Rule the memes',
    description: 'A token for meme royalty',
    lore: 'Forged in the depths of the internet',
  },
  links: {
    telegram: 'https://t.me/memeking',
  },
  assets: {
    logo_url: 'https://example.com/logo.png',
  },
  launch: {
    status: 'draft',
  },
};

describe('generateMintKeypair', () => {
  it('returns 64-byte secret and 32-byte mint address', () => {
    const { secret, publicKey } = generateMintKeypair();
    const secretBytes = bs58.decode(secret);
    const publicBytes = bs58.decode(publicKey);
    expect(secretBytes.length).toBe(64);
    expect(publicBytes.length).toBe(32);
    expect(Array.from(secretBytes.slice(32))).toEqual(Array.from(publicBytes));
  });
});

function createRuntimeMock(): IAgentRuntime {
  return {
    useModel: mock(async ({ prompt }) => typeof prompt === 'string' ? `LLM: ${prompt.slice(0, 12)}` : 'LLM'),
  } as any;
}

describe('LaunchKit generate + launch endpoints', () => {
  const store = createInMemoryLaunchPackStore();
  const runtime = createRuntimeMock();
  const copyService = new CopyGeneratorService(store, runtime);

  const walletResponse = {
    apiKey: 'api-key',
    wallet: 'wallet123',
    walletSecret: bs58.encode(new Uint8Array(64).fill(7)),
  };
  const ipfsResponse = { metadataUri: 'ipfs://meta' };
  const tradeResponse = { signature: 'sig123' };

  let server: Awaited<ReturnType<typeof startLaunchKitServer>>;
  let packId: string;
  let originalFetch: typeof fetch;

  beforeAll(async () => {
    const created = await store.create(baseInput);
    packId = created.id;
    originalFetch = global.fetch;
    // default LAUNCH_ENABLE false for first test
    process.env.LAUNCH_ENABLE = 'false';

    const mockSecretsStore = { get: async () => null, save: async () => {} } as any;

    server = await startLaunchKitServer({
      port: 0,
      adminToken,
      store,
      runtime,
      copyService,
      pumpService: new PumpLauncherService(store, {
        maxDevBuy: 0.1,
        maxPriorityFee: 0.0005,
        maxLaunchesPerDay: 3,
      }, mockSecretsStore),
    });
  });

  afterAll(async () => {
    await server.close();
    global.fetch = originalFetch;
  });

  it('generates launch copy and sets checklist flags', async () => {
    const res = await fetch(`${server.baseUrl}/v1/launchpacks/${packId}/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ADMIN-TOKEN': adminToken,
      },
      body: JSON.stringify({ theme: 'cats' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.tg.pins.welcome).toBeTruthy();
    expect(body.data.ops.checklist.copy_ready).toBe(true);
    expect(body.data.ops.checklist.tg_ready).toBe(true);
    expect(body.data.ops.checklist.x_ready).toBe(true);
  });

  it('launch endpoint returns 403 when disabled', async () => {
    const res = await fetch(`${server.baseUrl}/v1/launchpacks/${packId}/launch`, {
      method: 'POST',
      headers: {
        'X-ADMIN-TOKEN': adminToken,
      },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('LAUNCH_DISABLED');
  });

  it('rejects invalid launch pack id', async () => {
    const res = await fetch(`${server.baseUrl}/v1/launchpacks/not-a-uuid/launch`, {
      method: 'POST',
      headers: {
        'X-ADMIN-TOKEN': adminToken,
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_ID');
  });

  it('returns CAP_EXCEEDED when caps are violated', async () => {
    process.env.LAUNCH_ENABLE = 'true';
    process.env.MAX_SOL_DEV_BUY = '1.0'; // above cap 0.1
    process.env.MAX_PRIORITY_FEE = '0.01'; // above cap 0.0005

    const res = await fetch(`${server.baseUrl}/v1/launchpacks/${packId}/launch`, {
      method: 'POST',
      headers: {
        'X-ADMIN-TOKEN': adminToken,
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('CAP_EXCEEDED');
    expect(body.error.details).toBeDefined();
  });

  it('returns MINT_MISMATCH when pump portal responds with a different mint', async () => {
    const extraPack = await store.create({ ...baseInput, brand: { ...baseInput.brand, ticker: 'MINTMIS' } });

    process.env.LAUNCH_ENABLE = 'true';
    process.env.MAX_SOL_DEV_BUY = '0.05';
    process.env.MAX_PRIORITY_FEE = '0.0002';

    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith(server.baseUrl)) {
        return originalFetch(input as any, init);
      }
      if (url.includes('example.com/logo.png')) {
        const blob = new Blob(['logo'], { type: 'image/png' });
        return new Response(blob, { status: 200 });
      }
      if (url.includes('create-wallet')) {
        return new Response(JSON.stringify(walletResponse), { status: 200 });
      }
      if (url.includes('/api/ipfs')) {
        return new Response(JSON.stringify(ipfsResponse), { status: 200 });
      }
      if (url.includes('/api/trade')) {
        return new Response(JSON.stringify({ signature: 'sig123', mint: 'bad-mint' }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as any as typeof fetch;
    global.fetch = fetchMock;

    const res = await fetch(`${server.baseUrl}/v1/launchpacks/${extraPack.id}/launch`, {
      method: 'POST',
      headers: {
        'X-ADMIN-TOKEN': adminToken,
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('MINT_MISMATCH');
    expect(body.error.details).toBeDefined();
    expect(body.error.details.received).toBe('bad-mint');
  });

  it('returns SLIPPAGE_INVALID when slippage exceeds configured cap', async () => {
    process.env.LAUNCH_ENABLE = 'true';
    process.env.MAX_SOL_DEV_BUY = '0.05';
    process.env.MAX_PRIORITY_FEE = '0.0002';
    process.env.LAUNCH_SLIPPAGE_PERCENT = '50';
    process.env.MAX_SLIPPAGE_PERCENT = '1';

    const slippagePack = await store.create({
      ...baseInput,
      brand: { ...baseInput.brand, ticker: 'SLIPBAD' },
    });

    const res = await fetch(`${server.baseUrl}/v1/launchpacks/${slippagePack.id}/launch`, {
      method: 'POST',
      headers: {
        'X-ADMIN-TOKEN': adminToken,
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('SLIPPAGE_INVALID');
    expect(body.error.details).toBeDefined();
    expect(body.error.details.slippage).toBe(50);
    expect(body.error.details.max).toBe(1);

    process.env.LAUNCH_SLIPPAGE_PERCENT = '10';
    delete process.env.MAX_SLIPPAGE_PERCENT;
  });

  it('uploads logo using "file" field with socials metadata', async () => {
    process.env.LAUNCH_ENABLE = 'true';
    process.env.MAX_SOL_DEV_BUY = '0.05';
    process.env.MAX_PRIORITY_FEE = '0.0002';

    const linkedPack = await store.create({
      ...baseInput,
      brand: { ...baseInput.brand, ticker: 'FILE1' },
      links: {
        telegram: 'https://t.me/memeking',
        x: 'https://x.com/memeking',
        website: 'https://memeking.io',
      },
    });

    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith(server.baseUrl)) {
        return originalFetch(input as any, init);
      }
      if (url.includes('example.com/logo.png')) {
        const blob = new Blob(['logo'], { type: 'image/png' });
        return new Response(blob, { status: 200 });
      }
      if (url.includes('/api/ipfs')) {
        const body = init?.body as FormData;
        expect(body instanceof FormData).toBe(true);
        expect(body.has('file')).toBe(true);
        expect(body.has('image')).toBe(false);
        expect(body.get('showName')).toBe('true');
        expect(body.get('twitter')).toBe('https://x.com/memeking');
        expect(body.get('telegram')).toBe('https://t.me/memeking');
        expect(body.get('website')).toBe('https://memeking.io');
        return new Response(JSON.stringify({ metadataUri: 'ipfs://meta' }), { status: 200 });
      }
      if (url.includes('create-wallet')) {
        return new Response(JSON.stringify(walletResponse), { status: 200 });
      }
      if (url.includes('/api/trade')) {
        return new Response(JSON.stringify(tradeResponse), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as any as typeof fetch;
    global.fetch = fetchMock;

    const res = await fetch(`${server.baseUrl}/v1/launchpacks/${linkedPack.id}/launch`, {
      method: 'POST',
      headers: {
        'X-ADMIN-TOKEN': adminToken,
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.launch.status).toBe('launched');
  });

  it('fails when logo stream exceeds limit without content-length', async () => {
    process.env.LAUNCH_ENABLE = 'true';
    const bigPack = await store.create({
      ...baseInput,
      brand: { ...baseInput.brand, ticker: 'BIGLOGO' },
    });

    const hugeChunk = new Uint8Array(8 * 1024 * 1024 + 1);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(hugeChunk);
        controller.close();
      },
    });

    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith(server.baseUrl)) {
        return originalFetch(input as any, init);
      }
      if (url.includes('example.com/logo.png')) {
        return new Response(stream, { status: 200, headers: { 'content-type': 'image/png' } });
      }
      if (url.includes('create-wallet')) {
        return new Response(JSON.stringify(walletResponse), { status: 200 });
      }
      if (url.includes('/api/ipfs')) {
        return new Response(JSON.stringify(ipfsResponse), { status: 200 });
      }
      if (url.includes('/api/trade')) {
        return new Response(JSON.stringify(tradeResponse), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as any as typeof fetch;
    global.fetch = fetchMock;

    const res = await fetch(`${server.baseUrl}/v1/launchpacks/${bigPack.id}/launch`, {
      method: 'POST',
      headers: { 'X-ADMIN-TOKEN': adminToken },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('LOGO_FETCH_FAILED');
    expect(body.error.details).toBeDefined();
    expect(body.error.details.maxBytes).toBeGreaterThan(0);
    expect(body.error.details.downloadedBytes).toBeGreaterThan(body.error.details.maxBytes);
  });

  it('rejects launch when logo is missing', async () => {
    process.env.LAUNCH_ENABLE = 'true';
    const noLogo = await store.create({
      ...baseInput,
      brand: { ...baseInput.brand, ticker: 'NOLOGO' },
      assets: {},
    });

    const res = await fetch(`${server.baseUrl}/v1/launchpacks/${noLogo.id}/launch`, {
      method: 'POST',
      headers: { 'X-ADMIN-TOKEN': adminToken },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('LOGO_REQUIRED');
  });

  it('launch endpoint performs happy path and is idempotent', async () => {
    process.env.LAUNCH_ENABLE = 'true';
    process.env.MAX_SOL_DEV_BUY = '0.05';
    process.env.MAX_PRIORITY_FEE = '0.0002';

    // mock fetch sequence: create-wallet, ipfs, trade
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith(server.baseUrl)) {
        return originalFetch(input as any, init);
      }
      if (url.includes('example.com/logo.png')) {
        const blob = new Blob(['logo'], { type: 'image/png' });
        return new Response(blob, { status: 200 });
      }
      if (url.includes('create-wallet')) {
        return new Response(JSON.stringify(walletResponse), { status: 200 });
      }
      if (url.includes('/api/ipfs')) {
        return new Response(JSON.stringify(ipfsResponse), { status: 200 });
      }
      if (url.includes('/api/trade')) {
        const parsed = init?.body ? JSON.parse(init.body as any) : {};
        expect(parsed.slippage).toBe(10);
        return new Response(JSON.stringify(tradeResponse), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as any as typeof fetch;
    global.fetch = fetchMock;

    const res = await fetch(`${server.baseUrl}/v1/launchpacks/${packId}/launch`, {
      method: 'POST',
      headers: {
        'X-ADMIN-TOKEN': adminToken,
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.launch.status).toBe('launched');
    expect(body.data.launch.tx_signature).toBe('sig123');

    const second = await fetch(`${server.baseUrl}/v1/launchpacks/${packId}/launch`, {
      method: 'POST',
      headers: {
        'X-ADMIN-TOKEN': adminToken,
      },
    });
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.data.launch.status).toBe('launched');
  });

  it('only allows one concurrent launch claim to proceed', async () => {
    process.env.LAUNCH_ENABLE = 'true';
    process.env.MAX_SOL_DEV_BUY = '0.05';
    process.env.MAX_PRIORITY_FEE = '0.0002';

    const localStore = createInMemoryLaunchPackStore();
    const baseClaim = localStore.claimLaunch.bind(localStore);
    let waiting = 0;
    let release: () => void = () => {};
    const barrier = new Promise<void>((res) => {
      release = res;
    });
    localStore.claimLaunch = async (id, fields) => {
      waiting += 1;
      if (waiting === 2) release();
      await barrier;
      return baseClaim(id, fields);
    };
    const created = await localStore.create({ ...baseInput, brand: { ...baseInput.brand, ticker: 'RACE' } });
    const mockSecretsStore = { get: async () => null, save: async () => {} } as any;
    const pump = new PumpLauncherService(localStore, {
      maxDevBuy: 0.1,
      maxPriorityFee: 0.001,
      maxLaunchesPerDay: 3,
    }, mockSecretsStore);

    (pump as any).ensureLauncherWallet = async () => ({ apiKey: 'k', wallet: 'w' });
    (pump as any).uploadMetadataToPumpIPFS = async () => 'ipfs://meta';
    (pump as any).createTokenOnPumpPortal = async (pack: any) => ({
      ...pack,
      launch: {
        ...(pack.launch || {}),
        status: 'launched',
        mint: 'mint123',
        tx_signature: 'sig123',
        pump_url: 'https://pump.fun/tx/sig123',
        launched_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      },
      ops: pack.ops,
    });

    const [first, second] = await Promise.allSettled([pump.launch(created.id), pump.launch(created.id)]);
    const fulfilled = [first, second].filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled');
    const rejected = [first, second].filter((r): r is PromiseRejectedResult => r.status === 'rejected');

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect((rejected[0].reason as any).code).toBe('LAUNCH_IN_PROGRESS');
  });
});
