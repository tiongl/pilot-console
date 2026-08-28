/**
 * Daemon-hosted Copilot SDK runtime.
 *
 * The runtime process is owned by the daemon rather than the Express server so
 * that agent sessions survive UI-server restarts (including `tsx --watch`
 * reloads in development). The daemon spawns it over TCP and publishes the
 * connection descriptor; the server attaches with `RuntimeConnection.forUri`,
 * which explicitly does *not* spawn a process.
 *
 * The port is allocated by us rather than by the SDK: `forTcp({ port: 0 })`
 * auto-allocates, but the chosen port is private to the client instance, so a
 * separate process could never learn it.
 */

import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { DAEMON_RUNTIME_PATH, type RuntimeDescriptor } from './protocol';

interface HostedRuntime {
  descriptor: RuntimeDescriptor;
  /** The SDK client that spawned the runtime; kept alive to own the process. */
  client: { stop: () => Promise<unknown>; forceStop?: () => Promise<void> };
}

let runtime: HostedRuntime | null = null;
let starting: Promise<RuntimeDescriptor> | null = null;

const HOST = '127.0.0.1';
const MAX_PORT_ATTEMPTS = 5;

/** Ask the OS for a free loopback port, then release it for the runtime. */
function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen({ port: 0, host: HOST }, () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close(() => reject(new Error('Could not determine an ephemeral port')));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

function writeDescriptor(descriptor: RuntimeDescriptor): void {
  try {
    fs.mkdirSync(path.dirname(DAEMON_RUNTIME_PATH), { recursive: true });
    fs.writeFileSync(DAEMON_RUNTIME_PATH, JSON.stringify(descriptor), { mode: 0o600 });
  } catch (err) {
    console.error('[daemon-runtime] Failed to publish runtime descriptor:', err);
  }
}

export function clearRuntimeDescriptorFile(): void {
  try {
    fs.unlinkSync(DAEMON_RUNTIME_PATH);
  } catch {
    /* already gone */
  }
}

async function spawnRuntime(): Promise<RuntimeDescriptor> {
  // Imported lazily so a daemon running without the SDK installed can still
  // serve PTY sessions.
  const { CopilotClient, RuntimeConnection } = await import('@github/copilot-sdk');

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_PORT_ATTEMPTS; attempt++) {
    const port = await allocatePort();
    const connectionToken = crypto.randomUUID();
    const client = new CopilotClient({
      connection: RuntimeConnection.forTcp({ port, connectionToken }),
    });
    try {
      await client.start();
    } catch (err) {
      // Most likely the ephemeral port was taken between probe and spawn.
      lastError = err;
      try {
        await client.stop();
      } catch {
        /* nothing to clean up */
      }
      console.error(`[daemon-runtime] Runtime start failed on port ${port} (attempt ${attempt}):`, err);
      continue;
    }

    const descriptor: RuntimeDescriptor = {
      host: HOST,
      port,
      connectionToken,
      daemonPid: process.pid,
      startedAt: Date.now(),
    };
    runtime = { client, descriptor };
    writeDescriptor(descriptor);
    console.log(`[daemon-runtime] Copilot runtime listening on ${HOST}:${port}`);
    return descriptor;
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Failed to start the Copilot runtime after several attempts');
}

/**
 * Return the hosted runtime descriptor, starting the runtime on first use.
 * Concurrent callers share a single start attempt.
 */
export async function getHostedRuntime(restart = false): Promise<RuntimeDescriptor> {
  if (restart) await stopHostedRuntime();
  if (runtime) return runtime.descriptor;
  if (!starting) {
    starting = spawnRuntime().finally(() => {
      starting = null;
    });
  }
  return starting;
}

export async function stopHostedRuntime(): Promise<void> {
  const current = runtime;
  runtime = null;
  clearRuntimeDescriptorFile();
  if (!current) return;
  try {
    await current.client.stop();
  } catch (err) {
    console.error('[daemon-runtime] Failed to stop the Copilot runtime:', err);
  }
}

/** Synchronous best-effort teardown for the daemon's exit path. */
export function killHostedRuntime(): void {
  const current = runtime;
  runtime = null;
  clearRuntimeDescriptorFile();
  if (!current) return;
  void (current.client.forceStop?.() ?? current.client.stop()).catch(() => {
    /* exiting anyway */
  });
}
