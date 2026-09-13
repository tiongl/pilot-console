import { spawn } from 'child_process';
import { getProjectById } from './project-store';
import path from 'path';
import {
  getArtifactById,
  updateArtifactSession,
  updateArtifactStatus,
} from './lavish-store';
import type { LavishArtifact } from './lavish-store';

/**
 * Runtime for Lavish artifact sessions. Mirrors the server-runtime patterns
 * (child-process spawn + stdout ring buffer + pub/sub) without touching the
 * merged server-start machinery.
 *
 * `lavish-axi <file>` registers a session on a shared, long-lived Lavish daemon
 * and prints a YAML block containing the session URL, then exits. We parse that
 * URL from stdout to learn the daemon's actual host/port/session-key (never
 * assumed — the daemon owns the port and may restart) and persist it so the
 * reverse proxy can reach it.
 */

interface ArtifactProcess {
  artifactId: string;
  process: ReturnType<typeof spawn>;
  startTime: number;
}

const activeArtifactProcesses = new Map<string, ArtifactProcess>();

export type ArtifactStreamEvent =
  | { type: 'output'; data: string }
  | { type: 'status'; status: LavishArtifact['status']; exitCode: number | null };

type ArtifactStreamListener = (event: ArtifactStreamEvent) => void;

const MAX_BUFFER = 100_000;
const artifactOutputBuffers = new Map<string, string>();
const artifactListeners = new Map<string, Set<ArtifactStreamListener>>();

function emitArtifact(artifactId: string, event: ArtifactStreamEvent): void {
  const listeners = artifactListeners.get(artifactId);
  if (!listeners) return;
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      /* ignore subscriber errors */
    }
  }
}

function appendArtifactOutput(artifactId: string, text: string): void {
  let buffer = (artifactOutputBuffers.get(artifactId) ?? '') + text;
  if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-MAX_BUFFER);
  artifactOutputBuffers.set(artifactId, buffer);
  emitArtifact(artifactId, { type: 'output', data: text });
}

function setArtifactStatus(
  artifactId: string,
  status: LavishArtifact['status'],
  exitCode: number | null,
): void {
  updateArtifactStatus(artifactId, status, exitCode);
  emitArtifact(artifactId, { type: 'status', status, exitCode });
}

export function getArtifactBacklog(artifactId: string): string {
  return artifactOutputBuffers.get(artifactId) ?? '';
}

export function subscribeArtifact(
  artifactId: string,
  listener: ArtifactStreamListener,
): () => void {
  let listeners = artifactListeners.get(artifactId);
  if (!listeners) {
    listeners = new Set();
    artifactListeners.set(artifactId, listeners);
  }
  listeners.add(listener);
  return () => {
    const set = artifactListeners.get(artifactId);
    if (!set) return;
    set.delete(listener);
    if (set.size === 0) artifactListeners.delete(artifactId);
  };
}

/**
 * Parse the `url: "http://host:port/session/<key>"` line from lavish-axi stdout.
 * Returns null if no session URL has been printed yet.
 */
export function parseLavishSessionUrl(
  text: string,
): { sessionUrl: string; host: string; port: number; sessionKey: string } | null {
  const match = text.match(
    /url:\s*["']?(https?:\/\/([^:/"'\s]+):(\d+)\/session\/([A-Za-z0-9_-]+))["']?/,
  );
  if (!match) return null;
  return {
    sessionUrl: match[1],
    host: match[2],
    port: parseInt(match[3], 10),
    sessionKey: match[4],
  };
}

