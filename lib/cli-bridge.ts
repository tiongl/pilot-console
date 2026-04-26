import { spawn, ChildProcess } from 'child_process';
import { getDb } from './app-db';
import { getProjectById } from './project-store';

export interface ManagedProcess {
  sessionId: string;
  userId: string;
  projectId: string | null;
  process: ChildProcess;
  onOutput: ((data: string) => void) | null;
  onError: ((data: string) => void) | null;
  onExit: ((code: number) => void) | null;
}

const activeSessions = new Map<string, ManagedProcess>();

const CLI_COMMAND = process.env.COPILOT_CLI_COMMAND ?? 'gh';
const CLI_ARGS = (process.env.COPILOT_CLI_ARGS ?? 'copilot').split(' ').filter(Boolean);

export function createCliSession(userId: string, projectId?: string | null): ManagedProcess {
  const sessionId = crypto.randomUUID();

  let cwd: string | undefined;
  if (projectId) {
    const project = getProjectById(projectId);
    if (project) {
      cwd = project.repoPath;
    }
  }

  const proc = spawn(CLI_COMMAND, CLI_ARGS, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '1' },
    ...(cwd ? { cwd } : {}),
  });

  const managed: ManagedProcess = {
    sessionId,
    userId,
    projectId: projectId ?? null,
    process: proc,
    onOutput: null,
    onError: null,
    onExit: null,
  };

  proc.stdout?.on('data', (data: Buffer) => {
    const text = data.toString();
    managed.onOutput?.(text);
    extractAndStoreSessionId(sessionId, text);
  });

  proc.stderr?.on('data', (data: Buffer) => {
    managed.onError?.(data.toString());
  });

  proc.on('exit', (code) => {
    managed.onExit?.(code ?? -1);
    endCliSession(sessionId);
  });

  activeSessions.set(sessionId, managed);

  getDb()
    .prepare('INSERT INTO cli_sessions (id, user_id, project_id) VALUES (?, ?, ?)')
    .run(sessionId, userId, projectId ?? null);

  return managed;
}

export function writeToSession(sessionId: string, data: string): boolean {
  const session = activeSessions.get(sessionId);
  if (!session?.process.stdin?.writable) return false;
  session.process.stdin.write(data);
  return true;
}

export function endCliSession(sessionId: string): void {
  const session = activeSessions.get(sessionId);
  if (!session) return;
  try { session.process.kill(); } catch { /* already dead */ }
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
