/**
 * Client for the pilot-console session daemon.
 *
 * Provides an async API for creating/managing PTY sessions that are owned
 * by the daemon process. The client auto-starts the daemon if it isn't
 * running and auto-reconnects on connection loss.
 */

import * as net from 'net';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import path from 'path';
import {
  DAEMON_SOCKET_PATH,
  DAEMON_SECRET_PATH,
  DAEMON_PID_PATH,
  DAEMON_LOCK_PATH,
  encodeLine,
  type DaemonCommand,
  type DaemonResponse,
  type SessionInfo,
  type AttachedResp,
  type PeekedResp,
  type RunOnceCompleteResp,
  type SessionMeta,
} from './protocol';
import { traceStart } from '../server/perf-monitor';

type ResponseHandler = (resp: DaemonResponse) => void;

export class DaemonClient {
  private socket: net.Socket | null = null;
  private buffer = '';
  private pendingRequests = new Map<string, ResponseHandler>();
  private outputListeners = new Map<string, (data: string, seq: number) => void>();
  private exitListeners = new Map<string, (code: number) => void>();
  private runOnceHandlers = new Map<string, {
    onOutput: (data: string) => void;
    onComplete: (resp: RunOnceCompleteResp) => void;
  }>();
  private connected = false;
  private connecting = false;
  private intentionalDisconnect = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastDaemonId: string | null = null;
  private generation = 0; // bumped on each disconnect to dedupe cleanup
  private _onDaemonRestarted: (() => void) | null = null;
  private _onConnectionLost: (() => void) | null = null;
  private _onReconnected: ((sameDaemon: boolean) => void) | null = null;

  /** Connect to the daemon. If autoStart is true (default), starts daemon if not running. */
  async connect(autoStart = true): Promise<void> {
    if (this.connected) return;
    if (this.connecting) {
      // Wait for existing connection attempt
      await new Promise<void>((resolve, reject) => {
        const check = setInterval(() => {
          if (this.connected) { clearInterval(check); resolve(); }
          if (!this.connecting) { clearInterval(check); reject(new Error('Connection failed')); }
        }, 100);
      });
      return;
    }

    this.connecting = true;
    this.intentionalDisconnect = false;
    let result: { daemonId?: string };
    try {
      result = await this.tryConnect();
    } catch {
      if (!autoStart) {
        this.connecting = false;
        throw new Error('Daemon not running');
      }
      // Daemon not running — start it
      console.log('[daemon-client] Daemon not running, starting...');
      await this.startDaemon();
      result = await this.tryConnect();
    }
    this.connecting = false;

    // Detect daemon restart
    const newDaemonId = result.daemonId ?? null;
    if (this.lastDaemonId !== null && newDaemonId !== this.lastDaemonId) {
      console.log(`[daemon-client] Daemon restarted (old=${this.lastDaemonId}, new=${newDaemonId})`);
      this.lastDaemonId = newDaemonId;
      try { this._onDaemonRestarted?.(); } catch (e) { console.error('[daemon-client] onDaemonRestarted error:', e); }
      try { this._onReconnected?.(false); } catch (e) { console.error('[daemon-client] onReconnected error:', e); }
    } else if (this.lastDaemonId !== null && newDaemonId === this.lastDaemonId) {
      // Same daemon — reconnected after transient socket loss
      console.log('[daemon-client] Reconnected to same daemon');
      try { this._onReconnected?.(true); } catch (e) { console.error('[daemon-client] onReconnected error:', e); }
    }
    this.lastDaemonId = newDaemonId;
  }

  private async tryConnect(): Promise<{ daemonId?: string }> {
    return new Promise<{ daemonId?: string }>((resolve, reject) => {
      const socket = net.createConnection(DAEMON_SOCKET_PATH);
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error('Connection timeout'));
      }, 5_000);

      socket.on('connect', async () => {
        clearTimeout(timeout);
        this.socket = socket;
        this.setupSocket(socket);

        // Authenticate
        try {
          const secret = fs.readFileSync(DAEMON_SECRET_PATH, 'utf-8').trim();
          const resp = await this.request({ cmd: 'auth', reqId: this.nextReqId(), secret });
          if (resp.type === 'auth' && resp.ok) {
            this.connected = true;
            const daemonId = resp.daemonId;
            console.log(`[daemon-client] Connected and authenticated (daemonId=${daemonId ?? 'unknown'})`);
            resolve({ daemonId });
          } else {
            socket.destroy();
            reject(new Error('Authentication failed'));
          }
        } catch (err) {
          socket.destroy();
          reject(err);
        }
      });

