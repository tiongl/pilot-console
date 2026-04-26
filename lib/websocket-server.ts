import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import { decode } from 'next-auth/jwt';
import { createCliSession, writeToSession, endCliSession, getSession } from './cli-bridge';
import type { WsClientMessage, WsServerMessage } from '@/types';

interface AuthedSocket extends WebSocket {
  userId?: string;
  sessionId?: string;
  isAlive?: boolean;
}

export function setupWebSocketServer(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  // Heartbeat to detect stale connections
  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      const socket = ws as AuthedSocket;
      if (socket.isAlive === false) {
        if (socket.sessionId) endCliSession(socket.sessionId);
        return socket.terminate();
      }
      socket.isAlive = false;
      socket.ping();
    });
  }, 30_000);

  wss.on('close', () => clearInterval(heartbeat));

  wss.on('connection', async (ws: AuthedSocket, req: IncomingMessage) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    // Authenticate: read JWT from cookie (browser sends automatically on same-origin WS)
    // Falls back to ?token= query param for programmatic clients
    const url = new URL(req.url ?? '', `http://${req.headers.host}`);
    const cookieHeader = req.headers.cookie ?? '';
    const cookieToken = cookieHeader
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith('authjs.session-token=') || c.startsWith('__Secure-authjs.session-token='))
      ?.split('=')
      .slice(1)
      .join('=');
    const token = cookieToken ? decodeURIComponent(cookieToken) : url.searchParams.get('token');

    if (!token) {
      ws.close(4001, 'Missing token');
      return;
    }

    let decoded: Record<string, unknown> | null = null;
    try {
      decoded = await decode({
        token,
        secret: process.env.NEXTAUTH_SECRET!,
        salt: 'authjs.session-token',
      }) as Record<string, unknown> | null;
    } catch {
      ws.close(4001, 'Invalid token');
      return;
    }

    if (!decoded?.userId) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    ws.userId = decoded.userId as string;

    // Create a CLI process for this connection
    const projectId = url.searchParams.get('projectId');
    const managed = createCliSession(ws.userId, projectId);
    ws.sessionId = managed.sessionId;

    const send = (msg: WsServerMessage) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    };

    managed.onOutput = (data) => send({ type: 'output', data });
    managed.onError = (data) => send({ type: 'error', data });
    managed.onExit = (code) => send({ type: 'exit', code });

    send({ type: 'ready', sessionId: managed.sessionId });

    ws.on('message', (raw) => {
      let msg: WsClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as WsClientMessage;
      } catch {
        return;
      }

      if (msg.type === 'input') {
        writeToSession(ws.sessionId!, msg.data);
      } else if (msg.type === 'ping') {
        send({ type: 'pong' });
      }
      // resize: node-pty not used, so silently ignored for now
    });

    ws.on('close', () => {
      if (ws.sessionId) endCliSession(ws.sessionId);
    });

    ws.on('error', (err) => {
      console.error('[ws] socket error', err.message);
      if (ws.sessionId) endCliSession(ws.sessionId);
    });
  });

  return wss;
}
