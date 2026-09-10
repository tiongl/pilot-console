import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// The runtime descriptor is published under the user's home directory; point
// that at a scratch dir so the suite never touches a real daemon's state.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-runtime-host-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const started: Array<{ port: number; connectionToken: string }> = [];
const stop = vi.fn().mockResolvedValue([]);
const start = vi.fn().mockResolvedValue(undefined);

vi.mock('@github/copilot-sdk', () => ({
  CopilotClient: class {
    constructor(public options: { connection: { port: number; connectionToken: string } }) {
      started.push(options.connection);
    }
    start = start;
    stop = stop;
  },
  RuntimeConnection: {
    forTcp: (opts: { port: number; connectionToken: string }) => opts,
  },
}));

const { DAEMON_RUNTIME_PATH } = await import('../daemon/protocol');
const { getHostedRuntime, stopHostedRuntime, killHostedRuntime } = await import('../daemon/runtime-host');

function readDescriptor() {
  return JSON.parse(fs.readFileSync(DAEMON_RUNTIME_PATH, 'utf8'));
}

describe('daemon-hosted runtime', () => {
  beforeEach(() => {
    started.length = 0;
    start.mockClear();
    stop.mockClear();
  });

  afterEach(async () => {
    await stopHostedRuntime();
  });

  it('starts the runtime lazily and publishes a usable descriptor', async () => {
    expect(start).not.toHaveBeenCalled();

    const descriptor = await getHostedRuntime();

    expect(start).toHaveBeenCalledTimes(1);
    expect(descriptor.host).toBe('127.0.0.1');
    expect(descriptor.port).toBeGreaterThan(0);
    expect(descriptor.connectionToken).toBeTruthy();
    expect(descriptor.daemonPid).toBe(process.pid);
    // The SDK must be told the same explicit port we published — an SDK-chosen
    // port would be unknowable to the UI server.
    expect(started[0].port).toBe(descriptor.port);
    expect(started[0].connectionToken).toBe(descriptor.connectionToken);
    expect(readDescriptor()).toEqual(descriptor);
  });

  it('reuses the running runtime for later callers', async () => {
    const first = await getHostedRuntime();
    const second = await getHostedRuntime();

    expect(second).toEqual(first);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('shares a single start between concurrent callers', async () => {
    const [a, b, c] = await Promise.all([getHostedRuntime(), getHostedRuntime(), getHostedRuntime()]);

    expect(start).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it('restarts on request, replacing the descriptor', async () => {
    const first = await getHostedRuntime();
    const second = await getHostedRuntime(true);

    expect(stop).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(2);
    expect(second.connectionToken).not.toBe(first.connectionToken);
    expect(readDescriptor()).toEqual(second);
  });

  it('removes the descriptor file on shutdown so nobody attaches to a dead runtime', async () => {
    await getHostedRuntime();
    expect(fs.existsSync(DAEMON_RUNTIME_PATH)).toBe(true);

    killHostedRuntime();

    expect(fs.existsSync(DAEMON_RUNTIME_PATH)).toBe(false);
  });
});
