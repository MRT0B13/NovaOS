/**
 * Auth routes — wallet-based authentication
 * POST /api/auth/verify  — verify wallet signature, issue JWT
 * POST /api/auth/nonce   — get a nonce/message to sign
 */
import { FastifyInstance } from 'fastify';
import { verifyMessage } from 'viem';

export async function authRoutes(server: FastifyInstance) {
  // POST /api/auth/nonce
  // Returns a message the frontend should ask the wallet to sign
  server.post('/auth/nonce', async (req, reply) => {
    const { address } = req.body as { address: string };
    if (!address) return reply.status(400).send({ error: 'address required' });

    const nonce = Math.floor(Math.random() * 1_000_000_000).toString(36);
    const message = `Sign this message to authenticate with NovaVerse.\n\nWallet: ${address.toLowerCase()}\nNonce: ${nonce}\nTimestamp: ${Date.now()}`;

    reply.send({ message });
  });

  // POST /api/auth/verify
  // Body: { address: string, message: string, signature: string }
  // Returns: { token: string }
  server.post('/auth/verify', async (req, reply) => {
    const { address, message, signature } = req.body as {
      address: string;
      message: string;
      signature: string;
    };

    if (!address || !message || !signature) {
      return reply.status(400).send({ error: 'address, message, and signature required' });
    }

    let valid = false;
    try {
      valid = await verifyMessage({
        address: address as `0x${string}`,
        message,
        signature: signature as `0x${string}`,
      });
    } catch (e) {
      server.log.warn({ err: e }, 'Signature verification error');
      return reply.status(401).send({ error: 'Invalid signature format' });
    }

    if (!valid) return reply.status(401).send({ error: 'Invalid signature' });

    // Upsert user record
    const addr = address.toLowerCase();
    await server.pg.query(
      `INSERT INTO users (wallet_address, last_seen)
       VALUES ($1, NOW())
       ON CONFLICT (wallet_address) DO UPDATE SET last_seen = NOW()`,
      [addr]
    );

    const token = server.jwt.sign(
      { address: addr },
      { expiresIn: '7d' }
    );

    reply.send({ token, address: addr });
  });
}
