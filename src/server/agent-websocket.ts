import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import { getUserFromToken, SESSION_COOKIE } from './middleware/auth';
import {
  createAgentSession,
  getAgentSession,
  findAgentSession,
  subscribe,
  getReplay,
  sendAgentMessage,
  cancelAgent,
  setAgentModel,
  setAgentMode,
  respondToPermission,
  respondToExitPlan,
  listAgentCommands,
  runAgentCommand,
  listAgentSessionSummaries,
  resumeAgentSession,
  getAgentDiff,
} from '../shared/agent-bridge';
import type { AgentClientMessage, AgentServerMessage } from '../shared/types';

interface AuthedAgentSocket extends WebSocket {
  userId?: string;
  isAlive?: boolean;
}

let _wss: WebSocketServer | null = null;

export function setupAgentWebSocketServer(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  _wss = wss;

  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      const socket = ws as AuthedAgentSocket;
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

  wss.on('connection', async (ws: AuthedAgentSocket, req: IncomingMessage) => {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    // Auth via session cookie (same scheme as the terminal WS)
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
    const projectId = url.searchParams.get('projectId');
    const worktreeId = url.searchParams.get('worktreeId');
    const requestedSessionId = url.searchParams.get('sessionId');
    const forceNew = url.searchParams.get('new') === 'true';
    const model = url.searchParams.get('model') || undefined;

    const send = (msg: AgentServerMessage) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };

    // Resolve or create the agent session.
    let session;
    if (requestedSessionId) {
      session = getAgentSession(requestedSessionId);
      if (session && session.alive) {
        if (session.userId !== ws.userId) {
          ws.close(4005, 'Not your session');
          return;
        }
      } else {
        // Not live in memory — try resuming it from the SDK (session switcher
        // targets, or sessions dropped after a server restart).
        session = await resumeAgentSession(ws.userId, requestedSessionId);
        if (!session) {
          ws.close(4003, 'Session not found');
          return;
        }
      }
    } else if (forceNew) {
      session = await createSafe(ws, ws.userId, projectId, worktreeId, model);
      if (!session) return;
    } else {
      session = findAgentSession(ws.userId, projectId ?? null, worktreeId ?? null);
      if (!session) {
        session = await createSafe(ws, ws.userId, projectId, worktreeId, model);
        if (!session) return;
      }
    }

    const sessionId = session.sessionId;

    // Subscribe to live events, then replay the buffered transcript so the
    // client renders the full conversation on (re)connect.
    const unsubscribe = subscribe(sessionId, send);
    send({
      type: 'ready',
      sessionId,
      model: session.model,
      mode: session.mode,
      status: session.status,
    });
    send({ type: 'replay', events: getReplay(sessionId) });

    // Push the dynamic slash-command catalog (plugin/skill-aware).
    listAgentCommands(sessionId)
      .then((commands) => send({ type: 'commands', commands }))
      .catch(() => {});

    ws.on('message', async (raw) => {
      let msg: AgentClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as AgentClientMessage;
      } catch {
        return;
      }
      switch (msg.type) {
        case 'send':
          await sendAgentMessage(sessionId, msg.prompt);
          break;
        case 'cancel':
          await cancelAgent(sessionId);
          break;
        case 'permission_response':
          respondToPermission(sessionId, msg.requestId, msg.decision);
          break;
        case 'exit_plan_response':
          respondToExitPlan(sessionId, msg.requestId, msg.action);
          break;
        case 'set_mode':
          setAgentMode(sessionId, msg.mode);
          break;
        case 'set_model':
          await setAgentModel(sessionId, msg.model);
          break;
        case 'list_commands':
          send({ type: 'commands', commands: await listAgentCommands(sessionId) });
          break;
        case 'run_command':
          await runAgentCommand(sessionId, msg.name, msg.input);
          break;
        case 'list_sessions':
          send({ type: 'sessions', sessions: await listAgentSessionSummaries(sessionId) });
          break;
        case 'get_diff': {
          const { content, truncated } = await getAgentDiff(sessionId);
          send({ type: 'diff', content, truncated });
          break;
        }
        case 'replay':
          send({ type: 'replay', events: getReplay(sessionId) });
          break;
      }
    });

    ws.on('close', () => {
      unsubscribe();
    });
  });

  return wss;
}

async function createSafe(
  ws: AuthedAgentSocket,
  userId: string,
  projectId: string | null,
  worktreeId: string | null,
  model?: string,
) {
  try {
    return await createAgentSession(userId, projectId, worktreeId, model);
  } catch (err) {
    console.error('[agent-ws] failed to create agent session:', err);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'error', message: 'Failed to start agent session. Check Copilot CLI auth.' } satisfies AgentServerMessage));
    }
    ws.close(4002, 'Failed to create session');
    return undefined;
  }
}

export function getAgentWss(): WebSocketServer | null {
  return _wss;
}
