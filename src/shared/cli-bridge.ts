import { getDb } from './db';
import { getProjectById } from './project-store';
import { getDaemonClient } from '../daemon/client';

const MAX_SCROLLBACK = 100_000; // chars to buffer for reconnection replay

export type SessionMode = 'cli' | 'shell' | 'powershell';

export interface ManagedProcess {
  sessionId: string;
  userId: string;
  projectId: string | null;
  mode: SessionMode;
  outputBuffer: string;
  onOutput: ((data: string) => void) | null;
  onError: ((data: string) => void) | null;
  onExit: ((code: number) => void) | null;
  alive: boolean;
  lastOutputAt: number;
  lastExitCode: number | null;
  exitedAt: number | null;
  /** Tracks the currently active WebSocket connection (used to prevent stale detach) */
  activeWsId: number | null;
}

const activeSessions = new Map<string, ManagedProcess>();
const recentlyExited = new Map<string, ManagedProcess>();
const EXITED_RETENTION_MS = 30_000;
const BUSY_THRESHOLD_MS = 10_000;

export type SessionStatus = 'idle' | 'busy' | 'exited';

export function getSessionStatus(session: ManagedProcess): SessionStatus {
  if (!session.alive) return 'exited';
  if (session.lastOutputAt > 0 && Date.now() - session.lastOutputAt < BUSY_THRESHOLD_MS) return 'busy';
  return 'idle';
}

const CLI_COMMAND = process.env.COPILOT_CLI_COMMAND ?? 'gh';
const CLI_ARGS = (process.env.COPILOT_CLI_ARGS ?? 'copilot').split(' ').filter(Boolean);

const IS_WINDOWS = process.platform === 'win32';
const SHELL = IS_WINDOWS
  ? (process.env.COMSPEC || 'cmd.exe')
  : (process.env.SHELL || '/bin/bash');

/** Find an existing live session for a user+project+mode combo */
export function findActiveSession(userId: string, projectId: string | null, mode: SessionMode = 'cli'): ManagedProcess | undefined {
  for (const s of activeSessions.values()) {
    if (s.userId === userId && s.projectId === projectId && s.mode === mode && s.alive) return s;
  }
  return undefined;
}

/** Return ALL live sessions for a user+project combo */
export function findAllActiveSessions(userId: string, projectId: string | null): ManagedProcess[] {
  return [...activeSessions.values()].filter(s => s.userId === userId && s.projectId === projectId && s.alive);
}

/** Detach WS callbacks without killing the PTY.
 *  If wsId is provided, only detach if this WS is still the active one (prevents stale detach race). */
export function detachSession(sessionId: string, wsId?: number): void {
  const session = activeSessions.get(sessionId);
  if (session) {
    if (wsId !== undefined && session.activeWsId !== wsId) {
      return;
    }
    session.onOutput = null;
    session.onError = null;
    session.onExit = null;
    session.activeWsId = null;
  }
}

/**
 * Wire a ManagedProcess to the daemon's output/exit streams.
 * Whenever the daemon sends output for this session, it arrives through the
 * client singleton and is forwarded to the ManagedProcess callbacks.
 */
function wireDaemonListeners(managed: ManagedProcess) {
  const client = getDaemonClient();

  client.onOutput(managed.sessionId, (data: string) => {
    managed.outputBuffer += data;
    if (managed.outputBuffer.length > MAX_SCROLLBACK) {
      managed.outputBuffer = managed.outputBuffer.slice(-MAX_SCROLLBACK);
    }
    managed.lastOutputAt = Date.now();
    managed.onOutput?.(data);
    if (managed.mode === 'cli') {
      extractAndStoreSessionId(managed.sessionId, data);
    }
  });

  client.onExit(managed.sessionId, (code: number) => {
    managed.alive = false;
    managed.lastExitCode = code;
    managed.exitedAt = Date.now();
    managed.onExit?.(code);
    activeSessions.delete(managed.sessionId);
    recentlyExited.set(managed.sessionId, managed);
    setTimeout(() => recentlyExited.delete(managed.sessionId), EXITED_RETENTION_MS);
    client.removeListeners(managed.sessionId);
    getDb()
      .prepare("UPDATE cli_sessions SET ended_at = datetime('now'), output_log = ? WHERE id = ?")
      .run(managed.outputBuffer || null, managed.sessionId);
  });
}