export async function spawnLavishArtifact(
  _userId: string,
  artifact: LavishArtifact,
): Promise<{ artifactId: string; status: string }> {
  const project = getProjectById(artifact.projectId);
  if (!project) throw new Error(`Project ${artifact.projectId} not found`);

  artifactOutputBuffers.set(artifact.id, '');
  setArtifactStatus(artifact.id, 'starting', null);

  // Lavish requires the artifact's own assets to be resolvable relative to the
  // HTML file, so run from its directory.
  const cwd = path.dirname(artifact.htmlPath);
  const htmlFile = path.basename(artifact.htmlPath);

  const child = spawn('npx', ['-y', 'lavish-axi', htmlFile], {
    shell: true,
    cwd,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  activeArtifactProcesses.set(artifact.id, {
    artifactId: artifact.id,
    process: child,
    startTime: Date.now(),
  });

  let sessionResolved = false;
  const tryResolveSession = () => {
    if (sessionResolved) return;
    const parsed = parseLavishSessionUrl(getArtifactBacklog(artifact.id));
    if (!parsed) return;
    sessionResolved = true;
    updateArtifactSession(artifact.id, parsed);
    emitArtifact(artifact.id, { type: 'status', status: 'ready', exitCode: null });
  };

  child.stdout?.on('data', (data) => {
    appendArtifactOutput(artifact.id, data.toString());
    tryResolveSession();
  });

  child.stderr?.on('data', (data) => {
    appendArtifactOutput(artifact.id, data.toString());
    tryResolveSession();
  });

  child.on('exit', (code) => {
    activeArtifactProcesses.delete(artifact.id);
    // The launcher exits after registering the session on the daemon. If it
    // printed a session URL, the artifact is live (ready); otherwise the daemon
    // could not be reached / the launch failed.
    if (sessionResolved) return;
    tryResolveSession();
    if (!sessionResolved) {
      const exitCode = code ?? -1;
      setArtifactStatus(artifact.id, 'failed', exitCode);
    }
  });

  child.on('error', (err) => {
    activeArtifactProcesses.delete(artifact.id);
    appendArtifactOutput(
      artifact.id,
      `\r\n[error] ${err instanceof Error ? err.message : String(err)}\r\n`,
    );
    if (!sessionResolved) setArtifactStatus(artifact.id, 'failed', null);
  });

  return { artifactId: artifact.id, status: 'starting' };
}

export interface ArtifactFeedback {
  raw: string;
  timedOut: boolean;
  exitCode: number | null;
}

/**
 * Bounded, non-blocking poll for queued human feedback via `lavish-axi poll`.
 * Always resolves (never hangs the Lead's turn): if no feedback arrives within
 * `timeoutMs`, resolves with `{ timedOut: true }` and the Lead can re-poll.
 * When `agentReply` is supplied, the agent's message is shown in Lavish Editor.
 */
export async function pollArtifactFeedback(
  artifactId: string,
  options: { agentReply?: string; timeoutMs?: number } = {},
): Promise<ArtifactFeedback> {
  const artifact = getArtifactById(artifactId);
  if (!artifact) throw new Error(`Artifact ${artifactId} not found`);

  const timeoutMs = Math.max(1000, Math.min(options.timeoutMs ?? 20_000, 120_000));
  const cwd = path.dirname(artifact.htmlPath);
  const htmlFile = path.basename(artifact.htmlPath);

  const args = ['-y', 'lavish-axi', 'poll', htmlFile, '--timeout-ms', String(timeoutMs)];
  if (options.agentReply) args.push('--agent-reply', options.agentReply);

  return new Promise<ArtifactFeedback>((resolve) => {
    const child = spawn('npx', args, {
      shell: true,
      cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let settled = false;
    const finish = (result: ArtifactFeedback) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    // Hard safety net so a stuck launcher can never block the turn.
    const guard = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      finish({ raw: out, timedOut: true, exitCode: null });
    }, timeoutMs + 10_000);

    child.stdout?.on('data', (d) => {
      out += d.toString();
    });
    child.stderr?.on('data', (d) => {
      out += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(guard);
      finish({ raw: `${out}\n[error] ${err instanceof Error ? err.message : String(err)}`, timedOut: false, exitCode: null });
    });
    child.on('exit', (code) => {
      clearTimeout(guard);
      const timedOut = /timeout|timed out|no feedback/i.test(out) && !/feedback:|prompt|tag/i.test(out);
      finish({ raw: out.trim(), timedOut, exitCode: code ?? null });
    });
  });
}

export function stopLavishArtifact(artifactId: string): void {
  const proc = activeArtifactProcesses.get(artifactId);
  if (proc) {
    try {
      proc.process.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    activeArtifactProcesses.delete(artifactId);
  }
  const existing = getArtifactById(artifactId);
  if (existing && existing.status !== 'stopped') {
    setArtifactStatus(artifactId, 'stopped', existing.exitCode);
  }
}

export function isArtifactActive(artifactId: string): boolean {
  const artifact = getArtifactById(artifactId);
  return artifact?.status === 'ready';
}
