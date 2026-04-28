/**
 * Integration test for the daemon mode.
 * Verifies: daemon startup, session creation, I/O, session survival across client reconnect.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import net from 'net';
import fs from 'fs';
import crypto from 'crypto';
import { DAEMON_SOCKET_PATH, DAEMON_SECRET_PATH, encodeLine, type DaemonResponse } from '../daemon/protocol';

const DAEMON_SCRIPT = path.join(__dirname, '..', 'daemon', 'index.ts');
const TSX = process.platform === 'win32' ? 'npx' : path.join(__dirname, '..', '..', 'node_modules', '.bin', 'tsx');
const TSX_ARGS = process.platform === 'win32' ? ['tsx', DAEMON_SCRIPT] : [DAEMON_SCRIPT];

let daemonProc: ChildProcess;

function waitForSocket(maxMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = setInterval(() => {
      // Also wait for the secret file to exist (daemon writes it on startup)
      if (!fs.existsSync(DAEMON_SECRET_PATH)) {
        if (Date.now() - start > maxMs) {
          clearInterval(poll);
          reject(new Error('Daemon secret not available'));
        }
        return;
      }
      const probe = net.createConnection(DAEMON_SOCKET_PATH);
      probe.on('connect', () => {
        probe.destroy();
        clearInterval(poll);
        resolve();
      });
      probe.on('error', () => {
        probe.destroy();
        if (Date.now() - start > maxMs) {
          clearInterval(poll);
          reject(new Error('Daemon socket not available'));
        }
      });
    }, 100);
  });
}

/** Simple NDJSON client for testing */
class TestClient {
  private socket: net.Socket;
  private buffer = '';
  private handlers = new Map<string, (resp: DaemonResponse) => void>();
  private outputQueue: DaemonResponse[] = [];

  constructor(socket: net.Socket) {
    this.socket = socket;
    socket.on('data', (chunk) => {
      this.buffer += chunk.toString();
      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        if (!line.trim()) continue;
        const resp = JSON.parse(line) as DaemonResponse;
        if ('reqId' in resp && resp.reqId && this.handlers.has(resp.reqId)) {
          this.handlers.get(resp.reqId)!(resp);
          this.handlers.delete(resp.reqId);
        } else {
          this.outputQueue.push(resp);
        }
      }
    });
  }

  async request(cmd: Record<string, unknown>): Promise<DaemonResponse> {
    const reqId = crypto.randomUUID();
    cmd.reqId = reqId;
    return new Promise((resolve) => {
      this.handlers.set(reqId, resolve);
      this.socket.write(encodeLine(cmd));
    });
  }

  drainOutput(): DaemonResponse[] {
    const out = [...this.outputQueue];
    this.outputQueue = [];
    return out;
  }

  destroy() {
    this.socket.destroy();
  }
}

async function connect(): Promise<TestClient> {
  return new Promise((resolve) => {
    const socket = net.createConnection(DAEMON_SOCKET_PATH, () => {
      resolve(new TestClient(socket));
    });
  });
}

async function authenticate(client: TestClient): Promise<void> {
  const secret = fs.readFileSync(DAEMON_SECRET_PATH, 'utf-8').trim();
  const resp = await client.request({ cmd: 'auth', secret });
  expect(resp.type).toBe('auth');
  expect((resp as any).ok).toBe(true);
}

describe('daemon mode', () => {
  beforeAll(async () => {
    daemonProc = spawn(TSX, TSX_ARGS, {
      stdio: 'pipe',
      shell: process.platform === 'win32',
      env: { ...process.env },
    });
    await waitForSocket();
  }, 10_000);

  afterAll(() => {
    daemonProc?.kill();
  });

  it('authenticates successfully', async () => {
    const client = await connect();
    await authenticate(client);
    client.destroy();
  });

  it('rejects bad auth', async () => {
    const client = await connect();
    const resp = await client.request({ cmd: 'auth', secret: 'wrong' });
    expect(resp.type).toBe('auth');
    expect((resp as any).ok).toBe(false);
    client.destroy();
  });

  it('rejects commands before auth', async () => {
    const client = await connect();
    const resp = await client.request({ cmd: 'list' });
    expect(resp.type).toBe('error');
    client.destroy();
  });

  it('creates and lists sessions', async () => {
    const client = await connect();
    await authenticate(client);

    const sessionId = crypto.randomUUID();
    const createResp = await client.request({
      cmd: 'create',
      sessionId,
      cwd: process.cwd(),
      shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash',
      args: process.platform === 'win32' ? ['/c', 'echo hello'] : ['-c', 'echo hello'],
      cols: 80,
      rows: 24,
      meta: { userId: 'testuser', projectId: null },
    });
    expect(createResp.type).toBe('created');

    // Give the process a moment to produce output and exit
    await new Promise(r => setTimeout(r, 1000));

    const listResp = await client.request({ cmd: 'list' });
    expect(listResp.type).toBe('sessions');
    const sessions = (listResp as any).sessions;
    const found = sessions.find((s: any) => s.sessionId === sessionId);
    expect(found).toBeDefined();

    client.destroy();
  });

  it('attaches and receives buffered output', async () => {
    const client = await connect();
    await authenticate(client);

    const sessionId = crypto.randomUUID();
    await client.request({
      cmd: 'create',
      sessionId,
      cwd: process.cwd(),
      shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash',
      args: process.platform === 'win32' ? ['/c', 'echo daemon-test-output'] : ['-c', 'echo daemon-test-output'],
      cols: 80,
      rows: 24,
    });

    // Wait for output
    await new Promise(r => setTimeout(r, 1000));

    const attachResp = await client.request({ cmd: 'attach', sessionId });
    expect(attachResp.type).toBe('attached');
    expect((attachResp as any).buffer).toContain('daemon-test-output');

    client.destroy();
  });

  it('survives client disconnect and reconnect', async () => {
    // Create a long-running session
    const client1 = await connect();
    await authenticate(client1);

    const sessionId = crypto.randomUUID();
    const echoCmd = process.platform === 'win32'
      ? ['/c', 'echo alive && timeout /t 30 /nobreak >nul']
      : ['-c', 'echo alive && sleep 30'];

    await client1.request({
      cmd: 'create',
      sessionId,
      cwd: process.cwd(),
      shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash',
      args: echoCmd,
      cols: 80,
      rows: 24,
      meta: { userId: 'user1' },
    });

    await new Promise(r => setTimeout(r, 1500));

    // Disconnect the first client (simulates server restart)
    client1.destroy();

    // Reconnect with a new client
    const client2 = await connect();
    await authenticate(client2);

    // Session should still be alive
    const listResp = await client2.request({ cmd: 'list' });
    const sessions = (listResp as any).sessions;
    const found = sessions.find((s: any) => s.sessionId === sessionId);
    expect(found).toBeDefined();
    expect(found.alive).toBe(true);
    expect(found.bufferLength).toBeGreaterThan(0);

    // Attach and get buffered output
    const attachResp = await client2.request({ cmd: 'attach', sessionId });
    expect(attachResp.type).toBe('attached');
    expect((attachResp as any).buffer).toContain('alive');

    // Kill the session
    await client2.request({ cmd: 'kill', sessionId });
    client2.destroy();
  });
}, 30_000);