export function createCliSession(userId: string, projectId?: string | null, mode: SessionMode = 'cli'): ManagedProcess {
  const sessionId = crypto.randomUUID();

  let cwd: string | undefined;
  if (projectId) {
    const project = getProjectById(projectId);
    if (project?.repoPath) {
      try {
        const fs = require('fs');
        if (fs.existsSync(project.repoPath)) {
          cwd = project.repoPath;
        } else {
          console.warn(`[cli-bridge] Project repoPath does not exist: ${project.repoPath}, using process.cwd()`);
        }
      } catch {
        console.warn(`[cli-bridge] Failed to check repoPath: ${project.repoPath}`);
      }
    }
  }

  const resolvedCwd = cwd || process.cwd();
  console.log(`[cli-bridge] Creating ${mode} session ${sessionId}, cwd=${resolvedCwd}`);

  let shell: string;
  let shellArgs: string[];

  if (mode === 'powershell') {
    shell = IS_WINDOWS ? 'pwsh.exe' : 'pwsh';
    shellArgs = [];
  } else if (mode === 'shell') {
    // Plain shell — no gh copilot wrapper
    shell = SHELL;
    shellArgs = [];
  } else {
    // Copilot CLI mode — wrap in shell
    shell = SHELL;
    shellArgs = IS_WINDOWS
      ? ['/c', CLI_COMMAND, ...CLI_ARGS]
      : ['-c', `${CLI_COMMAND} ${CLI_ARGS.join(' ')}`];
  }

  const managed: ManagedProcess = {
    sessionId,
    userId,
    projectId: projectId ?? null,
    mode,
    outputBuffer: '',
    onOutput: null,
    onError: null,
    onExit: null,
    alive: true,
    lastOutputAt: 0,
    lastExitCode: null,
    exitedAt: null,
    activeWsId: null,
  };

  // Create session in daemon (async, but we fire-and-forget for API compat)
  const client = getDaemonClient();
  client.createSession({
    sessionId,
    cwd: resolvedCwd,
    shell,
    args: shellArgs,
    cols: 120,
    rows: 30,
    meta: { userId, projectId: projectId ?? null, mode },
  }).then(() => {
    // Attach to receive output
    return client.attachSession(sessionId);
  }).catch((err) => {
    console.error(`[cli-bridge] Failed to create daemon session ${sessionId}:`, err);
    managed.alive = false;
    managed.lastExitCode = -1;
    managed.exitedAt = Date.now();
    managed.onExit?.(-1);
    activeSessions.delete(sessionId);
  });

  wireDaemonListeners(managed);
  activeSessions.set(sessionId, managed);

  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO users (id, github_id, role) VALUES (?, ?, ?)').run(userId, userId, 'user');
  db.prepare('INSERT INTO cli_sessions (id, user_id, project_id) VALUES (?, ?, ?)').run(sessionId, userId, projectId ?? null);

  return managed;
}

export function writeToSession(sessionId: string, data: string): boolean {
  const session = activeSessions.get(sessionId);
  if (!session || !session.alive) return false;
  getDaemonClient().writeToSession(sessionId, data).catch((err) => {
    console.error(`[cli-bridge] writeToSession failed for ${sessionId}:`, err);
  });
  return true;
}

