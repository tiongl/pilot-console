import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import { decode } from 'next-auth/jwt';
import { createCliSession, writeToSession, endCliSession, findActiveSession, detachSession } from './cli-bridge';
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
        if (socket.sessionId) detachSession(socket.sessionId);
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

    // Reuse existing PTY session for this user+project, or create a new one
    const projectId = url.searchParams.get('projectId');
    let managed = findActiveSession(ws.userId, projectId ?? null);
    const isReconnect = !!managed;

    if (!managed) {
      try {
        managed = createCliSession(ws.userId, projectId);
      } catch (err) {
        console.error('[ws] failed to create CLI session:', err);
        ws.close(4002, 'Failed to create session');
        return;
      }
    }
    ws.sessionId = managed.sessionId;

    const send = (msg: WsServerMessage) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    };

    // Wire up callbacks from PTY to this WebSocket
    managed.onOutput = (data) => send({ type: 'output', data });
    managed.onError = (data) => send({ type: 'error', data });
    managed.onExit = (code) => send({ type: 'exit', code });

    send({ type: 'ready', sessionId: managed.sessionId });

    // Replay buffered output so client catches up after reconnection
    if (isReconnect && managed.outputBuffer) {
      send({ type: 'output', data: managed.outputBuffer });
    }

    ws.on('message', (raw) => {
      let msg: WsClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as WsClientMessage;
      } catch {
        return;
      }

      if (msg.type === 'input') {
        writeToSession(ws.sessionId!, msg.data);
      } else if (msg.type === 'resize') {
        const session = managed;
        if (session && msg.cols && msg.rows) {
          session.ptyProcess.resize(msg.cols, msg.rows);
        }
      } else if (msg.type === 'ping') {
        send({ type: 'pong' });
      }
    });

    ws.on('close', () => {
      // Detach WS callbacks but keep PTY alive for reconnection
      if (ws.sessionId) detachSession(ws.sessionId);
    });

    ws.on('error', (err) => {
      console.error('[ws] socket error', err.message);
      if (ws.sessionId) detachSession(ws.sessionId);
    });
  });

  return wss;
}
