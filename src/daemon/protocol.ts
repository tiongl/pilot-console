/**
 * Shared protocol types for the gcclippy session daemon.
 *
 * Communication between the Express server and the daemon uses
 * newline-delimited JSON (NDJSON) over a named pipe (Windows)
 * or Unix domain socket.
 */

import path from 'path';
import os from 'os';

// ---------------------------------------------------------------------------
// Socket path
// ---------------------------------------------------------------------------

const IS_WINDOWS = process.platform === 'win32';
export const DAEMON_SOCKET_PATH = IS_WINDOWS
  ? '\\\\.\\pipe\\gcclippy-daemon'
  : path.join(os.tmpdir(), 'gcclippy-daemon.sock');

// Simple shared secret file-based auth (daemon writes, client reads)
export const DAEMON_SECRET_PATH = path.join(os.homedir(), '.gcclippy', 'daemon.secret');
export const DAEMON_PID_PATH = path.join(os.homedir(), '.gcclippy', 'daemon.pid');
export const DAEMON_LOCK_PATH = path.join(os.homedir(), '.gcclippy', 'daemon.lock');

// ---------------------------------------------------------------------------
// Client → Daemon commands
// ---------------------------------------------------------------------------

export interface CreateCmd {
  cmd: 'create';
  reqId: string;
  sessionId: string;
  cwd: string;
  shell: string;
  args: string[];
  cols: number;
  rows: number;
  meta?: { userId?: string; projectId?: string | null; mode?: string };
}

export interface WriteCmd {
  cmd: 'write';
  reqId: string;
  sessionId: string;
  data: string;
}

export interface ResizeCmd {
  cmd: 'resize';
  reqId: string;
  sessionId: string;
  cols: number;
  rows: number;
}

export interface KillCmd {
  cmd: 'kill';
  reqId: string;
  sessionId: string;
}

export interface ListCmd {
  cmd: 'list';
  reqId: string;
}

export interface AttachCmd {
  cmd: 'attach';
  reqId: string;
  sessionId: string;
  fromSeq?: number; // resume from this sequence number
}

export interface DetachCmd {
  cmd: 'detach';
  reqId: string;
  sessionId: string;
}

export interface AuthCmd {
  cmd: 'auth';
  reqId: string;
  secret: string;
}

export type DaemonCommand =
  | CreateCmd
  | WriteCmd
  | ResizeCmd
  | KillCmd
  | ListCmd
  | AttachCmd
  | DetachCmd
  | AuthCmd;

// ---------------------------------------------------------------------------
// Daemon → Client responses
// ---------------------------------------------------------------------------

export interface CreatedResp {
  type: 'created';
  reqId: string;
  sessionId: string;
}

export interface OutputResp {
  type: 'output';
  sessionId: string;
  data: string;
  seq: number;
}

export interface ExitResp {
  type: 'exit';
  sessionId: string;
  code: number;
}

export interface SessionInfo {
  sessionId: string;
  alive: boolean;
  exitCode: number | null;
  exitedAt: number | null;
  lastOutputAt: number;
  bufferLength: number;
  seq: number;
  meta?: { userId?: string; projectId?: string | null; mode?: string };
}
export interface SessionsResp {
  type: 'sessions';
  reqId: string;
  sessions: SessionInfo[];
}

export interface AttachedResp {
  type: 'attached';
  reqId: string;
  sessionId: string;
  buffer: string;
  lastSeq: number;
  alive: boolean;
  exitCode: number | null;
}

export interface DetachedResp {
  type: 'detached';
  reqId: string;
  sessionId: string;
}

export interface AuthResp {
  type: 'auth';
  reqId: string;
  ok: boolean;
}

export interface ErrorResp {
  type: 'error';
  reqId: string;
  error: string;
}

export interface OkResp {
  type: 'ok';
  reqId: string;
}

export type DaemonResponse =
  | CreatedResp
  | OutputResp
  | ExitResp
  | SessionsResp
  | AttachedResp
  | DetachedResp
  | AuthResp
  | ErrorResp
  | OkResp;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const MAX_SCROLLBACK = 100_000;

export function encodeLine(obj: unknown): string {
  return JSON.stringify(obj) + '\n';
}
