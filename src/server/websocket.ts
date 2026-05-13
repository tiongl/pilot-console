import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import { getUserFromToken, SESSION_COOKIE } from './middleware/auth';
import { createCliSession, writeToSession, endCliSession, findActiveSession, detachSession, getSession, flushOutputBuffer, cliBridgeEvents, type SessionMode } from '../shared/cli-bridge';
import { getDaemonClient } from '../daemon/client';
import type { WsClientMessage, WsServerMessage } from '../shared/types';
import { getOrCreateSessionPerf, recordPerfPong, markPerfPingSent, recordOutputBatch, recordFlush, removeSessionPerf, traceStart } from './perf-monitor';

interface AuthedSocket extends WebSocket {
  userId?: string;
  userRole?: string;
  sessionId?: string;
  isAlive?: boolean;
  wsId?: number;
}

let wsIdCounter = 0;
let _wss: WebSocketServer | null = null;

/** Broadcast a report-ready event to all connected users */
export function broadcastReportReady(payload: {
  runId: string;
  scheduleId: string;
  scheduleName: string;
  status: string;
}): void {
  if (!_wss) return;
  const msg = JSON.stringify({ type: 'report-ready', ...payload });
  _wss.clients.forEach((ws) => {
    const socket = ws as AuthedSocket;
    if (socket.readyState === WebSocket.OPEN && socket.userId) {
      socket.send(msg);
    }
  });
}

/** Broadcast schedule list changes so clients can refresh automation navigation */
export function broadcastScheduleChanged(payload: {
  action: 'created' | 'updated' | 'deleted' | 'imported';
  scheduleId?: string;
}): void {
  if (!_wss) return;
  const msg = JSON.stringify({ type: 'schedule-changed', ...payload });
  _wss.clients.forEach((ws) => {
    const socket = ws as AuthedSocket;
    if (socket.readyState === WebSocket.OPEN && socket.userId) {
      socket.send(msg);
    }
  });
}

