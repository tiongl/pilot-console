import { getDb } from './db';
import { randomUUID } from 'crypto';

export interface ProjectServer {
  id: string;
  projectId: string;
  sessionId: string | null;
  name: string;
  command: string;
  cwd: string | null;
  env: Record<string, string> | null;
  status: 'pending' | 'starting' | 'running' | 'stopped' | 'failed';
  startedAt: string | null;
  stoppedAt: string | null;
  exitCode: number | null;
  createdAt: string;
  updatedAt: string;
}

export function createServer(options: {
  projectId: string;
  name: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
}): ProjectServer {
  const id = randomUUID();
  const now = new Date().toISOString();

  getDb()
    .prepare(
      `INSERT INTO project_servers (id, project_id, name, command, cwd, env, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(
      id,
      options.projectId,
      options.name,
      options.command,
      options.cwd ?? null,
      options.env ? JSON.stringify(options.env) : null,
      now,
      now,
    );

  return getServerById(id)!;
}

export function getServerById(id: string): ProjectServer | null {
  const row = getDb()
    .prepare('SELECT * FROM project_servers WHERE id = ?')
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToServer(row) : null;
}

export function listServersByProject(projectId: string): ProjectServer[] {
  const rows = getDb()
    .prepare('SELECT * FROM project_servers WHERE project_id = ? ORDER BY created_at DESC')
    .all(projectId) as Record<string, unknown>[];
  return rows.map(rowToServer);
}

export function listRunningServers(projectId: string): ProjectServer[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM project_servers WHERE project_id = ? AND status IN ('starting', 'running') ORDER BY created_at DESC",
    )
    .all(projectId) as Record<string, unknown>[];
  return rows.map(rowToServer);
}

export function updateServerStatus(
  id: string,
  status: ProjectServer['status'],
  sessionId?: string,
): ProjectServer {
  const updates: Record<string, unknown> = { status, updated_at: new Date().toISOString() };

  if (sessionId) {
    updates.session_id = sessionId;
  }

  if (status === 'running') {
    updates.started_at = new Date().toISOString();
  } else if (status === 'stopped' || status === 'failed') {
    updates.stopped_at = new Date().toISOString();
  }

  const keys = Object.keys(updates);
  const values = keys.map((k) => updates[k]);
  values.push(id);

  getDb()
    .prepare(
      `UPDATE project_servers SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
    )
    .run(...values);

  return getServerById(id)!;
}

export function setServerExitCode(id: string, exitCode: number): ProjectServer {
  getDb()
    .prepare('UPDATE project_servers SET exit_code = ?, updated_at = ? WHERE id = ?')
    .run(exitCode, new Date().toISOString(), id);
  return getServerById(id)!;
}

export function deleteServer(id: string): void {
  getDb().prepare('DELETE FROM project_servers WHERE id = ?').run(id);
}

function rowToServer(row: Record<string, unknown>): ProjectServer {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    sessionId: (row.session_id as string) ?? null,
    name: row.name as string,
    command: row.command as string,
    cwd: (row.cwd as string) ?? null,
    env: row.env ? JSON.parse(row.env as string) : null,
    status: row.status as ProjectServer['status'],
    startedAt: (row.started_at as string) ?? null,
    stoppedAt: (row.stopped_at as string) ?? null,
    exitCode: (row.exit_code as number) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}
