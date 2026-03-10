/**
 * WebSocket Live Stream — pushes new agent_messages to connected clients
 * Polls every 3 seconds and fans out per wallet address.
 */
import { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';

// Map: walletAddress → Set<WebSocket>
const clients = new Map<string, Set<WebSocket>>();

export function registerLiveStream(server: FastifyInstance) {

  // WS /api/ws/live?token=<jwt>
  server.get('/api/ws/live', { websocket: true }, (socket, req) => {
    let address: string;
    try {
      const payload = server.jwt.verify<{ address: string }>(
        (req.query as any).token
      );
      address = payload.address;
    } catch {
      socket.close(4001, 'Unauthorized');
      return;
    }

    if (!clients.has(address)) clients.set(address, new Set());
    clients.get(address)!.add(socket);

    server.log.info(`WS client connected: ${address} (${clients.get(address)!.size} total)`);

    socket.on('close', () => {
      clients.get(address)?.delete(socket);
      if (clients.get(address)?.size === 0) clients.delete(address);
    });

    socket.on('error', () => {
      clients.get(address)?.delete(socket);
    });
  });

  // Polling loop — runs on server, pushes to WebSocket clients
  let lastSeenId = 0;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  async function pollAndBroadcast() {
    try {
      // Skip if no clients connected
      if (clients.size === 0) {
        pollTimer = setTimeout(pollAndBroadcast, 3000);
        return;
      }

      // Get new agent_messages since last poll, join with user_agents to know who to notify
      const rows = await server.pg.query(
        `SELECT am.id, am.from_agent, am.message_type, am.summary, am.detail,
                am.payload, am.created_at, ua.wallet_address
         FROM agent_messages am
         JOIN user_agents ua ON ua.agent_id = am.agent_id AND ua.active = true
         WHERE am.id > $1 AND am.agent_id IS NOT NULL
         ORDER BY am.id ASC
         LIMIT 50`,
        [lastSeenId]
      );

      for (const row of rows.rows) {
        lastSeenId = Math.max(lastSeenId, row.id);
        const sockets = clients.get(row.wallet_address);
        if (!sockets?.size) continue;

        const payload = JSON.stringify({
          type: 'feed_event',
          data: {
            id: row.id,
            time: new Date(row.created_at).toLocaleTimeString('en-GB', { hour12: false }),
            agent: row.from_agent.replace('nova-', '').toUpperCase(),
            icon: getIcon(row.from_agent),
            color: getColor(row.from_agent),
            msg: row.summary ?? row.message_type,
            detail: row.detail ?? '',
          },
        });

        const sockArr = Array.from(sockets);
        for (let i = 0; i < sockArr.length; i++) {
          if (sockArr[i].readyState === 1 /* OPEN */) {
            sockArr[i].send(payload);
          }
        }
      }
    } catch (e) {
      server.log.error({ err: e }, 'pollAndBroadcast error');
    }

    pollTimer = setTimeout(pollAndBroadcast, 3000);
  }

  // Initialize lastSeenId from current max
  server.pg.query('SELECT COALESCE(MAX(id), 0) AS max_id FROM agent_messages')
    .then((res) => {
      lastSeenId = res.rows[0]?.max_id ?? 0;
      server.log.info(`WS poll initialized, lastSeenId=${lastSeenId}`);
      pollAndBroadcast();
    })
    .catch((e) => {
      server.log.error({ err: e }, 'Failed to init WS poll');
      pollAndBroadcast();
    });

  // Cleanup on server close
  server.addHook('onClose', async () => {
    if (pollTimer) clearTimeout(pollTimer);
    const entries = Array.from(clients.entries());
    for (let i = 0; i < entries.length; i++) {
      const sockArr = Array.from(entries[i][1]);
      for (let j = 0; j < sockArr.length; j++) {
        sockArr[j].close(1001, 'Server shutting down');
      }
    }
    clients.clear();
  });
}

function getIcon(agent: string): string {
  if (agent.includes('scout')) return '📡';
  if (agent.includes('guardian')) return '🛡️';
  if (agent.includes('supervisor')) return '⚙️';
  if (agent.includes('analyst')) return '📊';
  if (agent.includes('community')) return '👥';
  if (agent.includes('launcher')) return '🚀';
  return '💹';
}

function getColor(agent: string): string {
  if (agent.includes('scout')) return '#00c8ff';
  if (agent.includes('guardian')) return '#ff9500';
  if (agent.includes('supervisor')) return '#888';
  if (agent.includes('analyst')) return '#c084fc';
  return '#00ff88';
}