      socket.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  private setupSocket(socket: net.Socket) {
    socket.setNoDelay(true);
    socket.on('data', (chunk) => {
      const stop = traceStart('daemon-client:data');
      this.buffer += chunk.toString();
      let start = 0;
      let idx: number;
      while ((idx = this.buffer.indexOf('\n', start)) !== -1) {
        const line = this.buffer.slice(start, idx);
        start = idx + 1;
        if (!line.trim()) continue;
        try {
          const resp = JSON.parse(line) as DaemonResponse;
          this.handleResponse(resp);
        } catch { /* ignore bad messages */ }
      }
      // One slice at the end instead of per-line
      if (start > 0) {
        this.buffer = start < this.buffer.length ? this.buffer.slice(start) : '';
      }
      stop();
    });

    socket.on('close', () => {
      this.connected = false;
      this.socket = null;
      this.generation++;
      console.log('[daemon-client] Disconnected from daemon');

      // Immediately fail all in-flight requests — they can't be resumed
      this.rejectAllPending('Daemon connection lost');

      // Notify connection loss
      try { this._onConnectionLost?.(); } catch (e) { console.error('[daemon-client] onConnectionLost error:', e); }

      if (!this.intentionalDisconnect) {
        this.scheduleReconnect();
      }
    });

    socket.on('error', (err) => {
      console.error('[daemon-client] Socket error:', err.message);
    });
  }

  /** Reject all pending request-response and runOnce handlers */
  private rejectAllPending(reason: string) {
    // Reject request-response handlers
    for (const [reqId, handler] of this.pendingRequests) {
      handler({ type: 'error', reqId, error: reason });
    }
    this.pendingRequests.clear();

    // Fail all runOnce handlers immediately
    for (const [reqId, handler] of this.runOnceHandlers) {
      handler.onComplete({
        type: 'runOnceComplete',
        reqId,
        sessionId: '',
        exitCode: -1,
        timedOut: false,
        wasTruncated: false,
        totalBytes: 0,
      });
    }
    this.runOnceHandlers.clear();
  }

