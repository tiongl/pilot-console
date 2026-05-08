#!/usr/bin/env node
/**
 * pilot-console session daemon — a standalone process that owns PTY sessions
 * so they survive Express server restarts.
 *
 * Communicates via NDJSON over a named pipe (Windows) / Unix domain socket.
 */

import * as net from 'net';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as pty from 'node-pty';
import {
  DAEMON_SOCKET_PATH,
  DAEMON_SECRET_PATH,
  DAEMON_PID_PATH,
  DAEMON_LOCK_PATH,
  MAX_SCROLLBACK,
  encodeLine,
  type DaemonCommand,
  type DaemonResponse,
  type SessionInfo,
  type SessionMeta,
} from './protocol';
import path from 'path';
import os from 'os';

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

interface DaemonSession {
  sessionId: string;
  proc: pty.IPty;
  outputBuffer: string;
  alive: boolean;
  terminating: boolean; // set before proc.kill() to prevent duplicate native calls
  exitCode: number | null;
  exitedAt: number | null;
  lastOutputAt: number;
  seq: number; // monotonic output sequence counter
  subscribers: Set<net.Socket>;
  meta?: SessionMeta;
  lastCols: number;
  lastRows: number;
  filter: OutputFilter;
}

const sessions = new Map<string, DaemonSession>();
const EXITED_RETENTION_MS = 5 * 60_000; // keep exited sessions 5 min for reconciliation

// ---------------------------------------------------------------------------
// Environment sanitization — strip Node.js/npm/tsx vars that leak from the
// server process and would pollute child CLI processes (e.g. gh copilot).
// ---------------------------------------------------------------------------

const ENV_STRIP_PREFIXES = ['npm_', 'NPM_'];
const ENV_STRIP_EXACT = new Set([
  'COPILOT_LOADER_PID',
  'TSX_TSCONFIG_PATH',
  'TS_NODE_PROJECT',
  'TS_NODE_COMPILER',
  'NODE_OPTIONS',
  'NODE_CHANNEL_FD',
  'NODE_CHANNEL_SERIALIZATION_MODE',
  // On Windows, TERM is not set in real terminals. node-pty injects it via
  // the `name` param, but if it leaks into the env it can cause TUI programs
  // (gh copilot / ink) to take incorrect Unix-style code paths on ConPTY.
  ...(os.platform() === 'win32' ? ['TERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION'] : []),
]);

function cleanEnvForChild(): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, val] of Object.entries(process.env)) {
    if (val === undefined) continue;
    if (ENV_STRIP_EXACT.has(key)) continue;
    if (ENV_STRIP_PREFIXES.some(p => key.startsWith(p))) continue;
    clean[key] = val;
  }
  return clean;
}

const IS_WINDOWS = os.platform() === 'win32';

// On Windows, real terminals (Windows Terminal, cmd.exe) do NOT set TERM.
// node-pty's `name` param injects TERM into the child env, which causes
// gh copilot's TUI (ink/React) to take Unix-specific rendering code paths
// that break on ConPTY. Use a blank name on Windows to avoid this.
const PTY_NAME = IS_WINDOWS ? '' : 'xterm-256color';

const secret = crypto.randomBytes(32).toString('hex');
const daemonId = crypto.randomUUID();

function writeSecret() {
  const dir = path.dirname(DAEMON_SECRET_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DAEMON_SECRET_PATH, secret, { mode: 0o600 });
}

const authenticatedClients = new WeakSet<net.Socket>();

// ---------------------------------------------------------------------------
// Output filtering — strip known noisy error lines from PTY output before
// forwarding to subscribers.
//
// PTY output arrives in arbitrary chunks; a single error line often spans
// multiple onData calls (e.g. ANSI color codes in one chunk, the text in
// the next).  We therefore buffer incomplete lines per-session and only
// emit a line once we see its terminating \r\n (or a new line starts).
// ---------------------------------------------------------------------------

/** Patterns to strip — matched against ANSI-stripped text */
const NOISY_LINE_PATTERNS = [
  // gh copilot / ink rendering glitch
  /TypeError: Cannot read properties of undefined/,
];

