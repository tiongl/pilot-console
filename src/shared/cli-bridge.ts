import { getDb } from './db';
import { getProjectById, getWorktreeById } from './project-store';
import { getDaemonClient } from '../daemon/client';
import { traceStart } from '../server/perf-monitor';
import { EventEmitter } from 'events';

const MAX_SCROLLBACK = 100_000; // chars to buffer for reconnection replay

// Event bus for git activity — decouples cli-bridge from websocket to avoid circular imports.
// Emits 'git-activity' with { userId, projectId, worktreeId } after output settles.
export const cliBridgeEvents = new EventEmitter();

export type SessionMode = 'cli' | 'cli-classic' | 'shell' | 'powershell';

export interface ManagedProcess {
  sessionId: string;
  userId: string;
  projectId: string | null;
  worktreeId: string | null;
  mode: SessionMode;
  outputBuffer: string;
  /** Array-based buffer for incoming output — joined on read to avoid O(n) concat per chunk */
  _outputChunks: string[];
  _outputChunksLen: number;
  onOutput: ((data: string) => void) | null;
  onError: ((data: string) => void) | null;
  onExit: ((code: number, reason?: 'normal' | 'daemon-lost') => void) | null;
  alive: boolean;
  lastOutputAt: number;
  /** Timestamp of last resize — output right after resize is just a redraw, not real work */
  lastResizeAt: number;
  lastExitCode: number | null;
  exitedAt: number | null;
  /** Tracks the currently active WebSocket connection (used to prevent stale detach) */
  activeWsId: number | null;
}

const activeSessions = new Map<string, ManagedProcess>();
const recentlyExited = new Map<string, ManagedProcess>();
const EXITED_RETENTION_MS = 30_000;

// Idle detection: session is "busy" only while it is actively producing output.
// We use a simple time-since-last-output approach with a 5-second cooldown.
const IDLE_AFTER_MS = 5_000;

// Cached regex for idle detection — avoids re-compiling on every output chunk
const VISIBLE_CONTENT_RE = /[^\x1b\x07\x08\r\n\t ]/;

// Trailing debounce for git-activity events per project+worktree.
// Fires after output quiets down for 3 seconds, so clients refresh after changes settle.
const GIT_ACTIVITY_DEBOUNCE_MS = 3_000;
const gitActivityTimers = new Map<string, ReturnType<typeof setTimeout>>();

function notifyGitActivity(userId: string, projectId: string | null, worktreeId: string | null) {
  if (!projectId) return;
  const key = `${projectId}:${worktreeId ?? ''}`;
  const existing = gitActivityTimers.get(key);
  if (existing) clearTimeout(existing);
  gitActivityTimers.set(key, setTimeout(() => {
    gitActivityTimers.delete(key);
    cliBridgeEvents.emit('git-activity', { userId, projectId, worktreeId });
  }, GIT_ACTIVITY_DEBOUNCE_MS));
}

/** Compact the output chunks into a single string and enforce MAX_SCROLLBACK */
export function flushOutputBuffer(managed: ManagedProcess): string {
  if (managed._outputChunks.length > 0) {
    managed.outputBuffer += managed._outputChunks.join('');
    managed._outputChunks = [];
    managed._outputChunksLen = 0;
  }
  if (managed.outputBuffer.length > MAX_SCROLLBACK) {
    managed.outputBuffer = managed.outputBuffer.slice(-MAX_SCROLLBACK);
  }
  return managed.outputBuffer;
}

export type SessionStatus = 'idle' | 'busy' | 'exited';

export function getSessionStatus(session: ManagedProcess): SessionStatus {
  if (!session.alive) return 'exited';

  // If we've never seen output or last output was long enough ago → idle
  if (!session.lastOutputAt) return 'idle';
  return (Date.now() - session.lastOutputAt) < IDLE_AFTER_MS ? 'busy' : 'idle';
}

const CLI_COMMAND = process.env.COPILOT_CLI_COMMAND ?? 'gh';
const CLI_ARGS = (process.env.COPILOT_CLI_ARGS ?? 'copilot').split(' ').filter(Boolean);

const IS_WINDOWS = process.platform === 'win32';
const SHELL = IS_WINDOWS
  ? (process.env.COMSPEC || 'cmd.exe')
  : (process.env.SHELL || '/bin/bash');

