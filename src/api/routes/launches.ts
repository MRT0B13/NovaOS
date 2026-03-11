/**
 * Launches routes — CRUD for launch packs + pump.fun price lookup
 *
 * All data lives in the `launch_packs` table where the `data` column
 * is a JSONB blob containing the full LaunchPack object.
 */
import { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';
import { v4 as uuidv4 } from 'uuid';

export async function launchesRoutes(server: FastifyInstance) {

  // ── GET /api/launches — list all launch packs ──
  server.get('/launches', { preHandler: requireAuth }, async (req, reply) => {
    const rows = await server.pg.query(
      `SELECT id,
              data->'brand'  AS brand,
              data->'launch' AS launch,
              data->'assets'->'logo_url' AS logo_url,
              data->'ops'->'sell_state' AS sell_state,
              data->'ops'->'treasury'->'amount_sol' AS treasury_sol,
              launch_status,
              created_at
       FROM launch_packs
       ORDER BY created_at DESC`
    );

    reply.send(rows.rows.map((r: any) => ({
      id: r.id,
      brand: r.brand ?? null,
      launch: r.launch ?? null,
      logo_url: r.logo_url ?? null,
      sell_state: r.sell_state ?? null,
      treasury_sol: r.treasury_sol ?? null,
      launch_status: r.launch_status,
      created_at: r.created_at,
    })));
  });

  // ── GET /api/launches/:id — full launch pack record ──
  server.get('/launches/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await server.pg.query(
      `SELECT * FROM launch_packs WHERE id = $1`,
      [id]
    );
    if (!row.rows.length) return reply.status(404).send({ error: 'Launch pack not found' });
    const lp = row.rows[0];
    reply.send({ ...lp, data: lp.data });
  });

  // ── GET /api/launches/:id/price — current pump.fun price via mint ──
  server.get('/launches/:id/price', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };

    // Look up the mint address from the launch pack
    const row = await server.pg.query(
      `SELECT data->'launch'->>'mint' AS mint FROM launch_packs WHERE id = $1`,
      [id]
    );
    if (!row.rows.length) return reply.status(404).send({ error: 'Launch pack not found' });

    const mint = row.rows[0].mint;
    if (!mint) return reply.status(400).send({ error: 'No mint address — token not launched yet' });

    try {
      const resp = await fetch(`https://frontend-api.pump.fun/coins/${mint}`);
      if (!resp.ok) {
        return reply.status(502).send({ error: `pump.fun API returned ${resp.status}` });
      }
      const coin = await resp.json() as any;

      // Graduation progress — pump.fun bonding curve reaches ~$69k market cap
      const bondingCurveTarget = 69_000; // approximate graduation threshold
      const marketCap = coin.usd_market_cap ?? coin.market_cap ?? 0;
      const graduationProgress = Math.min(100, (marketCap / bondingCurveTarget) * 100);

      reply.send({
        mint,
        price_usd: coin.price ?? coin.usd_price ?? null,
        market_cap: marketCap,
        volume_24h: coin.volume_24h ?? null,
        graduation_progress: Math.round(graduationProgress * 100) / 100,
        is_graduated: coin.complete === true || coin.is_graduated === true || graduationProgress >= 100,
        raw: coin, // full pump.fun response for debugging
      });
    } catch (err: any) {
      server.log.error({ err, mint }, 'pump.fun price fetch failed');
      reply.status(502).send({ error: 'Failed to fetch price from pump.fun: ' + (err.message || 'unknown') });
    }
  });

  // ── POST /api/launches — create a new draft launch pack ──
  server.post('/launches', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as {
      brand: { name: string; ticker: string; tagline?: string; description?: string };
      assets?: { logo_url?: string };
    };

    if (!body.brand?.name || !body.brand?.ticker) {
      return reply.status(400).send({ error: 'brand.name and brand.ticker are required' });
    }

    const id = uuidv4();
    const data = {
      version: 1,
      brand: {
        name: body.brand.name,
        ticker: body.brand.ticker.toUpperCase(),
        tagline: body.brand.tagline ?? '',
        description: body.brand.description ?? '',
      },
      assets: body.assets ?? {},
      launch: { status: 'draft' },
      ops: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    await server.pg.query(
      `INSERT INTO launch_packs (id, data, launch_status, created_at, updated_at)
       VALUES ($1, $2, 'draft', NOW(), NOW())`,
      [id, JSON.stringify(data)]
    );

    reply.status(201).send({ id, ...data });
  });

  // ── PATCH /api/launches/:id — update launch pack fields ──
  server.patch('/launches/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const updates = req.body as Record<string, any>;

    // Fetch the current record
    const row = await server.pg.query(
      `SELECT data FROM launch_packs WHERE id = $1`,
      [id]
    );
    if (!row.rows.length) return reply.status(404).send({ error: 'Launch pack not found' });

    const current = row.rows[0].data;

    // Deep-merge allowed top-level keys
    const allowedKeys = ['brand', 'mascot', 'links', 'assets', 'tg', 'x', 'ops'];
    for (const key of allowedKeys) {
      if (updates[key] !== undefined) {
        if (typeof current[key] === 'object' && typeof updates[key] === 'object') {
          current[key] = { ...current[key], ...updates[key] };
        } else {
          current[key] = updates[key];
        }
      }
    }
    current.updated_at = new Date().toISOString();

    await server.pg.query(
      `UPDATE launch_packs SET data = $1, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(current), id]
    );

    reply.send({ ok: true, id, data: current });
  });

  // ── POST /api/launches/:id/launch — mark as ready for the launcher pipeline ──
  server.post('/launches/:id/launch', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };

    const row = await server.pg.query(
      `SELECT data, launch_status FROM launch_packs WHERE id = $1`,
      [id]
    );
    if (!row.rows.length) return reply.status(404).send({ error: 'Launch pack not found' });

    const lp = row.rows[0];
    if (lp.launch_status === 'launched') {
      return reply.status(409).send({ error: 'Already launched' });
    }

    // Update data.launch.status and the launch_status column
    const data = lp.data;
    data.launch = { ...data.launch, status: 'ready', requested_at: new Date().toISOString() };
    data.updated_at = new Date().toISOString();

    await server.pg.query(
      `UPDATE launch_packs
       SET data = $1, launch_status = 'ready', launch_requested_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(data), id]
    );

    reply.send({ ok: true, id, launch_status: 'ready', launch_requested_at: new Date().toISOString() });
  });
}
