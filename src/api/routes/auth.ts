/**
 * Auth routes — wallet-based authentication
 * Supports both EVM (0x…) and Solana (base58) wallets.
 *
 * POST /api/auth/nonce   — get a message to sign
 * POST /api/auth/verify  — verify signature, issue JWT
 */
import { FastifyInstance } from 'fastify';
import { verifyMessage } from 'viem';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

/** Detect wallet type from address format */
function walletType(address: string): 'evm' | 'solana' {
  if (address.startsWith('0x')) return 'evm';
  // Solana addresses are 32-44 char base58-encoded ed25519 pubkeys
  return 'solana';
}

export async function authRoutes(server: FastifyInstance) {
  // POST /api/auth/nonce
  // Returns a message the frontend should ask the wallet to sign
  server.post('/auth/nonce', async (req, reply) => {
    const { address } = req.body as { address: string };
    if (!address) return reply.status(400).send({ error: 'address required' });

    const nonce = Math.floor(Math.random() * 1_000_000_000).toString(36);
    // Keep original casing for Solana (base58 is case-sensitive)
    const displayAddr = walletType(address) === 'evm' ? address.toLowerCase() : address;
    const message = `Sign this message to authenticate with NovaVerse.\n\nWallet: ${displayAddr}\nNonce: ${nonce}\nTimestamp: ${Date.now()}`;

    reply.send({ message });
  });

  // POST /api/auth/verify
  // Body: { address, message, signature }
  // Returns: { token, address }
  server.post('/auth/verify', async (req, reply) => {
    const { address, message, signature } = req.body as {
      address: string;
      message: string;
      signature: string;
    };

    if (!address || !message || !signature) {
      return reply.status(400).send({ error: 'address, message, and signature required' });
    }

    const type = walletType(address);
    let valid = false;

    if (type === 'evm') {
      // ── EVM verification (viem) ──
      try {
        valid = await verifyMessage({
          address: address as `0x${string}`,
          message,
          signature: signature as `0x${string}`,
        });
      } catch (e) {
        server.log.warn({ err: e }, 'EVM signature verification error');
        return reply.status(401).send({ error: 'Invalid EVM signature format' });
      }
    } else {
      // ── Solana verification (tweetnacl ed25519) ──
      try {
        const msgBytes = new TextEncoder().encode(message);
        const pubkeyBytes = bs58.decode(address);

        // Accept signature as base58 OR hex (some wallets/adapters use hex)
        let sigBytes: Uint8Array;
        if (signature.startsWith('0x')) {
          // Hex-encoded signature
          const hex = signature.slice(2);
          sigBytes = new Uint8Array(hex.match(/.{1,2}/g)!.map(b => parseInt(b, 16)));
        } else {
          try {
            sigBytes = bs58.decode(signature);
          } catch {
            // Might be raw hex without 0x prefix
            sigBytes = new Uint8Array(signature.match(/.{1,2}/g)!.map(b => parseInt(b, 16)));
          }
        }

        server.log.info({
          solanaVerify: true,
          addressLen: address.length,
          sigLen: sigBytes.length,
          pubkeyLen: pubkeyBytes.length,
          msgLen: msgBytes.length,
          sigPrefix: signature.substring(0, 20),
        }, 'Solana verify attempt');

        valid = nacl.sign.detached.verify(msgBytes, sigBytes, pubkeyBytes);

        if (!valid) {
          server.log.warn({
            address,
            sigLen: sigBytes.length,
            msgPreview: message.substring(0, 80),
          }, 'Solana signature did not verify');
        }
      } catch (e) {
        server.log.warn({ err: e, address, sigPreview: signature?.substring(0, 30) }, 'Solana signature verification error');
        return reply.status(401).send({ error: 'Invalid Solana signature format' });
      }
    }

    if (!valid) return reply.status(401).send({ error: 'Invalid signature' });

    // Normalise: lowercase for EVM, original case for Solana
    const addr = type === 'evm' ? address.toLowerCase() : address;

    // Upsert user record
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
