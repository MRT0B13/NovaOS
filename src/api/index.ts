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
import { registerLiveStream } from './ws/liveStream.js';

async function main() {
  const server = Fastify({ logger: true });

  // ── Plugins ───────────────────────────────────────────
  await server.register(cors, {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
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
