import { logger } from '@elizaos/core';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { nowIso } from './time.ts';
import { appendAudit } from './audit.ts';
import { LaunchPack, LaunchPackUpdateInput } from '../model/launchPack.ts';
import { LaunchPackStore } from '../db/launchPackRepository.ts';
import type { SecretsStore } from './secrets.ts';
import { getEnv } from '../env.ts';
import { redactSensitive } from './redact.ts';
import { getPumpWalletBalance, getFundingWalletBalance, depositToPumpWallet } from './fundingWallet.ts';
import { schedulePostLaunchMarketing, createMarketingSchedule } from './xScheduler.ts';
import { announceLaunch } from './novaChannel.ts';
import { recordBuy } from './pnlTracker.ts';

interface PumpLauncherOptions {
  maxDevBuy: number;
  maxPriorityFee: number;
  maxLaunchesPerDay: number;
}

interface WalletRecord {
  apiKey: string;
  wallet: string;
  walletSecret: string;
}

interface CapsResult {
  maxDevBuy: number;
  maxPriorityFee: number;
  maxLaunchesPerDay: number;
  requestedDevBuy: number;
  requestedPriority: number;
}

const MAX_LOGO_BYTES = 8 * 1024 * 1024; // 8MB ceiling for logo downloads
const LOGO_FETCH_TOTAL_TIMEOUT_MS = 20000;
const LOGO_FETCH_CONNECT_TIMEOUT_MS = 10000;

async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  totalTimeoutMs = LOGO_FETCH_TOTAL_TIMEOUT_MS,
  connectTimeoutMs = LOGO_FETCH_CONNECT_TIMEOUT_MS
) {
  const controller = new AbortController();
  let abortReason: 'connect' | 'total' | null = null;
  let connectTimer: NodeJS.Timeout | null = null;
  let totalTimer: NodeJS.Timeout | null = null;

  const clearTimers = () => {
    if (connectTimer) clearTimeout(connectTimer);
    if (totalTimer) clearTimeout(totalTimer);
  };

  const onConnectTimeout = () => {
    if (controller.signal.aborted) return;
    abortReason = 'connect';
    controller.abort();
  };

  const onTotalTimeout = () => {
    if (controller.signal.aborted) return;
    abortReason = 'total';
    controller.abort();
  };

  totalTimer = setTimeout(onTotalTimeout, totalTimeoutMs);
  connectTimer = setTimeout(onConnectTimeout, connectTimeoutMs);

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    // Once headers arrive, connection is established; clear the connect timer.
    if (connectTimer) {
      clearTimeout(connectTimer);
      connectTimer = null;
    }
    return response;
  } catch (error) {
    if ((error as any)?.name === 'AbortError') {
      if (abortReason === 'connect') {
        throw errorWithCode('LOGO_FETCH_FAILED', 'Logo fetch connect timeout', {
          timeoutMs: connectTimeoutMs,
        });
      }
      if (abortReason === 'total') {
        throw errorWithCode('LOGO_FETCH_FAILED', 'Logo fetch total timeout', {
          timeoutMs: totalTimeoutMs,
        });
      }
      throw errorWithCode('LOGO_FETCH_FAILED', 'Logo fetch aborted');
    }
    throw error;
  } finally {
    clearTimers();
  }
}

