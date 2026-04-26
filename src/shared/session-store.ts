import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import { getDb } from './db';
import type { CliSession, SessionWithUser } from './types';

const COPILOT_DB_PATH = path.join(os.homedir(), '.copilot', 'session-state', 'session_store.db');

function getCopilotDb(): Database.Database | null {
  try {
    return new Database(COPILOT_DB_PATH, { readonly: true });
  } catch {
    return null;
  }
}

export interface CopilotSessionTurn {
  turn_index: number;
  user_message: string;
  assistant_response: string;
  timestamp: string;
}

export interface CopilotSessionDetail {
  id: string;
  summary: string | null;
  cwd: string | null;
  createdAt: string;
  turns: CopilotSessionTurn[];
}

/** Returns CLI sessions for a user joined with app.db data */
export function listSessionsForUser(userId: string): CliSession[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM cli_sessions WHERE user_id = ? ORDER BY started_at DESC')
    .all(userId) as Record<string, unknown>[];
  return rows.map(rowToCliSession);
}

/** Returns all CLI sessions (admin view) with user info */
export function listAllSessions(): SessionWithUser[] {
  const db = getDb();
  const rows = db
    .prepare(`
      SELECT cs.*, u.display_name as user_display_name, u.email as user_email
      FROM cli_sessions cs
      JOIN users u ON cs.user_id = u.id
      ORDER BY cs.started_at DESC
    `)
    .all() as Record<string, unknown>[];
  return rows.map((r) => ({
    ...rowToCliSession(r),
    userDisplayName: (r.user_display_name as string) ?? null,
    userEmail: (r.user_email as string) ?? null,
  }));
}

/** Reads detail from the Copilot session store by copilot session ID */
export function getCopilotSessionDetail(copilotSessionId: string): CopilotSessionDetail | null {
  const cpDb = getCopilotDb();
  if (!cpDb) return null;
  try {
    const session = cpDb
      .prepare('SELECT id, summary, cwd, created_at FROM sessions WHERE id = ?')
      .get(copilotSessionId) as Record<string, unknown> | undefined;
    if (!session) return null;

    const turns = cpDb
      .prepare('SELECT turn_index, user_message, assistant_response, timestamp FROM turns WHERE session_id = ? ORDER BY turn_index')
      .all(copilotSessionId) as CopilotSessionTurn[];

    return {
      id: session.id as string,
      summary: (session.summary as string) ?? null,
      cwd: (session.cwd as string) ?? null,
      createdAt: session.created_at as string,
      turns,
    };
  } finally {
    cpDb.close();
  }
}

function rowToCliSession(row: Record<string, unknown>): CliSession {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    projectId: (row.project_id as string) ?? null,
    copilotSessionId: (row.copilot_session_id as string) ?? null,
    startedAt: row.started_at as string,
    endedAt: (row.ended_at as string) ?? null,
  };
}
