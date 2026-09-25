import { getDb } from './db';
import { randomUUID } from 'crypto';
import { emitArtifactsChanged } from './lavish-events';

/**
 * A Lavish artifact is an HTML file opened in a live `lavish-axi` session and
 * embedded in a pilot-console tab through the same-origin reverse proxy. The
 * session URL/port/key are discovered from the `lavish-axi` stdout and persisted
 * here (the Lavish daemon owns the actual port; we never assume a fixed one).
 */
export interface LavishArtifact {
  id: string;
  projectId: string;
  name: string;
  htmlPath: string;
  sessionKey: string | null;
  host: string | null;
  port: number | null;
  sessionUrl: string | null;
  status: 'starting' | 'ready' | 'failed' | 'stopped';
  exitCode: number | null;
  createdAt: string;
  updatedAt: string;
}

export function createArtifact(options: {
  projectId: string;
  name: string;
  htmlPath: string;
}): LavishArtifact {
  const id = randomUUID();
  const now = new Date().toISOString();

  getDb()
    .prepare(
      `INSERT INTO lavish_artifacts (id, project_id, name, html_path, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'starting', ?, ?)`,
    )
    .run(id, options.projectId, options.name, options.htmlPath, now, now);

  emitArtifactsChanged(options.projectId);
  return getArtifactById(id)!;
}

export function getArtifactById(id: string): LavishArtifact | null {
  const row = getDb()
    .prepare('SELECT * FROM lavish_artifacts WHERE id = ?')
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToArtifact(row) : null;
}

export function listArtifactsByProject(projectId: string): LavishArtifact[] {
  const rows = getDb()
    .prepare('SELECT * FROM lavish_artifacts WHERE project_id = ? ORDER BY created_at DESC')
    .all(projectId) as Record<string, unknown>[];
  return rows.map(rowToArtifact);
}

/** Persist the session URL/host/port/key parsed from the lavish-axi stdout. */
export function updateArtifactSession(
  id: string,
  session: { sessionUrl: string; host: string; port: number; sessionKey: string },
): LavishArtifact {
  getDb()
    .prepare(
      `UPDATE lavish_artifacts
       SET session_url = ?, host = ?, port = ?, session_key = ?, status = 'ready', updated_at = ?
       WHERE id = ?`,
    )
    .run(session.sessionUrl, session.host, session.port, session.sessionKey, new Date().toISOString(), id);
  const updated = getArtifactById(id)!;
  emitArtifactsChanged(updated.projectId);
  return updated;
}

export function updateArtifactStatus(
  id: string,
  status: LavishArtifact['status'],
  exitCode: number | null = null,
): LavishArtifact {
  getDb()
    .prepare('UPDATE lavish_artifacts SET status = ?, exit_code = ?, updated_at = ? WHERE id = ?')
    .run(status, exitCode, new Date().toISOString(), id);
  const updated = getArtifactById(id)!;
  emitArtifactsChanged(updated.projectId);
  return updated;
}

export function deleteArtifact(id: string): void {
  const existing = getArtifactById(id);
  getDb().prepare('DELETE FROM lavish_artifacts WHERE id = ?').run(id);
  if (existing) emitArtifactsChanged(existing.projectId);
}

function rowToArtifact(row: Record<string, unknown>): LavishArtifact {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    name: row.name as string,
    htmlPath: row.html_path as string,
    sessionKey: (row.session_key as string) ?? null,
    host: (row.host as string) ?? null,
    port: (row.port as number) ?? null,
    sessionUrl: (row.session_url as string) ?? null,
    status: row.status as LavishArtifact['status'],
    exitCode: (row.exit_code as number) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}