  private handleResponse(resp: DaemonResponse) {
    // Output and exit are subscription-based (no reqId)
    if (resp.type === 'output') {
      this.outputListeners.get(resp.sessionId)?.(resp.data, resp.seq);
      return;
    }
    if (resp.type === 'exit') {
      this.exitListeners.get(resp.sessionId)?.(resp.code);
      return;
    }

    // RunOnce streaming responses (keyed by reqId)
    if (resp.type === 'runOnceOutput') {
      this.runOnceHandlers.get(resp.reqId)?.onOutput(resp.data);
      return;
    }
    if (resp.type === 'runOnceComplete') {
      const handler = this.runOnceHandlers.get(resp.reqId);
      if (handler) {
        this.runOnceHandlers.delete(resp.reqId);
        handler.onComplete(resp);
      }
      return;
    }

    // Request-response correlation
    if ('reqId' in resp && resp.reqId) {
      const handler = this.pendingRequests.get(resp.reqId);
      if (handler) {
        this.pendingRequests.delete(resp.reqId);
        handler(resp);
      }
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect(false); // don't auto-start on reconnect
      } catch {
        // Daemon not running — just schedule another check
        this.scheduleReconnect();
      }
    }, 3_000);
  }

  private nextReqId(): string {
    return crypto.randomUUID();
  }

  private async request(cmd: DaemonCommand): Promise<DaemonResponse> {
    if (!this.socket || this.socket.destroyed) {
      throw new Error('Not connected to daemon');
    }
    return new Promise<DaemonResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(cmd.reqId);
        reject(new Error(`Daemon request timeout: ${cmd.cmd}`));
      }, 10_000);

      this.pendingRequests.set(cmd.reqId, (resp) => {
        clearTimeout(timeout);
        resolve(resp);
      });

      this.socket!.write(encodeLine(cmd));
    });
  }

  /** Start the daemon as a detached background process. */
  private async startDaemon(): Promise<void> {
    // Clean up stale PID file if the old process is dead
    if (fs.existsSync(DAEMON_PID_PATH)) {
      try {
        const oldPid = parseInt(fs.readFileSync(DAEMON_PID_PATH, 'utf-8').trim(), 10);
        if (oldPid) {
          try {
            process.kill(oldPid, 0);
            // Old daemon IS alive — don't spawn a new one, just connect
            console.log(`[daemon-client] Daemon already running (pid=${oldPid}), skipping spawn`);
            return;
          } catch {
            console.log(`[daemon-client] Stale PID ${oldPid}, cleaning up`);
            fs.unlinkSync(DAEMON_PID_PATH);
            try { fs.unlinkSync(DAEMON_SECRET_PATH); } catch { /* ok */ }
            try { fs.unlinkSync(DAEMON_LOCK_PATH); } catch { /* ok */ }
          }
        }
      } catch { /* ignore */ }
    }

    const daemonScript = path.join(__dirname, 'index.ts');

    // On Windows, spawn via cmd.exe to resolve .cmd shims; on Unix use tsx directly
    const IS_WINDOWS = process.platform === 'win32';
    const tsxBin = IS_WINDOWS ? 'npx' : path.join(
      path.dirname(path.dirname(__dirname)),
      'node_modules', '.bin', 'tsx',
    );
    const tsxArgs = IS_WINDOWS ? ['tsx', daemonScript] : [daemonScript];

    const child = spawn(tsxBin, tsxArgs, {
      detached: true,
      stdio: 'ignore',
      shell: IS_WINDOWS,
      windowsHide: true,
      env: { ...process.env },
    });
    child.unref();

    console.log(`[daemon-client] Spawned daemon (pid=${child.pid})`);

    // Wait for the socket to become available
    await new Promise<void>((resolve, reject) => {
      let attempts = 0;
      const maxAttempts = 100; // 10 seconds (npx tsx is slow on Windows)
      const poll = setInterval(() => {
        attempts++;
        const probe = net.createConnection(DAEMON_SOCKET_PATH);
        probe.on('connect', () => {
          probe.destroy();
          clearInterval(poll);
          resolve();
        });
        probe.on('error', () => {
          probe.destroy();
          if (attempts >= maxAttempts) {
            clearInterval(poll);
            reject(new Error('Daemon failed to start within 10s'));
          }
        });
      }, 100);
    });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async createSession(opts: {
    sessionId: string;
    cwd: string;
    shell: string;
    args: string[];
    cols: number;
    rows: number;
    meta?: SessionMeta;
  }): Promise<string> {
    await this.ensureConnected();
    const resp = await this.request({
      cmd: 'create',
      reqId: this.nextReqId(),
      ...opts,
    });
    if (resp.type === 'error') throw new Error(resp.error);
    return opts.sessionId;
  }

  writeToSession(sessionId: string, data: string): boolean {
    if (!this.connected || !this.socket || this.socket.destroyed) return false;
    // Fire-and-forget — don't wait for 'ok' response to minimize latency.
    // Errors (session gone) are non-fatal; the next write will also fail.
    this.socket.write(encodeLine({
      cmd: 'write',
      reqId: '',
      sessionId,
      data,
    }));
    return true;
  }

  resizeSession(sessionId: string, cols: number, rows: number): void {
    if (!this.connected || !this.socket || this.socket.destroyed) return;
    // Fire-and-forget — resize is best-effort
    this.socket.write(encodeLine({
      cmd: 'resize',
      reqId: '',
      sessionId,
      cols,
      rows,
    }));
  }

  async killSession(sessionId: string): Promise<void> {
    await this.ensureConnected();
    await this.request({
      cmd: 'kill',
      reqId: this.nextReqId(),
      sessionId,
    });
  }

  async listSessions(): Promise<SessionInfo[]> {
    await this.ensureConnected();
    const resp = await this.request({
      cmd: 'list',
      reqId: this.nextReqId(),
    });
    if (resp.type === 'sessions') return resp.sessions;
    return [];
  }

  async attachSession(sessionId: string): Promise<AttachedResp> {
    await this.ensureConnected();
    const resp = await this.request({
      cmd: 'attach',
      reqId: this.nextReqId(),
      sessionId,
    });
    if (resp.type === 'error') throw new Error(resp.error);
    return resp as AttachedResp;
  }

  async detachSession(sessionId: string): Promise<void> {
    if (!this.connected) return;
    await this.request({
      cmd: 'detach',
      reqId: this.nextReqId(),
      sessionId,
    });
  }

  /** Read-only buffer snapshot — does not subscribe to output */
  async peekSession(sessionId: string): Promise<PeekedResp> {
    await this.ensureConnected();
    const resp = await this.request({
      cmd: 'peek',
      reqId: this.nextReqId(),
      sessionId,
    });
    if (resp.type === 'error') throw new Error(resp.error);
    return resp as PeekedResp;
  }

  /** Subscribe to output from a session */
  onOutput(sessionId: string, cb: (data: string, seq: number) => void) {
    this.outputListeners.set(sessionId, cb);
  }

  /** Subscribe to exit events from a session */
  onExit(sessionId: string, cb: (code: number) => void) {
    this.exitListeners.set(sessionId, cb);
  }

  /** Remove output/exit listeners for a session */
  removeListeners(sessionId: string) {
    this.outputListeners.delete(sessionId);
    this.exitListeners.delete(sessionId);
  }

  /** Register callback for when daemon connection is lost */
  onConnectionLost(cb: () => void) {
    this._onConnectionLost = cb;
  }

  /** Register callback for when daemon has restarted (different daemonId) */
  onDaemonRestarted(cb: () => void) {
    this._onDaemonRestarted = cb;
  }

  /** Register callback for when reconnected (sameDaemon: true if same instance, false if new) */
  onReconnected(cb: (sameDaemon: boolean) => void) {
    this._onReconnected = cb;
  }

  private async ensureConnected(): Promise<void> {
    if (!this.connected) {
      throw new Error('Not connected to daemon');
    }
  }

  /**
   * Run a one-shot command: spawn process, write prompt, capture all output,
   * wait for exit or timeout. Unlike interactive sessions, this auto-terminates.
   */
  async runOnce(opts: {
    sessionId: string;
    cwd: string;
    shell: string;
    args: string[];
    prompt: string;
    timeoutMs: number;
    maxOutputBytes?: number;
    meta?: SessionMeta;
    onOutput?: (data: string) => void;
  }): Promise<{ output: string; exitCode: number; timedOut: boolean; wasTruncated: boolean }> {
    await this.ensureConnected();
    const reqId = this.nextReqId();
    let output = '';

    return new Promise((resolve, reject) => {
      // Set up a long timeout on the client side too (timeoutMs + 30s buffer)
      const clientTimeout = setTimeout(() => {
        this.runOnceHandlers.delete(reqId);
        reject(new Error('runOnce client timeout'));
      }, opts.timeoutMs + 30_000);

      this.runOnceHandlers.set(reqId, {
        onOutput: (data) => {
          output += data;
          opts.onOutput?.(data);
        },
        onComplete: (resp) => {
          clearTimeout(clientTimeout);
          resolve({
            output,
            exitCode: resp.exitCode,
            timedOut: resp.timedOut,
            wasTruncated: resp.wasTruncated,
          });
        },
      });

      if (!this.socket || this.socket.destroyed) {
        clearTimeout(clientTimeout);
        this.runOnceHandlers.delete(reqId);
        reject(new Error('Not connected to daemon'));
        return;
      }

      this.socket.write(encodeLine({
        cmd: 'runOnce',
        reqId,
        sessionId: opts.sessionId,
        cwd: opts.cwd,
        shell: opts.shell,
        args: opts.args,
        prompt: opts.prompt,
        timeoutMs: opts.timeoutMs,
        maxOutputBytes: opts.maxOutputBytes,
        meta: opts.meta,
      }));
    });
  }

  /** Disconnect from daemon (doesn't kill the daemon). */
  disconnect() {
    this.intentionalDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.destroy();
    this.socket = null;
    this.connected = false;
  }

  get isConnected(): boolean {
    return this.connected;
  }
}

/** Singleton instance */
let _client: DaemonClient | null = null;
export function getDaemonClient(): DaemonClient {
  if (!_client) {
    _client = new DaemonClient();
  }
  return _client;
}
