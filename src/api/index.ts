/**
 * NovaVerse API — Fastify server entry point
 * Exposes the NovaOS agent swarm data to the NovaVerse frontend.
 *
 * Start: bun run api
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import websocket from '@fastify/websocket';
import postgres from '@fastify/postgres';
import { portfolioRoutes } from './routes/portfolio.js';
import { feedRoutes } from './routes/feed.js';
import { skillsRoutes } from './routes/skills.js';
import { governanceRoutes } from './routes/governance.js';
import { agentsRoutes } from './routes/agents.js';
import { authRoutes } from './routes/auth.js';
import { supervisorRoutes } from './routes/supervisor.js';
import { learningRoutes } from './routes/learning.js';
import { healthRoutes } from './routes/health.js';
import { launchesRoutes } from './routes/launches.js';
import { transactionsRoutes } from './routes/transactions.js';
import { burnRoutes } from './routes/burn.js';
import { universeRoutes } from './routes/universe_route.js';
import { registerLiveStream } from './ws/liveStream.js';

async function main() {
  const server = Fastify({ logger: true });

  // Handle empty JSON bodies gracefully (pause/resume send no body)
  server.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try {
      const str = body as string;
      done(null, str && str.length > 0 ? JSON.parse(str) : {});
    } catch (err: any) {
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  // ── Plugins ───────────────────────────────────────────
  await server.register(cors, {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  await server.register(jwt, {
    secret: process.env.API_JWT_SECRET || 'novaverse-dev-secret-change-me',
  });

  await server.register(websocket);

  // Postgres — reuse the same DATABASE_URL as the rest of NovaOS
  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!dbUrl) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  await server.register(postgres, {
    connectionString: dbUrl,
    ssl: dbUrl.includes('sslmode=require') || process.env.PGSSLMODE === 'require'
      ? { rejectUnauthorized: false }
      : false,
  });

  // ── Routes ────────────────────────────────────────────
  server.register(authRoutes,       { prefix: '/api' });
  server.register(portfolioRoutes,  { prefix: '/api' });
  server.register(feedRoutes,       { prefix: '/api' });
  server.register(skillsRoutes,     { prefix: '/api' });
  server.register(governanceRoutes, { prefix: '/api' });
  server.register(agentsRoutes,     { prefix: '/api' });
  server.register(supervisorRoutes, { prefix: '/api' });
  server.register(learningRoutes,   { prefix: '/api' });
  server.register(healthRoutes,     { prefix: '/api' });
  server.register(launchesRoutes,   { prefix: '/api' });
  server.register(transactionsRoutes, { prefix: '/api' });
  server.register(burnRoutes,         { prefix: '/api' });
  server.register(universeRoutes,      { prefix: '/api' });

  // ── WebSocket ─────────────────────────────────────────
  registerLiveStream(server);

  // ── Health ────────────────────────────────────────────
  server.get('/api/health', async () => ({ status: 'ok', ts: new Date().toISOString() }));

  // ── Start ─────────────────────────────────────────────
  const port = Number(process.env.PORT || process.env.API_PORT) || 4000;
  await server.listen({ port, host: '0.0.0.0' });
  console.log(`NovaVerse API listening on :${port}`);
}

main().catch((err) => {
  console.error('Failed to start NovaVerse API:', err);
  process.exit(1);
});
