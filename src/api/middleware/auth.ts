/**
 * Auth middleware — wallet signature verification via viem
 */
import { FastifyRequest, FastifyReply } from 'fastify';

/**
 * Prehandler — attach to any protected route.
 * Verifies the JWT token from the Authorization header.
 */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  try {
    await req.jwtVerify();
  } catch {
    reply.status(401).send({ error: 'Unauthorized' });
  }
}
