import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import { getUserFromToken, SESSION_COOKIE } from './middleware/auth';
import { getServerById } from '../shared/server-store';
import { getServerBacklog, subscribeServer } from '../shared/server-runtime';
import type { ServerStreamEvent } from '../shared/server-runtime';

interface AuthedServerSocket extends WebSocket {
  userId?: string;
  isAlive?: boolean;
}

/** Messages the server sends to a `/ws/server` client. */
type ServerSocketMessage =
  | { type: 'ready'; serverId: string; status: string; exitCode: number | null }
  | { type: 'output'; data: string }
  | { type: 'status'; status: string; exitCode: number | null };

/**
 * WebSocket server for live server-console streaming. Each connection attaches
 * to a single `serverId` (query param), receives the buffered backlog, and then
 * streams live stdout/stderr and status transitions. Deliberately isolated from
 * the agent SDK socket (`/ws/agent`).
 */
export function setupServerWebSocketServer(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      const socket = ws as AuthedServerSocket;
      if (socket.isAlive === false) {
        socket.terminate();
        return;
      }
      socket.isAlive = false;
      try {
        socket.ping();
      } catch {
        /* ignore */
      }
    });
  }, 30_000);

  wss.on('close', () => clearInterval(heartbeat));

  wss.on('connection', (ws: AuthedServerSocket, req: IncomingMessage) => {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    // Auth via session cookie (same scheme as the agent/terminal WS).
    const cookieHeader = req.headers.cookie ?? '';
    const sessionCookie = cookieHeader
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith(SESSION_COOKIE + '='))
      ?.split('=')
      .slice(1)
      .join('=');
    const token = sessionCookie ? decodeURIComponent(sessionCookie) : null;
    const user = token ? getUserFromToken(token) : null;
    if (!user) {
      ws.close(4001, 'Unauthorized');
      return;
    }
    ws.userId = user.id;

    const url = new URL(req.url ?? '', `http://${req.headers.host}`);
    const serverId = url.searchParams.get('serverId');
    if (!serverId) {
      ws.close(4002, 'Missing serverId');
      return;
    }

    const server = getServerById(serverId);
    if (!server) {
      ws.close(4003, 'Server not found');
      return;
    }

    const send = (msg: ServerSocketMessage) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };

    send({ type: 'ready', serverId, status: server.status, exitCode: server.exitCode });

    // Replay buffered output so a freshly-opened tab shows the run so far.
    const backlog = getServerBacklog(serverId);
    if (backlog) send({ type: 'output', data: backlog });

    // Stream live output/status.
    const unsubscribe = subscribeServer(serverId, (event: ServerStreamEvent) => {
      if (event.type === 'output') {
        send({ type: 'output', data: event.data });
      } else {
        send({ type: 'status', status: event.status, exitCode: event.exitCode });
      }
    });

    ws.on('close', () => {
      unsubscribe();
    });
    ws.on('error', () => {
      unsubscribe();
    });
  });

  return wss;
}
