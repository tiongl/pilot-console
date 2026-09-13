import { spawn } from 'child_process';
import path from 'path';
import { getDb } from './db';
import { getProjectById } from './project-store';
import { updateServerStatus, setServerExitCode } from './server-store';
import type { ProjectServer } from './server-store';

interface ServerProcess {
  serverId: string;
  process: ReturnType<typeof spawn>;
  startTime: number;
}

const activeServerProcesses = new Map<string, ServerProcess>();

export async function spawnServer(
  userId: string,
  server: ProjectServer,
): Promise<{ serverId: string; status: string }> {
  const project = getProjectById(server.projectId);
  if (!project) {
    throw new Error(`Project ${server.projectId} not found`);
  }

  try {
    // Update server status to starting
    updateServerStatus(server.id, 'starting');

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

    // Pipe stdout/stderr to database for retrieval
    let outputBuffer = '';
    const maxBuffer = 100000; // Keep last 100KB

    const appendOutput = (text: string) => {
      outputBuffer += text;
      if (outputBuffer.length > maxBuffer) {
        outputBuffer = outputBuffer.slice(-maxBuffer);
      }
      // Store in CLI session output log if needed
    };

    childProcess.stdout?.on('data', (data) => {
      appendOutput(data.toString());
    });

    childProcess.stderr?.on('data', (data) => {
      appendOutput(data.toString());
    });

    // Handle process exit
    childProcess.on('exit', (code) => {
      activeServerProcesses.delete(server.id);
      const exitCode = code ?? -1;
      setServerExitCode(server.id, exitCode);
      updateServerStatus(server.id, exitCode === 0 ? 'stopped' : 'failed');
    });

    // Handle errors
    childProcess.on('error', (err) => {
      activeServerProcesses.delete(server.id);
      console.error(`[server-runtime] Error spawning server ${server.id}:`, err);
      updateServerStatus(server.id, 'failed');
    });

    // Update to running after a short delay (gives time for immediate errors)
    setTimeout(() => {
      if (!childProcess.killed && activeServerProcesses.has(server.id)) {
        updateServerStatus(server.id, 'running');
      }
    }, 500);

    return {
      serverId: server.id,
      status: 'starting',
    };
  } catch (err) {
    updateServerStatus(server.id, 'failed');
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

