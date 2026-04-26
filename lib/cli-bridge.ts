import * as pty from 'node-pty';
import { getDb } from './app-db';
import { getProjectById } from './project-store';

const MAX_SCROLLBACK = 100_000; // chars to buffer for reconnection replay

export interface ManagedProcess {
  sessionId: string;
  userId: string;
  projectId: string | null;
  ptyProcess: pty.IPty;
  outputBuffer: string;
  onOutput: ((data: string) => void) | null;
  onError: ((data: string) => void) | null;
  onExit: ((code: number) => void) | null;
  alive: boolean;
}

const activeSessions = new Map<string, ManagedProcess>();

const CLI_COMMAND = process.env.COPILOT_CLI_COMMAND ?? 'gh';
const CLI_ARGS = (process.env.COPILOT_CLI_ARGS ?? 'copilot').split(' ').filter(Boolean);

// node-pty on Windows needs the shell to resolve commands in PATH
const IS_WINDOWS = process.platform === 'win32';
const SHELL = IS_WINDOWS ? 'cmd.exe' : '/bin/bash';

/** Find an existing live session for a user+project combo */
export function findActiveSession(userId: string, projectId: string | null): ManagedProcess | undefined {
  for (const s of activeSessions.values()) {
    if (s.userId === userId && s.projectId === projectId && s.alive) return s;
  }
  return undefined;
}

/** Detach WS callbacks without killing the PTY */
export function detachSession(sessionId: string): void {
  const session = activeSessions.get(sessionId);
  if (session) {
    session.onOutput = null;
    session.onError = null;
    session.onExit = null;
  }
}

export function createCliSession(userId: string, projectId?: string | null): ManagedProcess {
  const sessionId = crypto.randomUUID();

  let cwd: string | undefined;
  if (projectId) {
    const project = getProjectById(projectId);
    if (project) {
      cwd = project.repoPath;
    }
  }

  // Use shell to resolve commands in PATH (node-pty needs full paths on Windows)
  const shellArgs = IS_WINDOWS
    ? ['/c', CLI_COMMAND, ...CLI_ARGS]
    : ['-c', `${CLI_COMMAND} ${CLI_ARGS.join(' ')}`];

  const ptyProc = pty.spawn(SHELL, shellArgs, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: cwd || process.cwd(),
    env: { ...process.env } as Record<string, string>,
  });

  const managed: ManagedProcess = {
    sessionId,
    userId,
    projectId: projectId ?? null,
    ptyProcess: ptyProc,
    outputBuffer: '',
    onOutput: null,
    onError: null,
    onExit: null,
    alive: true,
  };

  ptyProc.onData((data: string) => {
    // Always buffer output for reconnection replay
    managed.outputBuffer += data;
    if (managed.outputBuffer.length > MAX_SCROLLBACK) {
      managed.outputBuffer = managed.outputBuffer.slice(-MAX_SCROLLBACK);
    }
    managed.onOutput?.(data);
    extractAndStoreSessionId(sessionId, data);
  });

  ptyProc.onExit(({ exitCode }) => {
    managed.alive = false;
    managed.onExit?.(exitCode);
    activeSessions.delete(sessionId);
    getDb()
      .prepare("UPDATE cli_sessions SET ended_at = datetime('now') WHERE id = ?")
      .run(sessionId);
  });

  activeSessions.set(sessionId, managed);

  getDb()
    .prepare('INSERT INTO cli_sessions (id, user_id, project_id) VALUES (?, ?, ?)')
    .run(sessionId, userId, projectId ?? null);

  return managed;
}

export function writeToSession(sessionId: string, data: string): boolean {
  const session = activeSessions.get(sessionId);
  if (!session) return false;
  session.ptyProcess.write(data);
  return true;
}

export function endCliSession(sessionId: string): void {
  const session = activeSessions.get(sessionId);
  if (!session) return;
  try { session.ptyProcess.kill(); } catch { /* already dead */ }
  activeSessions.delete(sessionId);
  getDb()
    .prepare("UPDATE cli_sessions SET ended_at = datetime('now') WHERE id = ?")
    .run(sessionId);
}

export function getSessionsByUser(userId: string): ManagedProcess[] {
  return [...activeSessions.values()].filter((s) => s.userId === userId);
}

export function getAllSessions(): ManagedProcess[] {
  return [...activeSessions.values()];
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