export function endCliSession(sessionId: string): void {
  const session = activeSessions.get(sessionId);
  if (!session) return;
  getDb()
    .prepare("UPDATE cli_sessions SET ended_at = datetime('now'), output_log = ? WHERE id = ?")
    .run(session.outputBuffer || null, sessionId);
  getDaemonClient().killSession(sessionId).catch(() => { /* ok */ });
  getDaemonClient().removeListeners(sessionId);
  activeSessions.delete(sessionId);
}

export function getSessionsByUser(userId: string): ManagedProcess[] {
  return [...activeSessions.values()].filter((s) => s.userId === userId);
}

export function getAllSessions(): ManagedProcess[] {
  return [...activeSessions.values()];
}

/** All active sessions plus recently exited ones (for status indicators) */
export function getAllSessionsWithExited(): ManagedProcess[] {
  return [...activeSessions.values(), ...recentlyExited.values()];
}

export function getSession(sessionId: string): ManagedProcess | undefined {
  return activeSessions.get(sessionId);
}

/** Find and kill the active session for a user+project combo */
export function endSessionByProject(userId: string, projectId: string): boolean {
  const session = findActiveSession(userId, projectId);
  if (!session) return false;
  endCliSession(session.sessionId);
  return true;
}

/**
 * Initialize the daemon connection and recover any surviving sessions.
 * Call this once during server startup.
 */
export async function initDaemonBridge(): Promise<void> {
  const client = getDaemonClient();
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await client.connect();
      break;
    } catch (err) {
      console.error(`[cli-bridge] Failed to connect to daemon (attempt ${attempt}/${maxRetries}):`, err);
      if (attempt === maxRetries) {
        console.error('[cli-bridge] Giving up on daemon connection. Terminals will not work.');
        return;
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // Discover sessions that survived the server restart
  const daemonSessions = await client.listSessions();
  const db = getDb();
  let recovered = 0;

  for (const info of daemonSessions) {
    if (!info.alive) continue; // skip exited
    if (activeSessions.has(info.sessionId)) continue; // already known

    const userId = info.meta?.userId ?? 'unknown';
    const projectId = info.meta?.projectId ?? null;

    const managed: ManagedProcess = {
      sessionId: info.sessionId,
      userId,
      projectId,
      mode: (info.meta?.mode as SessionMode) || 'cli',
      outputBuffer: '',
      onOutput: null,
      onError: null,
      onExit: null,
      alive: true,
      lastOutputAt: info.lastOutputAt,
      lastExitCode: null,
      exitedAt: null,
      activeWsId: null,
    };

    wireDaemonListeners(managed);
    activeSessions.set(info.sessionId, managed);

    // Attach to get the output buffer
    try {
      const attached = await client.attachSession(info.sessionId);
      managed.outputBuffer = attached.buffer;
      managed.alive = attached.alive;
      if (!attached.alive) {
        managed.lastExitCode = attached.exitCode;
        managed.exitedAt = Date.now();
      }
    } catch {
      console.warn(`[cli-bridge] Failed to attach to recovered session ${info.sessionId}`);
    }

    // Ensure DB row exists
    db.prepare('INSERT OR IGNORE INTO users (id, github_id, role) VALUES (?, ?, ?)').run(userId, userId, 'user');
    db.prepare('INSERT OR IGNORE INTO cli_sessions (id, user_id, project_id) VALUES (?, ?, ?)').run(info.sessionId, userId, projectId);

    recovered++;
  }

  if (recovered > 0) {
    console.log(`[cli-bridge] Recovered ${recovered} session(s) from daemon`);
  }
}

/** Try to extract a Copilot session UUID from CLI output and persist it */
function extractAndStoreSessionId(sessionId: string, output: string) {
  const match = output.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (match) {
    const db = getDb();
    const row = db.prepare('SELECT copilot_session_id FROM cli_sessions WHERE id = ?').get(sessionId) as { copilot_session_id: string | null } | undefined;
    if (row && !row.copilot_session_id) {
      db.prepare('UPDATE cli_sessions SET copilot_session_id = ? WHERE id = ?').run(match[0], sessionId);
    }
  }
}