/** Strip all ANSI escape sequences for pattern matching */
function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')        // CSI
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC
    .replace(/\x1b[P_^][^\x1b]*\x1b\\/g, '')        // DCS/APC/PM
    .replace(/\x1b[()][0-9A-Za-z]/g, '')             // Charset
    .replace(/\x1b[=>NOcMDEHZ78]/g, '');             // Single-char
}

/** Check if a line should be suppressed */
function isNoisyLine(line: string): boolean {
  const plain = stripAnsi(line);
  return NOISY_LINE_PATTERNS.some(re => re.test(plain));
}

/**
 * Per-session line assembler that handles cross-chunk line splits.
 * Buffers partial lines and only releases complete lines (after \n).
 * Noisy complete lines are dropped; everything else passes through verbatim.
 */
class OutputFilter {
  private pending = ''; // partial line from previous chunk

  /**
   * Feed a raw PTY chunk. Returns the filtered data to forward.
   * May return '' if everything was noise or still buffered.
   */
  filter(data: string): string {
    // Diagnostic: log any chunk that contains TypeError (raw repr)
    if (data.includes('TypeError')) {
      const repr = JSON.stringify(data);
      console.log(`[daemon-filter] TypeError in raw chunk (${data.length} bytes): ${repr.slice(0, 500)}`);
      if (this.pending) {
        console.log(`[daemon-filter]   pending buffer was (${this.pending.length} bytes): ${JSON.stringify(this.pending).slice(0, 300)}`);
      }
    }

    const combined = this.pending + data;

    // Also check the assembled buffer — the word may span two chunks
    if (!data.includes('TypeError') && combined.includes('TypeError')) {
      console.log(`[daemon-filter] TypeError found after combining with pending buffer (${combined.length} bytes): ${JSON.stringify(combined).slice(0, 500)}`);
    }

    const lines = combined.split('\n');

    // Last element is the unterminated partial line — keep buffering
    this.pending = lines.pop()!;

    // If there were no complete lines, everything is still buffered
    if (lines.length === 0) return '';

    // Filter complete lines
    const kept: string[] = [];
    for (const line of lines) {
      if (isNoisyLine(line)) {
        console.log(`[daemon-filter] Suppressed noisy line: ${stripAnsi(line).slice(0, 200)}`);
      } else {
        kept.push(line);
      }
    }

    // Re-assemble: join kept lines with \n, then append the partial line
    // so the downstream sees exactly the same byte boundaries minus noise
    let result = kept.join('\n');
    if (kept.length > 0) result += '\n'; // restore trailing \n from last complete line
    result += this.pending;
    this.pending = '';
    return result;
  }

  /** Flush any remaining buffered content (call on session exit) */
  flush(): string {
    const leftover = this.pending;
    this.pending = '';
    if (leftover && isNoisyLine(leftover)) {
      console.log(`[daemon-filter] Suppressed noisy leftover: ${stripAnsi(leftover).slice(0, 200)}`);
      return '';
    }
    return leftover;
  }
}

// ---------------------------------------------------------------------------
// Per-client NDJSON parser
// ---------------------------------------------------------------------------

function setupClient(socket: net.Socket) {
  let buffer = '';

  socket.on('data', (chunk) => {
    buffer += chunk.toString();
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      if (!line.trim()) continue;
      try {
        const cmd = JSON.parse(line) as DaemonCommand;
        handleCommand(socket, cmd);
      } catch {
        send(socket, { type: 'error', reqId: '', error: 'Invalid JSON' });
      }
    }
  });

  socket.on('close', () => {
    // Unsubscribe from all sessions
    for (const session of sessions.values()) {
      session.subscribers.delete(socket);
    }
  });

  socket.on('error', () => {
    for (const session of sessions.values()) {
      session.subscribers.delete(socket);
    }
  });
}

