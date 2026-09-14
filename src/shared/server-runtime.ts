import { spawn } from 'child_process';
import { getProjectById } from './project-store';
import { updateServerStatus, setServerExitCode, getServerById } from './server-store';
import type { ProjectServer } from './server-store';

interface ServerProcess {
  serverId: string;
  process: ReturnType<typeof spawn>;
  startTime: number;
}

const activeServerProcesses = new Map<string, ServerProcess>();

/**
 * Live output/status streaming layer.
 *
 * Server stdout/stderr is buffered per-server (surviving process exit so a tab
 * opened after the fact can replay the backlog) and fanned out to any attached
 * subscribers (the `/ws/server` sockets). This mirrors the patterns used by the
 * agent/terminal sockets without touching the agent SDK machinery.
 */
export type ServerStreamEvent =
  | { type: 'output'; data: string }
  | { type: 'status'; status: ProjectServer['status']; exitCode: number | null };

type ServerStreamListener = (event: ServerStreamEvent) => void;

const MAX_BUFFER = 100_000; // Keep last 100KB of output per server.
const serverOutputBuffers = new Map<string, string>();
const serverListeners = new Map<string, Set<ServerStreamListener>>();

function emitServer(serverId: string, event: ServerStreamEvent): void {
  const listeners = serverListeners.get(serverId);
  if (!listeners) return;
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      /* ignore subscriber errors */
    }
  }
}

function appendServerOutput(serverId: string, text: string): void {
  let buffer = (serverOutputBuffers.get(serverId) ?? '') + text;
  if (buffer.length > MAX_BUFFER) {
    buffer = buffer.slice(-MAX_BUFFER);
  }
  serverOutputBuffers.set(serverId, buffer);
  emitServer(serverId, { type: 'output', data: text });
}

/** Update persisted status and notify attached subscribers. */
function setStatus(serverId: string, status: ProjectServer['status'], exitCode: number | null): void {
  updateServerStatus(serverId, status);
  emitServer(serverId, { type: 'status', status, exitCode });
}

/** Current buffered output for a server (used to replay backlog on attach). */
export function getServerBacklog(serverId: string): string {
  return serverOutputBuffers.get(serverId) ?? '';
}

/** Attach a listener for a server's live output/status. Returns an unsubscribe. */
export function subscribeServer(serverId: string, listener: ServerStreamListener): () => void {
  let listeners = serverListeners.get(serverId);
  if (!listeners) {
    listeners = new Set();
    serverListeners.set(serverId, listeners);
  }
  listeners.add(listener);
  return () => {
    const set = serverListeners.get(serverId);
    if (!set) return;
    set.delete(listener);
    if (set.size === 0) serverListeners.delete(serverId);
  };
}

export async function spawnServer(
  userId: string,
  server: ProjectServer,
): Promise<{ serverId: string; status: string }> {
  const project = getProjectById(server.projectId);
  if (!project) {
    throw new Error(`Project ${server.projectId} not found`);
  }

  try {
    // Fresh run — clear any prior output backlog so the tab shows this run.
    serverOutputBuffers.set(server.id, '');

    // Update server status to starting
    setStatus(server.id, 'starting', null);

    const cwd = server.cwd || project.repoPath;
    const env = {
      ...process.env,
      ...(server.env || {}),
    };

    // Spawn the process
    const childProcess = spawn(server.command, [], {
      shell: true,
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Track the process
    const serverProcess: ServerProcess = {
      serverId: server.id,
      process: childProcess,
      startTime: Date.now(),
    };
    activeServerProcesses.set(server.id, serverProcess);

    childProcess.stdout?.on('data', (data) => {
      appendServerOutput(server.id, data.toString());
    });

    childProcess.stderr?.on('data', (data) => {
      appendServerOutput(server.id, data.toString());
    });

    // Handle process exit
    childProcess.on('exit', (code) => {
      activeServerProcesses.delete(server.id);
      const exitCode = code ?? -1;
      setServerExitCode(server.id, exitCode);
      setStatus(server.id, exitCode === 0 ? 'stopped' : 'failed', exitCode);
    });

    // Handle errors
    childProcess.on('error', (err) => {
      activeServerProcesses.delete(server.id);
      console.error(`[server-runtime] Error spawning server ${server.id}:`, err);
      appendServerOutput(server.id, `\r\n[error] ${err instanceof Error ? err.message : String(err)}\r\n`);
      setStatus(server.id, 'failed', null);
    });

    // Update to running after a short delay (gives time for immediate errors)
    setTimeout(() => {
      if (!childProcess.killed && activeServerProcesses.has(server.id)) {
        setStatus(server.id, 'running', null);
      }
    }, 500);

    return {
      serverId: server.id,
      status: 'starting',
    };
  } catch (err) {
    setStatus(server.id, 'failed', null);
    throw new Error(`Failed to spawn server: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function stopServer(serverId: string): void {
  const serverProcess = activeServerProcesses.get(serverId);
  if (!serverProcess) return;

  try {
    serverProcess.process.kill('SIGTERM');
    // Give it 5 seconds to die gracefully, then force kill
    const killTimer = setTimeout(() => {
      if (!serverProcess.process.killed) {
        serverProcess.process.kill('SIGKILL');
      }
    }, 5000);

    serverProcess.process.on('exit', () => {
      clearTimeout(killTimer);
      activeServerProcesses.delete(serverId);
    });
  } catch (err) {
    console.error(`Failed to stop server ${serverId}:`, err);
    activeServerProcesses.delete(serverId);
  }
}

/** True if a server currently has a live child process. */
export function isServerActive(serverId: string): boolean {
  return activeServerProcesses.has(serverId);
}

/**
 * Restart a server: stop any running process, wait for it to exit, then spawn a
 * fresh one from the persisted definition.
 */
export async function restartServer(
  userId: string,
  serverId: string,
): Promise<{ serverId: string; status: string }> {
  const server = getServerById(serverId);
  if (!server) {
    throw new Error(`Server ${serverId} not found`);
  }

  const existing = activeServerProcesses.get(serverId);
  if (existing) {
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      existing.process.once('exit', done);
      stopServer(serverId);
      // Safety net in case the exit event never fires.
      setTimeout(done, 6000);
    });
  }

  return spawnServer(userId, server);
}

export function getServerHealth(serverId: string): {
  status: 'running' | 'stopped' | 'unhealthy';
  uptime: number;
} {
  const serverProcess = activeServerProcesses.get(serverId);
  if (!serverProcess) {
    return { status: 'stopped', uptime: 0 };
  }

  const uptime = Date.now() - serverProcess.startTime;
  const isRunning = !serverProcess.process.killed && serverProcess.process.exitCode === null;

  return {
    status: isRunning ? 'running' : 'unhealthy',
    uptime,
  };
}