async function readStreamWithLimit(res: Response, maxBytes: number) {
  if (!res.body) {
    const buf = await res.arrayBuffer();
    if (buf.byteLength > maxBytes) {
      throw errorWithCode('LOGO_FETCH_FAILED', 'Logo exceeds max size', {
        downloadedBytes: buf.byteLength,
        maxBytes,
      });
    }
    return new Uint8Array(buf);
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        reader.cancel().catch(() => undefined);
        throw errorWithCode('LOGO_FETCH_FAILED', 'Logo exceeds max size', {
          downloadedBytes: total,
          maxBytes,
        });
      }
      chunks.push(value);
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function errorWithCode(code: string, message: string, details?: unknown) {
  const err = new Error(message);
  (err as any).code = code;
  if (details) (err as any).details = details;
  return err;
}

export function generateMintKeypair(): { secret: string; publicKey: string } {
  const kp = Keypair.generate();
  if (kp.secretKey.length !== 64) {
    throw errorWithCode('MINT_KEYPAIR_INVALID', 'Mint secretKey must be 64 bytes');
  }
  const publicBytes = kp.publicKey.toBytes();
  if (publicBytes.length !== 32) {
    throw errorWithCode('MINT_KEYPAIR_INVALID', 'Mint publicKey must be 32 bytes');
  }

  const secret = bs58.encode(kp.secretKey);
  const publicKey = kp.publicKey.toBase58();

  // sanity: ensure bs58 round-trip lengths are correct
  const secretLen = bs58.decode(secret).length;
  const publicLen = bs58.decode(publicKey).length;
  if (secretLen !== 64 || publicLen !== 32) {
    throw errorWithCode('MINT_KEYPAIR_INVALID', 'Mint encoding lengths invalid');
  }
  return { secret, publicKey };
}

async function safeJson(res: Response) {
  try {
    return await res.json();
  } catch (err) {
    return null;
  }
}

export class PumpLauncherService {
  constructor(private store: LaunchPackStore, private options: PumpLauncherOptions, private secretsStore: SecretsStore) {}

  async ensureLauncherWallet(): Promise<WalletRecord> {
    const saved = await this.secretsStore.get();
    if (saved?.apiKey && saved?.wallet && saved?.walletSecret) {
      return saved;
    }

    const res = await fetchWithTimeout('https://pumpportal.fun/api/create-wallet');
    if (!res.ok) {
      throw new Error(`Failed to create launcher wallet (${res.status})`);
    }

    const body = await safeJson(res) || {};
    const apiKey = (body as any).apiKey;
    const wallet = (body as any).wallet || (body as any).publicKey || (body as any).address;
    const walletSecret =
      (body as any).privateKey ||
      (body as any).secretKey ||
      (body as any).walletSecret ||
      (body as any).private_key;

    const missingKeys: string[] = [];
    if (!apiKey) missingKeys.push('apiKey');
    if (!wallet) missingKeys.push('wallet');
    if (!walletSecret) missingKeys.push('walletSecret');
    if (missingKeys.length) {
      throw errorWithCode('INVALID_WALLET_RESPONSE', 'Invalid wallet response', { missingKeys });
    }

    let decoded: Uint8Array;
    try {
      decoded = bs58.decode(walletSecret);
    } catch (err) {
      throw errorWithCode('WALLET_SECRET_INVALID', 'Wallet secret is not valid base58');
    }
    if (decoded.length !== 64) {
      throw errorWithCode('WALLET_SECRET_INVALID', 'Wallet secret must decode to 64 bytes', {
        length: decoded.length,
      });
    }

    const record: WalletRecord = { apiKey, wallet, walletSecret };
    await this.secretsStore.set(record);
    return record;
  }

  /**
   * FAILSAFE: Validate critical launch requirements before proceeding
   * This ensures all required details are properly configured
   */
  private validateLaunchRequirements(pack: LaunchPack, options?: { skipTelegramCheck?: boolean }): void {
    const missingRequirements: string[] = [];
    const warnings: string[] = [];

    // === CRITICAL REQUIREMENTS ===
    // These MUST be present or launch is blocked
    
    // 1. Brand details must be complete
    if (!pack.brand?.name?.trim()) {
      missingRequirements.push('Token name is missing');
    }
    if (!pack.brand?.ticker?.trim()) {
      missingRequirements.push('Token ticker is missing');
    }
    if (pack.brand?.ticker && (pack.brand.ticker.length < 1 || pack.brand.ticker.length > 12)) {
      missingRequirements.push('Token ticker must be 1-12 characters');
    }

    // 2. Logo is required for pump.fun
    if (!pack.assets?.logo_url?.trim()) {
      missingRequirements.push('Token logo URL is missing');
    }

    // 3. Description should be present (pump.fun shows it)
    if (!pack.brand?.description?.trim() && !pack.brand?.tagline?.trim()) {
      warnings.push('No description or tagline set - will use default');
    }

    // === TELEGRAM VALIDATION (unless skipped) ===
    if (!options?.skipTelegramCheck) {
      const env = getEnv();
      const tgEnabled = env.TG_ENABLE === 'true';
      
      if (tgEnabled) {
        // If Telegram is enabled, check if setup is complete
        const hasTelegramLink = Boolean(pack.links?.telegram);
        const hasTelegramChatId = Boolean(pack.tg?.telegram_chat_id || pack.tg?.chat_id);
        const telegramVerified = Boolean(pack.tg?.verified);

        if (hasTelegramLink && !hasTelegramChatId && !telegramVerified) {
          // Has link but not linked/verified - this is a problem
          missingRequirements.push('Telegram group link provided but not verified - add bot to group first');
        }

        // Warn if no Telegram at all
        if (!hasTelegramLink && !hasTelegramChatId) {
          warnings.push('No Telegram group configured - token will launch without TG community link');
        }
      }
    }

    // === SOCIAL LINKS VALIDATION ===
    // Warn if no social links at all (affects pump.fun display)
    if (!pack.links?.telegram && !pack.links?.x && !pack.links?.website) {
      warnings.push('No social links configured - token will have no links on pump.fun');
    }

    // Log warnings (non-blocking)
    if (warnings.length > 0) {
      logger.warn({ warnings, packId: pack.id }, '[PumpLauncher] Launch warnings');
    }

    // Throw error if critical requirements missing
    if (missingRequirements.length > 0) {
      logger.error({ missingRequirements, packId: pack.id }, '[PumpLauncher] Launch blocked - missing requirements');
      throw errorWithCode('LAUNCH_REQUIREMENTS_MISSING', 
        `Cannot launch: ${missingRequirements.join('; ')}`, 
        { missingRequirements, warnings, packId: pack.id }
      );
    }
  }

  private async ensureLaunchAllowed(pack: LaunchPack, forceRetry?: boolean): Promise<LaunchPack> {
    const env = getEnv();
    const kill = env.launchEnabled;
    if (!kill) {
      const err = new Error('Launch disabled');
      (err as any).code = 'LAUNCH_DISABLED';
      throw err;
    }

    if (pack.launch?.status === 'launched') {
      const err = new Error('Already launched');
      (err as any).code = 'ALREADY_LAUNCHED';
      throw err;
    }
    
    // Check for stale "in progress" launches (older than 5 minutes = likely crashed)
    // Note: After the above check, TypeScript narrows status type, so we cast to string for comparison
    const currentStatus = pack.launch?.status as string | undefined;
    if (pack.launch?.requested_at && currentStatus !== 'failed' && currentStatus !== 'launched') {
      const requestedAt = new Date(pack.launch.requested_at).getTime();
      const now = Date.now();
      const staleLockMs = 5 * 60 * 1000; // 5 minutes
      
      if (now - requestedAt < staleLockMs) {
        const err = new Error('Launch in progress');
        (err as any).code = 'LAUNCH_IN_PROGRESS';
        throw err;
      } else {
        // Lock is stale - clear it in database and allow retry
        logger.warn(`[PumpLauncher] Stale launch lock detected (requested ${Math.round((now - requestedAt) / 1000)}s ago), clearing lock...`);
        const cleared = await this.store.update(pack.id, {
          launch: { ...pack.launch, requested_at: undefined, status: 'failed', failed_at: pack.launch.requested_at }
        });
        logger.info(`[PumpLauncher] ✅ Stale lock cleared, proceeding with retry`);
        return cleared; // Return updated pack
      }
    }

    if (pack.launch?.status === 'failed' && !forceRetry) {
      const failedAt = pack.launch.failed_at ? new Date(pack.launch.failed_at).getTime() : 0;
      const now = Date.now();
      const diffMs = now - failedAt;
      const cooldownMs = 10 * 60 * 1000;
      if (!failedAt || diffMs < cooldownMs) {
        const err = new Error('Previous launch failed; retry blocked');
        (err as any).code = 'LAUNCH_FAILED_RETRY_BLOCKED';
        throw err;
      }
    }
    
    return pack; // Return pack unchanged if no stale lock
  }

  /**
   * Count how many launches happened today (UTC)
   */
  private async countTodayLaunches(): Promise<number> {
    const packs = await this.store.list();
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    
    let count = 0;
    for (const pack of packs) {
      if (pack.launch?.status === 'launched' && pack.launch?.launched_at) {
        const launchDate = new Date(pack.launch.launched_at);
        if (launchDate >= todayStart) {
          count++;
        }
      }
    }
    
    logger.info('[PumpLauncher] Today\'s launches: ' + count);
    return count;
  }

  private async enforceCaps(): Promise<CapsResult> {
    const env = getEnv();
    const maxDevBuy = this.options.maxDevBuy;
    const maxPriorityFee = this.options.maxPriorityFee;
    const maxLaunchesPerDay = this.options.maxLaunchesPerDay;
    if (isNaN(maxDevBuy) || isNaN(maxPriorityFee) || isNaN(maxLaunchesPerDay)) {
      const err = new Error('Launch caps not configured');
      (err as any).code = 'CAP_EXCEEDED';
      throw err;
    }
    const requestedDevBuy = Number(env.MAX_SOL_DEV_BUY || maxDevBuy);
    const requestedPriority = Number(env.MAX_PRIORITY_FEE || maxPriorityFee);
    if (requestedDevBuy > maxDevBuy || requestedPriority > maxPriorityFee) {
      const err = new Error('Caps exceeded');
      (err as any).code = 'CAP_EXCEEDED';
      (err as any).details = {
        maxDevBuy,
        requestedDevBuy,
        maxPriorityFee,
        requestedPriority,
      };
      throw err;
    }
    
    // Check daily launch limit
    if (maxLaunchesPerDay > 0) {
      const todayCount = await this.countTodayLaunches();
      if (todayCount >= maxLaunchesPerDay) {
        const err = new Error('Daily launch limit reached. Try again tomorrow (UTC).');
        (err as any).code = 'DAILY_LIMIT_REACHED';
        (err as any).details = {
          maxLaunchesPerDay,
          launchesToday: todayCount,
        };
        logger.warn('[PumpLauncher] Daily limit reached: ' + todayCount + '/' + maxLaunchesPerDay);
        throw err;
      }
      logger.info('[PumpLauncher] Daily limit check passed: ' + todayCount + '/' + maxLaunchesPerDay);
    }
    
    return { maxDevBuy, maxPriorityFee, maxLaunchesPerDay, requestedDevBuy, requestedPriority };
  }

  private resolveSlippage(): number {
    const env = getEnv();
    const raw = env.LAUNCH_SLIPPAGE_PERCENT ?? 10;
    const capRaw = env.MAX_SLIPPAGE_PERCENT;
    const value = Number(raw);
    const cap = capRaw !== undefined ? Number(capRaw) : undefined;

    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw errorWithCode('SLIPPAGE_INVALID', 'Slippage percent must be between 0 and 100', {
        slippage: raw,
      });
    }

    if (cap !== undefined) {
      if (!Number.isFinite(cap) || cap < 0 || cap > 100) {
        throw errorWithCode('SLIPPAGE_INVALID', 'MAX_SLIPPAGE_PERCENT must be between 0 and 100', {
          cap: capRaw,
        });
      }
      if (value > cap) {
        throw errorWithCode('SLIPPAGE_INVALID', 'Slippage exceeds configured maximum', {
          slippage: value,
          max: cap,
        });
      }
    }

    return Math.floor(value);
  }

  private buildPumpUrl(sig?: string) {
    if (!sig) return undefined;
    return `https://pump.fun/tx/${sig}`;
  }

  async uploadMetadataToPumpIPFS(pack: LaunchPack): Promise<string> {
    if (!pack.assets?.logo_url) {
      throw errorWithCode('LOGO_REQUIRED', 'Token logo is required');
    }

    const form = new FormData();
    form.append('name', pack.brand.name);
    form.append('symbol', pack.brand.ticker);
    form.append('description', pack.brand.description || pack.brand.tagline || '');
    form.append('showName', 'true');
    if (pack.links?.x) form.append('twitter', pack.links.x);
    if (pack.links?.telegram) form.append('telegram', pack.links.telegram);
    if (pack.links?.website) form.append('website', pack.links.website);

    if (pack.assets?.logo_url) {
      const logoUrl = pack.assets.logo_url;
      const response = await fetchWithTimeout(logoUrl, { redirect: 'follow' });
      if (!response.ok) {
        throw errorWithCode('LOGO_FETCH_FAILED', `Failed to fetch logo (${response.status})`, {
          status: response.status,
        });
      }
      const contentLength = Number(response.headers.get('content-length') || 0);
      if (contentLength && contentLength > MAX_LOGO_BYTES) {
        throw errorWithCode('LOGO_FETCH_FAILED', 'Logo exceeds max size', {
          contentLength,
          maxBytes: MAX_LOGO_BYTES,
        });
      }
      const bodyBytes = await readStreamWithLimit(response, MAX_LOGO_BYTES);
      const urlNoFragment = logoUrl.split('#')[0];
      const urlNoQuery = urlNoFragment.split('?')[0];
      let filename = urlNoQuery.split('/').pop() || '';
      if (!filename || !filename.includes('.')) filename = 'logo.png';
      const mime = response.headers.get('content-type') || 'image/png';
      const blob = new Blob([bodyBytes], { type: mime });
      form.append('file', new File([blob], filename, { type: mime }));
    }

    // Try pump.fun first, fallback to Bonk's IPFS service if blocked
    // First try pump.fun's IPFS endpoint
    try {
      const res = await fetch('https://pump.fun/api/ipfs', {
        method: 'POST',
        body: form,
        headers: {
          'Accept': 'application/json',
          'Origin': 'https://pump.fun',
          'Referer': 'https://pump.fun/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      });
      
      if (res.ok) {
        const body = await safeJson(res);
        const uri = body?.metadataUri || body?.uri;
        if (uri) {
          logger.info({ uri }, 'IPFS upload via pump.fun succeeded');
          return uri as string;
        }
      }
      
      const status = res.status;
      logger.warn({ status }, 'pump.fun IPFS failed, trying Bonk fallback...');
      
      // If blocked by Cloudflare (403) or server error, try Bonk's IPFS service
      if (status === 403 || status >= 500) {
        return await this.uploadToBonkIPFS(pack);
      }
      
      throw new Error(`IPFS upload failed (${status})`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      
      // If pump.fun failed, use Bonk's IPFS as fallback (free, no API key needed)
      if (errMsg.includes('403') || errMsg.includes('blocked') || errMsg.includes('Cloudflare')) {
        logger.warn({ error: errMsg }, 'pump.fun IPFS blocked, falling back to Bonk IPFS');
        return await this.uploadToBonkIPFS(pack);
      }
      
      throw err;
    }
  }

  /**
   * Upload metadata to Bonk's IPFS service (free fallback when pump.fun is blocked)
   * Uses letsbonk's Cloudflare Worker - no API key needed
   */
  private async uploadToBonkIPFS(pack: LaunchPack): Promise<string> {
    if (!pack.assets?.logo_url) {
      throw errorWithCode('LOGO_REQUIRED', 'Token logo is required');
    }

    // First, fetch and upload the image
    const logoUrl = pack.assets.logo_url;
    const logoResponse = await fetchWithTimeout(logoUrl, { redirect: 'follow' });
    if (!logoResponse.ok) {
      throw errorWithCode('LOGO_FETCH_FAILED', `Failed to fetch logo (${logoResponse.status})`);
    }
    const logoBytes = await readStreamWithLimit(logoResponse, MAX_LOGO_BYTES);
    const mime = logoResponse.headers.get('content-type') || 'image/png';
    
    // Upload image to Bonk's IPFS
    const imageForm = new FormData();
    const blob = new Blob([logoBytes], { type: mime });
    imageForm.append('image', new File([blob], 'logo.png', { type: mime }));
    
    const imageRes = await fetch('https://nft-storage.letsbonk22.workers.dev/upload/img', {
      method: 'POST',
      body: imageForm,
    });
    
    if (!imageRes.ok) {
      const errText = await imageRes.text().catch(() => '');
      throw new Error(`Bonk IPFS image upload failed (${imageRes.status}): ${errText}`);
    }
    
    const imageUri = await imageRes.text();
    if (!imageUri || !imageUri.includes('ipfs')) {
      throw new Error('Bonk IPFS returned invalid image URI');
    }
    
    logger.info({ imageUri }, 'Image uploaded to Bonk IPFS');
    
    // Now upload metadata JSON
    // Note: Bonk's service only allows specific createdOn values (bonk.fun)
    // This is just metadata and doesn't affect pump.fun token functionality
    const metadata = {
      name: pack.brand.name,
      symbol: pack.brand.ticker,
      description: pack.brand.description || pack.brand.tagline || '',
      image: imageUri,
      createdOn: 'https://bonk.fun', // Required by Bonk's IPFS service
      ...(pack.links?.x && { twitter: pack.links.x }),
      ...(pack.links?.telegram && { telegram: pack.links.telegram }),
      ...(pack.links?.website && { website: pack.links.website }),
    };
    
    const metadataRes = await fetch('https://nft-storage.letsbonk22.workers.dev/upload/meta', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(metadata),
    });
    
    if (!metadataRes.ok) {
      const errText = await metadataRes.text().catch(() => '');
      throw new Error(`Bonk IPFS metadata upload failed (${metadataRes.status}): ${errText}`);
    }
    
    const metadataUri = await metadataRes.text();
    if (!metadataUri || !metadataUri.includes('ipfs')) {
      throw new Error('Bonk IPFS returned invalid metadata URI');
    }
    
    logger.info({ metadataUri }, 'Metadata uploaded to Bonk IPFS');
    
    return metadataUri;
  }

  async createTokenOnPumpPortal(
    pack: LaunchPack,
    metadataUri: string,
    caps: CapsResult,
    wallet: WalletRecord,
    slippagePercent: number
  ): Promise<LaunchPack> {
    const devBuy = caps.requestedDevBuy;
    const priorityFee = caps.requestedPriority;

    const { secret: mintSecret, publicKey: mintPublic } = generateMintKeypair();
    const body = {
      action: 'create',
      tokenMetadata: {
        name: pack.brand.name,
        symbol: pack.brand.ticker,
        uri: metadataUri,
      },
      denominatedInSol: 'true',
      amount: devBuy,
      slippage: slippagePercent,
      priorityFee,
      pool: 'pump',
      mint: mintSecret,
    };

    const res = await fetch(`https://pumpportal.fun/api/trade?api-key=${wallet.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const resJson = await safeJson(res);
    console.log('[DEBUG] Pump.fun response:', { status: res.status, body: resJson });
    if (!res.ok) {
      const err = new Error(resJson?.error || `Launch failed (${res.status})`);
      (err as any).code = 'LAUNCH_FAILED';
      throw err;
    }

    const sig = resJson?.signature || resJson?.tx || resJson?.txSignature;
    const returnedMint: string | undefined = resJson?.mint;
    console.log('[DEBUG] Extracted from response:', { sig, returnedMint, mintPublic });
    if (returnedMint && returnedMint !== mintPublic) {
      throw errorWithCode('MINT_MISMATCH', 'Mint mismatch returned from pump portal', {
        expected: mintPublic,
        received: returnedMint,
      });
    }
    const mint = returnedMint || mintPublic;
    let mintLen = 0;
    try {
      mintLen = bs58.decode(mint).length;
    } catch (err) {
      throw errorWithCode('MINT_MISMATCH', 'Mint base58 decoding failed');
    }
    if (mintLen !== 32) {
      throw errorWithCode('MINT_MISMATCH', 'Mint length invalid', { length: mintLen });
    }

    // Build dev_buy info for transparency
    const devBuyInfo = devBuy > 0 ? {
      enabled: true,
      amount_sol: devBuy,
      tokens_received: undefined, // Will be filled by on-chain query if needed
      disclosed: true, // Always disclosed for transparency
    } : undefined;

    return {
      ...pack,
      launch: {
        ...(pack.launch || {}),
        status: 'launched',
        tx_signature: sig,
        mint,
        pump_url: this.buildPumpUrl(sig),
        completed_at: nowIso(),
        launched_at: nowIso(),
        requested_at: pack.launch?.requested_at || nowIso(),
        dev_buy: devBuyInfo,
        error_code: undefined,
        error_message: undefined,
      },
      ops: {
        ...(pack.ops || {}),
        audit_log: appendAudit(pack.ops?.audit_log, `Pump launch complete${devBuy > 0 ? ` (dev buy: ${devBuy} SOL)` : ''}`, 'eliza'),
      },
    } as LaunchPack;
  }

  async launch(id: string, options?: { force?: boolean; skipTelegramCheck?: boolean }): Promise<LaunchPack> {
    let existing = await this.store.get(id);
    if (!existing) throw new Error('LaunchPack not found');

    if (existing.launch?.status === 'launched') {
      return existing;
    }

    // === FAILSAFE: Validate all requirements BEFORE proceeding ===
    // This prevents launching with incomplete/incorrect details
    logger.info(`[Launch] Running pre-launch validation for pack ${id}...`);
    this.validateLaunchRequirements(existing, { skipTelegramCheck: options?.skipTelegramCheck || options?.force });
    logger.info(`[Launch] ✅ Pre-launch validation passed`);

    // Check if launch allowed - may clear stale locks and return updated pack
    existing = await this.ensureLaunchAllowed(existing, options?.force);
    const caps = await this.enforceCaps();
    const slippagePercent = this.resolveSlippage();

    // === WALLET BALANCE CHECK ===
    // Required: devBuy + priorityFee + buffer for tx fees
    const requiredSol = caps.requestedDevBuy + (caps.requestedPriority / 1_000_000) + 0.05; // +0.05 buffer
    logger.info(`[Launch] Required SOL for launch: ${requiredSol.toFixed(4)}`);

    let pumpBalance: number;
    try {
      pumpBalance = await getPumpWalletBalance();
      logger.info(`[Launch] Current pump wallet balance: ${pumpBalance.toFixed(4)} SOL`);
    } catch (err: any) {
      throw errorWithCode('WALLET_CHECK_FAILED', `Failed to check pump wallet balance: ${err.message}`);
    }

    if (pumpBalance < requiredSol) {
      // Try to auto-fund from agent's funding wallet
      const deficit = requiredSol - pumpBalance + 0.1; // Add extra buffer
      logger.info(`[Launch] Insufficient funds. Need ${deficit.toFixed(4)} more SOL. Attempting auto-fund...`);

      try {
        const fundingWallet = await getFundingWalletBalance();
        logger.info(`[Launch] Funding wallet balance: ${fundingWallet.balance.toFixed(4)} SOL`);

        if (fundingWallet.balance < deficit + 0.01) {
          throw errorWithCode(
            'INSUFFICIENT_FUNDS',
            `Insufficient funds for launch.\n` +
            `• Pump wallet: ${pumpBalance.toFixed(4)} SOL\n` +
            `• Funding wallet: ${fundingWallet.balance.toFixed(4)} SOL\n` +
            `• Required: ${requiredSol.toFixed(4)} SOL\n\n` +
            `Please fund your agent wallet (${fundingWallet.address}) with at least ${(deficit + 0.01).toFixed(4)} SOL.`
          );
        }

        // Auto-deposit to pump wallet
        logger.info(`[Launch] Auto-depositing ${deficit.toFixed(4)} SOL to pump wallet...`);
        const depositResult = await depositToPumpWallet(deficit);
        logger.info(`[Launch] ✅ Auto-funded pump wallet. New balance: ${depositResult.balance.toFixed(4)} SOL`);
        pumpBalance = depositResult.balance;
      } catch (err: any) {
        if (err.code === 'INSUFFICIENT_FUNDS') throw err;
        throw errorWithCode(
          'AUTO_FUND_FAILED',
          `Launch requires ${requiredSol.toFixed(4)} SOL but pump wallet only has ${pumpBalance.toFixed(4)} SOL.\n` +
          `Auto-funding failed: ${err.message}\n\n` +
          `Please manually deposit SOL to your pump wallet or funding wallet.`
        );
      }
    }

    logger.info(`[Launch] ✅ Wallet check passed. Proceeding with launch...`);

    // atomic claim
    const requestedAt = nowIso();
    console.log('[DEBUG] Claiming launch with requested_at:', requestedAt);
    const claimed = await this.store.claimLaunch(id, { requested_at: requestedAt, status: 'ready' });
    if (!claimed) {
      const err = new Error('Launch in progress');
      (err as any).code = 'LAUNCH_IN_PROGRESS';
      throw err;
    }
    console.log('[DEBUG] Claimed launch object:', JSON.stringify(claimed.launch, null, 2));
    const withRequested = claimed;

    try {
      const wallet = await this.ensureLauncherWallet();
      const metadataUri = await this.uploadMetadataToPumpIPFS(withRequested);
      const launched = await this.createTokenOnPumpPortal(
        withRequested,
        metadataUri,
        caps,
        wallet,
        slippagePercent
      );
      
      // DEBUG: Log the launch object before saving
      logger.info(`[Launch] DEBUG: launched.launch = ${JSON.stringify(launched.launch)}`);
      
      const saved = await this.store.update(id, {
        launch: launched.launch,
        ops: launched.ops,
      });
      
      // DEBUG: Verify the saved object has correct status
      logger.info(`[Launch] DEBUG: saved.launch.status = "${saved.launch?.status}", mint = "${saved.launch?.mint}"`);
      if (saved.launch?.status !== 'launched') {
        logger.error(`[Launch] BUG DETECTED: Status should be 'launched' but is '${saved.launch?.status}'! Auto-correcting...`);
        // Auto-correct the status
        await this.store.update(id, {
          launch: {
            ...saved.launch,
            status: 'launched',
          },
        });
        logger.info(`[Launch] Status auto-corrected to 'launched'`);
      }

      // === RECORD IN PNL TRACKER ===
      // Track the dev buy as a cost basis for this token
      if (launched.launch?.dev_buy?.enabled && launched.launch?.dev_buy?.amount_sol && launched.launch?.mint) {
        try {
          await recordBuy({
            tokenMint: launched.launch.mint,
            tokenTicker: saved.brand?.ticker,
            tokenName: saved.brand?.name,
            tokenAmount: launched.launch.dev_buy.tokens_received || 0, // Will be 0 if not tracked
            solSpent: launched.launch.dev_buy.amount_sol,
            isLaunchBuy: true,
            signature: launched.launch.tx_signature,
            launchPackId: id,
          });
          logger.info(`[Launch] PnL tracker: Recorded dev buy of ${launched.launch.dev_buy.amount_sol} SOL for $${saved.brand?.ticker}`);
        } catch (pnlErr) {
          logger.warn(`[Launch] Failed to record dev buy in PnL tracker: ${pnlErr}`);
        }
      }

      // === AUTO-SCHEDULE MARKETING TWEETS ===
      // If X is enabled, schedule post-launch marketing tweets
      const env = getEnv();
      if (env.X_ENABLE === 'true') {
        try {
          const scheduled = await schedulePostLaunchMarketing(saved, 7); // 7 days of tweets
          await createMarketingSchedule(saved, 3); // 3 tweets per week ongoing
          
          // Save marketing info to database for recovery
          await this.store.update(id, {
            ops: {
              ...(saved.ops || {}),
              x_marketing_enabled: true,
              x_marketing_tweets_per_week: 3,
              x_marketing_total_tweeted: 0,
              x_marketing_created_at: nowIso(),
              x_marketing_scheduled_count: scheduled.length,
            },
          });
          
          logger.info(`[Launch] ✅ Auto-scheduled ${scheduled.length} marketing tweets for $${saved.brand?.ticker}`);
        } catch (scheduleErr) {
          // Non-fatal - launch succeeded, just couldn't schedule tweets
          logger.warn(`[Launch] Could not auto-schedule marketing tweets: ${(scheduleErr as Error).message}`);
        }
      }

      // === ANNOUNCE TO NOVA CHANNEL ===
      // If Nova channel is enabled, announce the launch
      try {
        await announceLaunch(saved);
      } catch (channelErr) {
        // Non-fatal - launch succeeded, just couldn't post to channel
        logger.warn(`[Launch] Could not post to Nova channel: ${(channelErr as Error).message}`);
      }

      return saved;
    } catch (error) {
      const err = error as Error & { code?: string };
      const failure: LaunchPackUpdateInput = {
        launch: {
          status: 'failed',
          failed_at: nowIso(),
          error_code: err.code || 'LAUNCH_FAILED',
          error_message: err.message,
          // Don't include ANY old datetime fields - they might be in wrong format
          // Only keep non-datetime fields from existing launch
          mint: withRequested.launch?.mint,
          tx_signature: withRequested.launch?.tx_signature,
          pump_url: withRequested.launch?.pump_url,
        },
        ops: {
          checklist: withRequested.ops?.checklist,
          // Recreate audit log with only the new entry - avoid old timestamps
          audit_log: [{ at: nowIso(), message: `Launch failed: ${err.message}`, actor: 'eliza' }],
        },
      };
      const saved = await this.store.update(id, failure);
      logger.error({ error: err.message, details: redactSensitive((err as any).details || {}) }, 'Pump launch failed');
      throw err;
    }
  }
}