/** Find an existing live session for a user+project+worktree+mode combo */
export function findActiveSession(userId: string, projectId: string | null, mode: SessionMode = 'cli', worktreeId?: string | null): ManagedProcess | undefined {
  for (const s of activeSessions.values()) {
    if (s.userId === userId && s.projectId === projectId && s.mode === mode && (s.worktreeId ?? null) === (worktreeId ?? null) && s.alive) return s;
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
 * Shared exit cleanup — used for both normal daemon exit events
 * and synthetic exits when the daemon restarts or connection is lost.
 * Idempotent: safe to call multiple times for the same session.
 */
function finalizeSessionExit(managed: ManagedProcess, code: number, reason: 'normal' | 'daemon-lost' = 'normal') {
  if (!managed.alive && managed.exitedAt) return; // already finalized
  const stop = traceStart('cli-bridge:finalizeExit');
  managed.alive = false;
  managed.lastExitCode = code;
  managed.exitedAt = Date.now();
  managed.onExit?.(code, reason);
  activeSessions.delete(managed.sessionId);
  recentlyExited.set(managed.sessionId, managed);
  setTimeout(() => recentlyExited.delete(managed.sessionId), EXITED_RETENTION_MS);
  getDaemonClient().removeListeners(managed.sessionId);
  flushOutputBuffer(managed);
  const stopDb = traceStart('cli-bridge:exitDbWrite');
  getDb()
    .prepare("UPDATE cli_sessions SET ended_at = datetime('now'), output_log = ? WHERE id = ?")
    .run(managed.outputBuffer || null, managed.sessionId);
  stopDb();
  stop();
}

/**
 * Wire a ManagedProcess to the daemon's output/exit streams.
 * Whenever the daemon sends output for this session, it arrives through the
 * client singleton and is forwarded to the ManagedProcess callbacks.
 */
function wireDaemonListeners(managed: ManagedProcess) {
  const client = getDaemonClient();

  client.onOutput(managed.sessionId, (data: string) => {
    const stop = traceStart('cli-bridge:onOutput');
    managed._outputChunks.push(data);
    managed._outputChunksLen += data.length;
    // Only compact when total buffered length exceeds scrollback limit
    if (managed._outputChunksLen > MAX_SCROLLBACK) {
      flushOutputBuffer(managed);
    }
    if (VISIBLE_CONTENT_RE.test(data)) {
      const sinceResize = managed.lastResizeAt ? Date.now() - managed.lastResizeAt : Infinity;
      if (sinceResize > 2_000) {
        managed.lastOutputAt = Date.now();
        notifyGitActivity(managed.userId, managed.projectId, managed.worktreeId);
      }
    }
    managed.onOutput?.(data);
    if (managed.mode === 'cli' || managed.mode === 'cli-classic') {
      extractAndStoreSessionId(managed.sessionId, data);
    }
    stop();
  });

  client.onExit(managed.sessionId, (code: number) => {
    finalizeSessionExit(managed, code);
  });
}

export function createCliSession(userId: string, projectId?: string | null, mode: SessionMode = 'cli', worktreeId?: string | null): ManagedProcess {
  const sessionId = crypto.randomUUID();

  let cwd: string | undefined;
  if (worktreeId) {
    const wt = getWorktreeById(worktreeId);
    if (wt?.worktreePath) {
      try {
        const fs = require('fs');
        if (fs.existsSync(wt.worktreePath)) {
          cwd = wt.worktreePath;
        } else {
          console.warn(`[cli-bridge] Worktree path does not exist: ${wt.worktreePath}, using project repoPath`);
        }
      } catch {
        console.warn(`[cli-bridge] Failed to check worktree path: ${wt.worktreePath}`);
      }
    }
  }
  if (!cwd && projectId) {
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
    worktreeId: worktreeId ?? null,
    mode,
    outputBuffer: '',
    _outputChunks: [],
    _outputChunksLen: 0,
    onOutput: null,
    onError: null,
    onExit: null,
    alive: true,
    lastOutputAt: 0,
    lastResizeAt: 0,
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
    meta: { userId, projectId: projectId ?? null, worktreeId: worktreeId ?? null, mode, source: 'interactive' },
    // "Classic terminal" mode presents an accurate terminal identity to the
    // child (matching xterm.js) instead of the blanked-out TERM the daemon
    // normally uses on Windows to dodge ink/ConPTY rendering bugs.
    ptyName: mode === 'cli-classic' ? 'xterm-256color' : undefined,
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
  return getDaemonClient().writeToSession(sessionId, data);
}

export function endCliSession(sessionId: string, opts?: { skipDaemonKill?: boolean }): void {
  const session = activeSessions.get(sessionId);
  if (!session) return;
  flushOutputBuffer(session);
  getDb()
    .prepare("UPDATE cli_sessions SET ended_at = datetime('now'), output_log = ? WHERE id = ?")
    .run(session.outputBuffer || null, sessionId);
  if (!opts?.skipDaemonKill) {
    getDaemonClient().killSession(sessionId).catch(() => { /* ok */ });
  }
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
      await client.connect(true); // auto-start daemon on server boot
      break;
    } catch (err) {
      console.error(`[cli-bridge] Failed to connect to daemon (attempt ${attempt}/${maxRetries}):`, err);
      if (attempt === maxRetries) {
        console.warn('[cli-bridge] Daemon not running. Start it from the Daemon page.');
        return;
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // --- Daemon lifecycle callbacks ---

  // When connection drops, immediately mark all sessions as disconnected.
  // The onExit callbacks will notify WebSocket clients.
  client.onConnectionLost(() => {
    console.warn('[cli-bridge] Daemon connection lost — marking all active sessions as dead');
    const sessions = [...activeSessions.values()];
    for (const s of sessions) {
      finalizeSessionExit(s, -1, 'daemon-lost');
    }
  });

  // When we reconnect to a different daemon, sessions are already cleaned up
  // by onConnectionLost above. Nothing extra needed.
  client.onDaemonRestarted(() => {
    console.log('[cli-bridge] Daemon restarted — previous sessions already cleaned up');
  });

  // When we reconnect to the same daemon (transient socket drop),
  // re-attach to all sessions that the daemon still owns.
  client.onReconnected(async (sameDaemon: boolean) => {
    if (!sameDaemon) return; // handled by onDaemonRestarted
    console.log('[cli-bridge] Re-attaching to surviving daemon sessions...');
    const surviving = [...activeSessions.values()].filter(s => s.alive);
    for (const s of surviving) {
      try {
        const attached = await client.attachSession(s.sessionId);
        s.outputBuffer = attached.buffer;
        s._outputChunks = [];
        s._outputChunksLen = 0;
        if (!attached.alive) {
          finalizeSessionExit(s, attached.exitCode ?? -1);
        }
      } catch {
        console.warn(`[cli-bridge] Failed to re-attach session ${s.sessionId}, marking dead`);
        finalizeSessionExit(s, -1);
      }
    }
  });

  // Discover sessions that survived the server restart
  await reconcileDaemonSessions(client);
}

/**
 * Reconcile active sessions from the daemon (used at startup and after reconnect).
 */
async function reconcileDaemonSessions(client: ReturnType<typeof getDaemonClient>): Promise<void> {
  const daemonSessions = await client.listSessions();
  const db = getDb();
  let recovered = 0;

  for (const info of daemonSessions) {
    if (!info.alive) continue; // skip exited
    if (activeSessions.has(info.sessionId)) continue; // already known

    const userId = info.meta?.userId ?? 'unknown';
    const projectId = info.meta?.projectId ?? null;
    const worktreeId = info.meta?.worktreeId ?? null;

    const managed: ManagedProcess = {
      sessionId: info.sessionId,
      userId,
      projectId,
      worktreeId,
      mode: (info.meta?.mode as SessionMode) || 'cli',
      outputBuffer: '',
      _outputChunks: [],
      _outputChunksLen: 0,
      onOutput: null,
      onError: null,
      onExit: null,
      alive: true,
      lastOutputAt: info.lastOutputAt,
      lastResizeAt: 0,
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

/** Set of sessions that already have a copilot_session_id — skip further extraction */
const capturedCopilotSessions = new Set<string>();

/** Try to extract a Copilot session UUID from CLI output and persist it */
function extractAndStoreSessionId(sessionId: string, output: string) {
  if (capturedCopilotSessions.has(sessionId)) return;
  const match = output.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (match) {
    const db = getDb();
    const row = db.prepare('SELECT copilot_session_id FROM cli_sessions WHERE id = ?').get(sessionId) as { copilot_session_id: string | null } | undefined;
    if (row && !row.copilot_session_id) {
      db.prepare('UPDATE cli_sessions SET copilot_session_id = ? WHERE id = ?').run(match[0], sessionId);
    }
    capturedCopilotSessions.add(sessionId);
  }
}