export function setupWebSocketServer(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  _wss = wss;

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

  // Subscribe to git-activity events from cli-bridge and broadcast to the owning user
  cliBridgeEvents.on('git-activity', (payload: { userId: string; projectId: string; worktreeId: string | null }) => {
    if (!_wss) return;
    const msg = JSON.stringify({
      type: 'git-changed',
      projectId: payload.projectId,
      worktreeId: payload.worktreeId,
    });
    _wss.clients.forEach((ws) => {
      const socket = ws as AuthedSocket;
      if (socket.readyState === WebSocket.OPEN && socket.userId === payload.userId) {
        socket.send(msg);
      }
    });
  });

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
    ws.userRole = user.role;

    const url = new URL(req.url ?? '', `http://${req.headers.host}`);
    const projectId = url.searchParams.get('projectId');
    const worktreeId = url.searchParams.get('worktreeId');
    const requestedSessionId = url.searchParams.get('sessionId');
    const forceNew = url.searchParams.get('new') === 'true';
    const notifyOnly = url.searchParams.get('notify') === 'true';
    const modeParam = url.searchParams.get('mode');
    const mode = (['shell', 'powershell'].includes(modeParam!) ? modeParam : 'cli') as SessionMode;

    // Notify-only connections just receive broadcasts (e.g. report-ready) — no CLI session
    if (notifyOnly) {
      ws.isAlive = true;
      return;
    }

    let managed;
    let isReconnect = false;

    if (requestedSessionId) {
      managed = getSession(requestedSessionId);
      if (managed && managed.alive) {
        // Verify ownership
        if (managed.userId !== ws.userId) {
          ws.close(4005, 'Not your session');
          return;
        }
        isReconnect = true;
      } else {
        ws.close(4003, 'Session not found');
        return;
      }
    } else if (forceNew) {
      try {
        managed = createCliSession(ws.userId, projectId, mode, worktreeId);
      } catch (err) {
        console.error('[ws] failed to create CLI session:', err);
        ws.close(4002, 'Failed to create session');
        return;
      }
    } else {
      managed = findActiveSession(ws.userId, projectId ?? null, mode, worktreeId);
      isReconnect = !!managed;
      if (!managed) {
        try {
          managed = createCliSession(ws.userId, projectId, mode, worktreeId);
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

    // --- Batched output sender ---
    // During burst output the daemon can fire dozens of output events in a
    // single event-loop tick (the TCP data handler parses all lines
    // synchronously).  Sending each as a separate WS message floods the
    // browser with onmessage/JSON.parse calls, freezing the UI.
    // We coalesce chunks and flush once per tick via setImmediate, falling
    // back to a 16ms timer for sustained cross-tick output.
    let outChunks: string[] = [];
    let outLen = 0;
    let flushHandle: ReturnType<typeof setImmediate> | null = null;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const flushOutput = () => {
      if (flushHandle) { clearImmediate(flushHandle); flushHandle = null; }
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (outLen === 0) return;
      const stop = traceStart('ws:flushOutput');
      const data = outChunks.length === 1 ? outChunks[0] : outChunks.join('');
      recordOutputBatch(managed!.sessionId, outLen);
      recordFlush(managed!.sessionId);
      outChunks = [];
      outLen = 0;
      send({ type: 'output', data });
      stop();
    };

    managed.onOutput = (data) => {
      outChunks.push(data);
      outLen += data.length;
      // Flush large buffers immediately to bound memory
      if (outLen > 32_768) { flushOutput(); return; }
      if (!flushHandle) {
        flushHandle = setImmediate(flushOutput);
        // Safety cap: if output keeps arriving across ticks, flush at 16ms
        if (!flushTimer) flushTimer = setTimeout(flushOutput, 16);
      }
    };
    managed.onError = (data) => { flushOutput(); send({ type: 'error', data }); };
    managed.onExit = (code, reason) => {
      flushOutput();
      console.log(`[ws] session ${managed!.sessionId} exited: code=${code} reason=${reason ?? 'normal'}`);
      send({ type: 'exit', code });
      if (reason === 'daemon-lost') {
        ws.close(4010, 'Daemon session lost');
      }
    };

    // --- Perf-ping interval: measure WS round-trip latency every 5s ---
    getOrCreateSessionPerf(managed.sessionId);
    const perfPingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        markPerfPingSent(managed!.sessionId);
        send({ type: 'perf-ping', ts: Date.now() });
      }
    }, 5_000);

    console.log(`[ws] WS ${ws.wsId} session ready: ${managed.sessionId}, isReconnect=${isReconnect}, alive=${managed.alive}, bufferLen=${managed.outputBuffer?.length ?? 0}`);
    send({ type: 'ready', sessionId: managed.sessionId });

    if (isReconnect && managed.outputBuffer) {
      flushOutputBuffer(managed);
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
          getDaemonClient().resizeSession(managed.sessionId, msg.cols, msg.rows);
        }
      } else if (msg.type === 'ping') {
        send({ type: 'pong' });
      } else if (msg.type === 'perf-pong') {
        recordPerfPong(ws.sessionId!);
      }
    });

    ws.on('close', () => {
      flushOutput();
      clearInterval(perfPingInterval);
      console.log(`[ws] WS ${ws.wsId} closed for session ${ws.sessionId}`);
      if (ws.sessionId) {
        removeSessionPerf(ws.sessionId);
        detachSession(ws.sessionId, ws.wsId);
      }
    });

    ws.on('error', (err) => {
      flushOutput();
      clearInterval(perfPingInterval);
      console.error(`[ws] WS ${ws.wsId} error for session ${ws.sessionId}:`, err.message);
      if (ws.sessionId) {
        removeSessionPerf(ws.sessionId);
        detachSession(ws.sessionId, ws.wsId);
      }
    });
  });

  return wss;
}
