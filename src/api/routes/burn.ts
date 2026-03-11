/**
 * Burn routes — Meme Token Burn-to-Fund Ecosystem
 *
 * Enables users to burn Nova-launched meme tokens:
 *   1. Tokens are swapped to SOL via Jupiter
 *   2. SOL is distributed across ecosystem pools (treasury/staking/rewards/buyback)
 *   3. Burners earn credits redeemable for NOVA tokens or rewards
 *
 * Endpoints:
 *   GET  /api/burn/eligible           — list tokens eligible for burning
 *   GET  /api/burn/quote?mint&amount  — get a burn quote (preview)
 *   POST /api/burn                    — execute a burn
 *   GET  /api/burn/stats              — ecosystem burn statistics
 *   GET  /api/burn/wallet/:address    — wallet burn history + credits
 *   GET  /api/burn/config             — current splits + config
 *   GET  /api/burn/leaderboard        — top burners leaderboard
 *   GET  /api/burn/history            — global burn history (paginated)
 *   GET  /api/burn/:id                — get a specific burn record
 */
import { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';
import { BurnService } from '../../launchkit/services/burnService.js';
import { Pool } from 'pg';

// Lazy singleton — initialized on first route call
let burnService: BurnService | null = null;

function getService(server: FastifyInstance): BurnService {
  if (!burnService) {
    burnService = new BurnService(server.pg as unknown as Pool);
  }
  return burnService;
}

export async function burnRoutes(server: FastifyInstance) {

  // ── GET /api/burn/eligible — tokens that can be burned ──
  server.get('/burn/eligible', { preHandler: requireAuth }, async (_req, reply) => {
    const service = getService(server);
    const tokens = await service.getEligibleTokens();

    // Enrich with current price from pump.fun
    const enriched = await Promise.all(tokens.map(async (t) => {
      try {
        const resp = await fetch(`https://frontend-api.pump.fun/coins/${t.mint}`);
        if (resp.ok) {
          const coin = await resp.json() as any;
          return {
            ...t,
            priceUsd: coin.price ?? coin.usd_price ?? null,
            marketCap: coin.usd_market_cap ?? coin.market_cap ?? null,
            isGraduated: coin.complete === true || coin.is_graduated === true,
          };
        }
      } catch {}
      return { ...t, priceUsd: null, marketCap: null, isGraduated: false };
    }));

    reply.send(enriched);
  });

  // ── GET /api/burn/quote — preview burn without executing ──
  server.get('/burn/quote', { preHandler: requireAuth }, async (req, reply) => {
    const { mint, amount } = req.query as { mint?: string; amount?: string };

    if (!mint) return reply.status(400).send({ error: 'mint is required' });
    if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
      return reply.status(400).send({ error: 'amount must be a positive number' });
    }

    const service = getService(server);
    const quote = await service.getQuote(mint, Number(amount));
    reply.send(quote);
  });

  // ── POST /api/burn — execute a burn ──
  server.post('/burn', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as {
      walletAddress?: string;
      mint?: string;
      amountTokens?: number;
      launchPackId?: string;
    };

    if (!body.walletAddress) return reply.status(400).send({ error: 'walletAddress is required' });
    if (!body.mint) return reply.status(400).send({ error: 'mint is required' });
    if (!body.amountTokens || body.amountTokens <= 0) {
      return reply.status(400).send({ error: 'amountTokens must be a positive number' });
    }

    const service = getService(server);

    // Rate limit: max 5 pending burns per wallet
    const pending = await server.pg.query(
      `SELECT COUNT(*) AS count FROM token_burns
       WHERE wallet_address = $1 AND status IN ('pending', 'swapping', 'distributing')`,
      [body.walletAddress]
    );
    if (Number(pending.rows[0]?.count ?? 0) >= 5) {
      return reply.status(429).send({ error: 'Too many pending burns — wait for current burns to complete' });
    }

    const result = await service.executeBurn({
      walletAddress: body.walletAddress,
      mint: body.mint,
      amountTokens: body.amountTokens,
      launchPackId: body.launchPackId,
    });

    const statusCode = result.status === 'completed' ? 200 : 422;
    reply.status(statusCode).send(result);
  });

  // ── GET /api/burn/stats — ecosystem burn statistics ──
  server.get('/burn/stats', { preHandler: requireAuth }, async (_req, reply) => {
    const service = getService(server);
    const stats = await service.getStats();
    const splits = service.getSplits();
    reply.send({ ...stats, splits });
  });

  // ── GET /api/burn/wallet/:address — wallet burn history + credits ──
  server.get('/burn/wallet/:address', { preHandler: requireAuth }, async (req, reply) => {
    const { address } = req.params as { address: string };
    const service = getService(server);
    const summary = await service.getWalletSummary(address);
    reply.send(summary);
  });

  // ── GET /api/burn/config — current distribution config ──
  server.get('/burn/config', { preHandler: requireAuth }, async (_req, reply) => {
    const service = getService(server);
    const splits = service.getSplits();

    reply.send({
      splits,
      creditsPerSol: 100,
      minBurnSol: 0.001,
      maxPriceImpactBps: 300,
      slippageBps: 300,
      logOnly: (process.env.BURN_LOG_ONLY ?? 'true') === 'true',
      pools: {
        treasury: {
          label: 'Treasury',
          percent: splits.treasury,
          purpose: 'Infrastructure, development, liquidity',
        },
        staking: {
          label: 'Staking Rewards',
          percent: splits.staking,
          purpose: 'Distributed to NOVA stakers',
        },
        rewards: {
          label: 'Community Rewards',
          percent: splits.rewards,
          purpose: 'Airdrops, contests, community incentives',
        },
        buyback: {
          label: 'NOVA Buyback & Burn',
          percent: splits.buyback,
          purpose: 'Buy NOVA from market and burn for deflation',
        },
      },
    });
  });

  // ── GET /api/burn/history — global burn history (paginated) ──
  server.get('/burn/history', { preHandler: requireAuth }, async (req, reply) => {
    const { limit = '25', offset = '0', status, mint } = req.query as {
      limit?: string; offset?: string; status?: string; mint?: string;
    };

    const cap = Math.min(Number(limit) || 25, 100);
    const skip = Math.max(Number(offset) || 0, 0);

    let conditions = ['1=1'];
    const params: any[] = [];
    let idx = 0;

    if (status) {
      idx++; conditions.push(`status = $${idx}`); params.push(status);
    }
    if (mint) {
      idx++; conditions.push(`mint = $${idx}`); params.push(mint);
    }

    idx++; params.push(cap);
    idx++; params.push(skip);

    const [rows, countResult] = await Promise.all([
      server.pg.query(
        `SELECT id, wallet_address, mint, token_name, token_ticker,
                amount_tokens, amount_sol, amount_usd,
                dist_treasury, dist_staking, dist_rewards, dist_buyback,
                credits_earned, status, swap_tx, burn_tx, created_at, completed_at
         FROM token_burns
         WHERE ${conditions.join(' AND ')}
         ORDER BY created_at DESC
         LIMIT $${idx - 1} OFFSET $${idx}`,
        params
      ),
      server.pg.query(
        `SELECT COUNT(*) AS count FROM token_burns WHERE ${conditions.join(' AND ')}`,
        params.slice(0, -2) // exclude limit/offset
      ),
    ]);

    reply.send({
      burns: rows.rows.map((r: any) => ({
        id: r.id,
        wallet: r.wallet_address,
        mint: r.mint,
        tokenName: r.token_name,
        tokenTicker: r.token_ticker,
        amountTokens: Number(r.amount_tokens),
        amountSol: Number(r.amount_sol ?? 0),
        amountUsd: Number(r.amount_usd ?? 0),
        distribution: {
          treasury: Number(r.dist_treasury ?? 0),
          staking: Number(r.dist_staking ?? 0),
          rewards: Number(r.dist_rewards ?? 0),
          buyback: Number(r.dist_buyback ?? 0),
        },
        creditsEarned: Number(r.credits_earned ?? 0),
        status: r.status,
        swapTx: r.swap_tx,
        burnTx: r.burn_tx,
        createdAt: r.created_at,
        completedAt: r.completed_at,
      })),
      total: Number(countResult.rows[0]?.count ?? 0),
      limit: cap,
      offset: skip,
    });
  });

  // ── GET /api/burn/leaderboard — top burners by credits ──
  server.get('/burn/leaderboard', { preHandler: requireAuth }, async (req, reply) => {
    const { limit = '25', sortBy = 'credits' } = req.query as {
      limit?: string; sortBy?: 'credits' | 'sol' | 'burns';
    };

    const cap = Math.min(Number(limit) || 25, 100);

    const orderCol = sortBy === 'sol' ? 'total_sol_value' : sortBy === 'burns' ? 'total_burns' : 'total_earned';

    const { rows } = await server.pg.query(
      `SELECT wallet_address, total_earned, total_redeemed,
              total_burns, total_sol_value, updated_at
       FROM burn_credits
       ORDER BY ${orderCol} DESC
       LIMIT $1`,
      [cap]
    );

    // Also get totals for the entire ecosystem
    const totals = await server.pg.query(
      `SELECT COUNT(*) AS burners,
              COALESCE(SUM(total_earned), 0) AS total_credits,
              COALESCE(SUM(total_sol_value), 0) AS total_sol,
              COALESCE(SUM(total_burns), 0) AS total_burns
       FROM burn_credits`
    );
    const t = totals.rows[0] || {};

    reply.send({
      leaderboard: rows.map((r: any, i: number) => ({
        rank: i + 1,
        wallet: r.wallet_address,
        credits: Number(r.total_earned ?? 0),
        creditsRedeemed: Number(r.total_redeemed ?? 0),
        burns: Number(r.total_burns ?? 0),
        totalSol: Number(r.total_sol_value ?? 0),
        lastActive: r.updated_at,
      })),
      ecosystem: {
        uniqueBurners: Number(t.burners ?? 0),
        totalCredits: Number(t.total_credits ?? 0),
        totalSolBurned: Number(t.total_sol ?? 0),
        totalBurns: Number(t.total_burns ?? 0),
      },
      limit: cap,
      sortBy,
    });
  });

  // ── GET /api/burn/:id — get a specific burn record ──
  server.get<{ Params: { id: string } }>('/burn/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };

    const row = await server.pg.query(
      `SELECT b.*,
              lp.data->'brand'->>'name' AS launch_name,
              lp.data->'brand'->>'ticker' AS launch_ticker,
              lp.data->'assets'->>'logo_url' AS launch_logo
       FROM token_burns b
       LEFT JOIN launch_packs lp ON lp.id = b.launch_pack_id
       WHERE b.id = $1`,
      [id]
    );

    if (!row.rows.length) return reply.status(404).send({ error: 'Burn not found' });

    const r = row.rows[0];
    reply.send({
      id: r.id,
      wallet: r.wallet_address,
      mint: r.mint,
      tokenName: r.token_name,
      tokenTicker: r.token_ticker,
      amountTokens: Number(r.amount_tokens),
      amountSol: Number(r.amount_sol ?? 0),
      amountUsd: Number(r.amount_usd ?? 0),
      distribution: {
        treasury: Number(r.dist_treasury ?? 0),
        staking: Number(r.dist_staking ?? 0),
        rewards: Number(r.dist_rewards ?? 0),
        buyback: Number(r.dist_buyback ?? 0),
      },
      creditsEarned: Number(r.credits_earned ?? 0),
      creditsRedeemed: Number(r.credits_redeemed ?? 0),
      status: r.status,
      swapTx: r.swap_tx,
      distTx: r.dist_tx,
      burnTx: r.burn_tx,
      errorMessage: r.error_message,
      launchPack: r.launch_pack_id ? {
        id: r.launch_pack_id,
        name: r.launch_name,
        ticker: r.launch_ticker,
        logo: r.launch_logo,
      } : null,
      createdAt: r.created_at,
      completedAt: r.completed_at,
    });
  });
}