function send(socket: net.Socket, msg: DaemonResponse) {
  try {
    if (!socket.destroyed) {
      socket.write(encodeLine(msg));
    }
  } catch { /* socket write failed — client gone */ }
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

function handleCommand(socket: net.Socket, cmd: DaemonCommand) {
  // Auth gate: only 'auth' command is allowed before authentication
  if (cmd.cmd !== 'auth' && !authenticatedClients.has(socket)) {
    send(socket, { type: 'error', reqId: cmd.reqId, error: 'Not authenticated' });
    return;
  }

  switch (cmd.cmd) {
    case 'auth':
      return handleAuth(socket, cmd);
    case 'create':
      return handleCreate(socket, cmd);
    case 'write':
      return handleWrite(socket, cmd);
    case 'resize':
      return handleResize(socket, cmd);
    case 'kill':
      return handleKill(socket, cmd);
    case 'list':
      return handleList(socket, cmd);
    case 'attach':
      return handleAttach(socket, cmd);
    case 'detach':
      return handleDetach(socket, cmd);
    case 'peek':
      return handlePeek(socket, cmd);
    case 'runOnce':
      return handleRunOnce(socket, cmd);
  }
}

function handleAuth(socket: net.Socket, cmd: DaemonCommand & { cmd: 'auth' }) {
  if (cmd.secret === secret) {
    authenticatedClients.add(socket);
    send(socket, { type: 'auth', reqId: cmd.reqId, ok: true, daemonId });
  } else {
    send(socket, { type: 'auth', reqId: cmd.reqId, ok: false });
  }
}

function handleCreate(socket: net.Socket, cmd: DaemonCommand & { cmd: 'create' }) {
  try {
    const proc = pty.spawn(cmd.shell, cmd.args, {
      name: PTY_NAME,
      cols: cmd.cols,
      rows: cmd.rows,
      cwd: cmd.cwd,
      env: cleanEnvForChild(),
    });

    const session: DaemonSession = {
      sessionId: cmd.sessionId,
      proc,
      outputBuffer: '',
      alive: true,
      terminating: false,
      exitCode: null,
      exitedAt: null,
      lastOutputAt: 0,
      seq: 0,
      subscribers: new Set(),
      meta: cmd.meta,
      lastCols: cmd.cols,
      lastRows: cmd.rows,
      filter: new OutputFilter(),
    };

    proc.onData((data: string) => {
      const filtered = session.filter.filter(data);
      session.outputBuffer += filtered;
      if (session.outputBuffer.length > MAX_SCROLLBACK) {
        session.outputBuffer = session.outputBuffer.slice(-MAX_SCROLLBACK);
      }
      if (!filtered) return; // entire chunk was noise or still buffering
      session.lastOutputAt = Date.now();
      session.seq++;
      const msg: DaemonResponse = {
        type: 'output',
        sessionId: session.sessionId,
        data: filtered,
        seq: session.seq,
      };
      for (const sub of session.subscribers) {
        send(sub, msg);
      }
    });

    proc.onExit(({ exitCode }) => {
      // Flush any remaining buffered output from the filter
      const leftover = session.filter.flush();
      if (leftover) {
        session.outputBuffer += leftover;
        session.seq++;
        const outMsg: DaemonResponse = {
          type: 'output',
          sessionId: session.sessionId,
          data: leftover,
          seq: session.seq,
        };
        for (const sub of session.subscribers) {
          send(sub, outMsg);
        }
      }

      session.alive = false;
      session.exitCode = exitCode;
      session.exitedAt = Date.now();
      const msg: DaemonResponse = {
        type: 'exit',
        sessionId: session.sessionId,
        code: exitCode,
      };
      for (const sub of session.subscribers) {
        send(sub, msg);
      }
      // Clean up after retention period
      setTimeout(() => {
        const s = sessions.get(session.sessionId);
        if (s && !s.alive) sessions.delete(session.sessionId);
      }, EXITED_RETENTION_MS);
    });

    sessions.set(cmd.sessionId, session);
    send(socket, { type: 'created', reqId: cmd.reqId, sessionId: cmd.sessionId });
  } catch (err) {
    send(socket, {
      type: 'error',
      reqId: cmd.reqId,
      error: `Failed to create session: ${(err as Error).message}`,
    });
  }
}

function handleWrite(socket: net.Socket, cmd: DaemonCommand & { cmd: 'write' }) {
  const session = sessions.get(cmd.sessionId);
  if (!session || !session.alive || session.terminating) {
    send(socket, { type: 'error', reqId: cmd.reqId, error: 'Session not found or dead' });
    return;
  }
  session.proc.write(cmd.data);
  send(socket, { type: 'ok', reqId: cmd.reqId });
}

function handleResize(socket: net.Socket, cmd: DaemonCommand & { cmd: 'resize' }) {
  const session = sessions.get(cmd.sessionId);
  if (!session || !session.alive || session.terminating) {
    send(socket, { type: 'error', reqId: cmd.reqId, error: 'Session not found or dead' });
    return;
  }
  // Skip no-op resizes — redundant ConPTY resize events can crash TUI programs
  if (cmd.cols === session.lastCols && cmd.rows === session.lastRows) {
    send(socket, { type: 'ok', reqId: cmd.reqId });
    return;
  }
  session.lastCols = cmd.cols;
  session.lastRows = cmd.rows;
  session.proc.resize(cmd.cols, cmd.rows);
  send(socket, { type: 'ok', reqId: cmd.reqId });
}

function handleKill(socket: net.Socket, cmd: DaemonCommand & { cmd: 'kill' }) {
  const session = sessions.get(cmd.sessionId);
  if (!session) {
    send(socket, { type: 'error', reqId: cmd.reqId, error: 'Session not found' });
    return;
  }
  // Already dead or being terminated — no-op to avoid duplicate native calls
  if (!session.alive || session.terminating) {
    send(socket, { type: 'ok', reqId: cmd.reqId });
    return;
  }
  session.terminating = true;
  try {
    session.proc.kill();
  } catch { /* already dead */ }
  send(socket, { type: 'ok', reqId: cmd.reqId });
}

function handleList(socket: net.Socket, cmd: DaemonCommand & { cmd: 'list' }) {
  const infos: SessionInfo[] = [];
  for (const s of sessions.values()) {
    infos.push({
      sessionId: s.sessionId,
      alive: s.alive,
      exitCode: s.exitCode,
      exitedAt: s.exitedAt,
      lastOutputAt: s.lastOutputAt,
      bufferLength: s.outputBuffer.length,
      seq: s.seq,
      meta: s.meta,
    });
  }
  send(socket, { type: 'sessions', reqId: cmd.reqId, sessions: infos });
}

function handleAttach(socket: net.Socket, cmd: DaemonCommand & { cmd: 'attach' }) {
  const session = sessions.get(cmd.sessionId);
  if (!session) {
    send(socket, { type: 'error', reqId: cmd.reqId, error: 'Session not found' });
    return;
  }
  session.subscribers.add(socket);
  send(socket, {
    type: 'attached',
    reqId: cmd.reqId,
    sessionId: session.sessionId,
    buffer: session.outputBuffer,
    lastSeq: session.seq,
    alive: session.alive,
    exitCode: session.exitCode,
  });
}

function handleDetach(socket: net.Socket, cmd: DaemonCommand & { cmd: 'detach' }) {
  const session = sessions.get(cmd.sessionId);
  if (session) {
    session.subscribers.delete(socket);
  }
  send(socket, { type: 'detached', reqId: cmd.reqId, sessionId: cmd.sessionId });
}

// Read-only buffer snapshot — does not subscribe to output
function handlePeek(socket: net.Socket, cmd: DaemonCommand & { cmd: 'peek' }) {
  const session = sessions.get(cmd.sessionId);
  if (!session) {
    send(socket, { type: 'error', reqId: cmd.reqId, error: 'Session not found' });
    return;
  }
  send(socket, {
    type: 'peeked',
    reqId: cmd.reqId,
    sessionId: session.sessionId,
    buffer: session.outputBuffer,
    lastSeq: session.seq,
    alive: session.alive,
    exitCode: session.exitCode,
  });
}

// ---------------------------------------------------------------------------
// One-shot execution (for scheduled reports)
// ---------------------------------------------------------------------------

function handleRunOnce(socket: net.Socket, cmd: DaemonCommand & { cmd: 'runOnce' }) {
  const DEFAULT_MAX_OUTPUT = 1_048_576; // 1MB
  const maxOutput = cmd.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;

  console.log(`[daemon] runOnce: shell=${cmd.shell}, args=${JSON.stringify(cmd.args)}, cwd=${cmd.cwd}, timeout=${cmd.timeoutMs}ms`);

  try {
    const proc = pty.spawn(cmd.shell, cmd.args, {
      name: PTY_NAME,
      cols: 120,
      rows: 40,
      cwd: cmd.cwd,
      env: cleanEnvForChild(),
    });

    console.log(`[daemon] runOnce: spawned PID ${proc.pid}`);

    let output = '';
    let wasTruncated = false;
    let timedOut = false;
    let finished = false;

    const timeoutHandle = setTimeout(() => {
      if (finished) return;
      timedOut = true;
      finished = true;
      try { proc.kill(); } catch { /* ok */ }
      send(socket, {
        type: 'runOnceComplete',
        reqId: cmd.reqId,
        sessionId: cmd.sessionId,
        exitCode: -1,
        timedOut: true,
        wasTruncated,
        totalBytes: output.length,
      });
    }, cmd.timeoutMs);

    // Write the prompt to stdin after a brief delay (skip if empty — prompt may be in CLI args)
    if (cmd.prompt) {
      setTimeout(() => {
        if (!finished) {
          try {
            proc.write(cmd.prompt + '\n');
          } catch { /* process may have exited */ }
        }
      }, 500);
    }

    const runOnceFilter = new OutputFilter();

    proc.onData((data: string) => {
      if (finished) return;
      const filtered = runOnceFilter.filter(data);
      if (!filtered) return;
      if (output.length + filtered.length > maxOutput) {
        const remaining = maxOutput - output.length;
        if (remaining > 0) output += filtered.slice(0, remaining);
        wasTruncated = true;
      } else {
        output += filtered;
      }
      // Stream output chunks to caller
      send(socket, {
        type: 'runOnceOutput',
        reqId: cmd.reqId,
        sessionId: cmd.sessionId,
        data: filtered,
      });
    });

    proc.onExit(({ exitCode }) => {
      console.log(`[daemon] runOnce: PID exited, exitCode=${exitCode}, outputLen=${output.length}`);
      if (finished) return;
      finished = true;
      clearTimeout(timeoutHandle);
      send(socket, {
        type: 'runOnceComplete',
        reqId: cmd.reqId,
        sessionId: cmd.sessionId,
        exitCode,
        timedOut: false,
        wasTruncated,
        totalBytes: output.length,
      });
    });
  } catch (err) {
    console.error(`[daemon] runOnce: spawn failed:`, (err as Error).message);
    send(socket, {
      type: 'error',
      reqId: cmd.reqId,
      error: `Failed to run: ${(err as Error).message}`,
    });
  }
}

// ---------------------------------------------------------------------------
// Cleanup helpers
// ---------------------------------------------------------------------------

function cleanup() {
  if (process.platform !== 'win32') {
    try { fs.unlinkSync(DAEMON_SOCKET_PATH); } catch { /* ok */ }
  }
}

// ---------------------------------------------------------------------------
// Singleton lock
// ---------------------------------------------------------------------------

/** File descriptor for the lock file — kept open for process lifetime. */
let lockFd: number | null = null;

/**
 * Acquire an exclusive lock file. Returns true if we're the singleton.
 * The fd is held open so the OS releases it on process death (even crashes).
 */
function acquireLock(): boolean {
  // Ensure directory exists
  const dir = path.dirname(DAEMON_LOCK_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Check PID file first for a quick liveness test
  if (fs.existsSync(DAEMON_PID_PATH)) {
    try {
      const oldPid = parseInt(fs.readFileSync(DAEMON_PID_PATH, 'utf-8').trim(), 10);
      if (oldPid && oldPid !== process.pid) {
        try {
          process.kill(oldPid, 0); // throws if dead
          console.error(`[daemon] Another daemon is already running (pid=${oldPid}). Exiting.`);
          return false;
        } catch {
          // Dead process — clean up stale files
          console.log(`[daemon] Removing stale files (pid=${oldPid} is dead)`);
          try { fs.unlinkSync(DAEMON_PID_PATH); } catch { /* ok */ }
          try { fs.unlinkSync(DAEMON_LOCK_PATH); } catch { /* ok */ }
          try { fs.unlinkSync(DAEMON_SECRET_PATH); } catch { /* ok */ }
        }
      }
    } catch { /* ignore parse errors */ }
  }

  // Try to open lock file exclusively (O_CREAT | O_EXCL | O_WRONLY)
  try {
    lockFd = fs.openSync(DAEMON_LOCK_PATH, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    fs.writeSync(lockFd, String(process.pid));
    // Don't close — holding the fd IS the lock
    return true;
  } catch (err: any) {
    if (err.code === 'EEXIST') {
      // Lock file exists — another daemon may be alive or it crashed
      // Try to read PID and check liveness
      try {
        const lockPid = parseInt(fs.readFileSync(DAEMON_LOCK_PATH, 'utf-8').trim(), 10);
        if (lockPid) {
          try {
            process.kill(lockPid, 0); // throws if dead
            console.error(`[daemon] Lock held by live process (pid=${lockPid}). Exiting.`);
            return false;
          } catch {
            // Holder is dead — remove stale lock and retry
            console.log(`[daemon] Stale lock from dead pid=${lockPid}, reclaiming`);
            try { fs.unlinkSync(DAEMON_LOCK_PATH); } catch { /* ok */ }
            try { fs.unlinkSync(DAEMON_PID_PATH); } catch { /* ok */ }
            try { fs.unlinkSync(DAEMON_SECRET_PATH); } catch { /* ok */ }
            // Retry once
            try {
              lockFd = fs.openSync(DAEMON_LOCK_PATH, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
              fs.writeSync(lockFd, String(process.pid));
              return true;
            } catch {
              console.error('[daemon] Failed to acquire lock after cleanup. Exiting.');
              return false;
            }
          }
        }
      } catch { /* can't read lock file */ }
      console.error('[daemon] Lock file exists and cannot determine holder. Exiting.');
      return false;
    }
    throw err;
  }
}

function releaseLock() {
  if (lockFd !== null) {
    try { fs.closeSync(lockFd); } catch { /* ok */ }
    lockFd = null;
  }
  try { fs.unlinkSync(DAEMON_LOCK_PATH); } catch { /* ok */ }
}

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

function start() {
  if (!acquireLock()) {
    process.exit(1);
  }

  writeSecret();
  cleanup();

  const server = net.createServer(setupClient);

  let retried = false;
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && !retried) {
      retried = true;
      if (process.platform === 'win32') {
        // On Windows, named pipes can't be unlinked. Probe to see if another daemon is alive.
        const probe = net.createConnection(DAEMON_SOCKET_PATH);
        probe.on('connect', () => {
          // Another daemon is genuinely running — exit
          probe.destroy();
          console.error('[daemon] Another daemon is already running on this pipe. Exiting.');
          process.exit(1);
        });
        probe.on('error', () => {
          // Pipe is stale (old daemon died). Wait briefly and retry.
          probe.destroy();
          console.log('[daemon] Stale pipe detected, retrying in 1s...');
          setTimeout(() => server.listen(DAEMON_SOCKET_PATH), 1_000);
        });
        return;
      }
      // On Unix, clean up stale socket file and retry once
      console.error('[daemon] Address in use, cleaning up stale socket...');
      cleanup();
      server.listen(DAEMON_SOCKET_PATH);
    } else {
      console.error('[daemon] Server error:', err);
      process.exit(1);
    }
  });

  server.listen(DAEMON_SOCKET_PATH, () => {
    console.log(`[daemon] Listening on ${DAEMON_SOCKET_PATH} (pid=${process.pid})`);
    fs.writeFileSync(DAEMON_PID_PATH, String(process.pid));
  });

  // Graceful shutdown: kill all sessions, clean up socket
  const shutdown = () => {
    console.log('[daemon] Shutting down...');
    for (const s of sessions.values()) {
      if (s.alive) {
        try { s.proc.kill(); } catch { /* ok */ }
      }
    }
    server.close();
    cleanup();
    releaseLock();
    try { fs.unlinkSync(DAEMON_SECRET_PATH); } catch { /* ok */ }
    try { fs.unlinkSync(DAEMON_PID_PATH); } catch { /* ok */ }
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Log-and-exit on unexpected errors to prevent silent daemon death
  process.on('uncaughtException', (err) => {
    console.error('[daemon] Uncaught exception:', err);
    shutdown();
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[daemon] Unhandled rejection:', reason);
  });
}

start();
