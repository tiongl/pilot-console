import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import { getUserFromToken, SESSION_COOKIE } from './middleware/auth';
import { createCliSession, writeToSession, endCliSession, findActiveSession, detachSession, getSession, type SessionMode } from '../shared/cli-bridge';
import { getDaemonClient } from '../daemon/client';
import type { WsClientMessage, WsServerMessage } from '../shared/types';

interface AuthedSocket extends WebSocket {
  userId?: string;
  sessionId?: string;
  isAlive?: boolean;
  wsId?: number;
}

let wsIdCounter = 0;

export function setupWebSocketServer(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      const socket = ws as AuthedSocket;
      if (socket.isAlive === false) {
        if (socket.sessionId) detachSession(socket.sessionId, socket.wsId);
        return socket.terminate();
      }
      socket.isAlive = false;
      socket.ping();
    });
  }, 30_000);

  wss.on('close', () => clearInterval(heartbeat));

  wss.on('connection', async (ws: AuthedSocket, req: IncomingMessage) => {
    ws.isAlive = true;
    ws.wsId = ++wsIdCounter;
    ws.on('pong', () => { ws.isAlive = true; });

    // Auth: read session cookie
    const cookieHeader = req.headers.cookie ?? '';
    const sessionCookie = cookieHeader
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith(SESSION_COOKIE + '='))
      ?.split('=')
      .slice(1)
      .join('=');
    const token = sessionCookie ? decodeURIComponent(sessionCookie) : null;

    if (!token) {
      ws.close(4001, 'Missing session');
      return;
    }

    const user = getUserFromToken(token);
    if (!user) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    ws.userId = user.id;

    const url = new URL(req.url ?? '', `http://${req.headers.host}`);
    const projectId = url.searchParams.get('projectId');
    const requestedSessionId = url.searchParams.get('sessionId');
    const forceNew = url.searchParams.get('new') === 'true';
    const modeParam = url.searchParams.get('mode');
    const mode = (['shell', 'powershell'].includes(modeParam!) ? modeParam : 'cli') as SessionMode;

    let managed;
    let isReconnect = false;

    if (requestedSessionId) {
      managed = getSession(requestedSessionId);
      if (managed && managed.alive) {
        // Verify ownership
        if (managed.userId !== ws.userId) {
          ws.close(4003, 'Not your session');
          return;
        }
        isReconnect = true;
      } else {
        ws.close(4003, 'Session not found');
        return;
      }
    } else if (forceNew) {
      try {
        managed = createCliSession(ws.userId, projectId, mode);
      } catch (err) {
        console.error('[ws] failed to create CLI session:', err);
        ws.close(4002, 'Failed to create session');
        return;
      }
    } else {
      managed = findActiveSession(ws.userId, projectId ?? null, mode);
      isReconnect = !!managed;
      if (!managed) {
        try {
          managed = createCliSession(ws.userId, projectId, mode);
        } catch (err) {
          console.error('[ws] failed to create CLI session:', err);
          ws.close(4002, 'Failed to create session');
          return;
        }
      }
    }
    ws.sessionId = managed.sessionId;

    const send = (msg: WsServerMessage) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    };

    managed.activeWsId = ws.wsId!;
    managed.onOutput = (data) => send({ type: 'output', data });
    managed.onError = (data) => send({ type: 'error', data });
    managed.onExit = (code) => {
      console.log(`[ws] session ${managed!.sessionId} exited: code=${code}`);
      send({ type: 'exit', code });
    };

    console.log(`[ws] WS ${ws.wsId} session ready: ${managed.sessionId}, isReconnect=${isReconnect}, alive=${managed.alive}, bufferLen=${managed.outputBuffer?.length ?? 0}`);
    send({ type: 'ready', sessionId: managed.sessionId });

    if (isReconnect && managed.outputBuffer) {
      send({ type: 'output', data: managed.outputBuffer });
    }

    ws.on('message', (raw) => {
      let msg: WsClientMessage;
      try { msg = JSON.parse(raw.toString()) as WsClientMessage; } catch { return; }
      if (msg.type === 'input') {
        const ok = writeToSession(ws.sessionId!, msg.data);
        if (!ok) console.warn(`[ws] writeToSession failed for ${ws.sessionId} (session gone?)`);
      } else if (msg.type === 'resize') {
        if (managed && msg.cols && msg.rows) {
          managed.lastResizeAt = Date.now();
          getDaemonClient().resizeSession(managed.sessionId, msg.cols, msg.rows).catch(() => {});
        }
      } else if (msg.type === 'ping') {
        send({ type: 'pong' });
      }
    });

    ws.on('close', () => {
      console.log(`[ws] WS ${ws.wsId} closed for session ${ws.sessionId}`);
      if (ws.sessionId) detachSession(ws.sessionId, ws.wsId);
    });

    ws.on('error', (err) => {
      console.error(`[ws] WS ${ws.wsId} error for session ${ws.sessionId}:`, err.message);
      if (ws.sessionId) detachSession(ws.sessionId, ws.wsId);
    });
  });

  return wss;
}
