import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import { getDb } from './db';
import type { CliSession, SessionWithUser } from './types';

const COPILOT_DB_PATH = path.join(os.homedir(), '.copilot', 'session-store.db');

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

export interface CopilotSessionSummary {
  id: string;
  summary: string | null;
  cwd: string | null;
  createdAt: string;
  updatedAt: string | null;
  turnCount: number;
  durationMs: number | null;
  activeMs: number | null;
  userMsgChars: number;
  assistantMsgChars: number;
}

/** Max gap (ms) between turns to count as "active" — gaps larger than this are treated as idle */
const ACTIVE_GAP_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

/** Lists Copilot CLI sessions whose cwd matches a project repo path.
 *  When `search` is provided, only sessions whose summary, created_at, or
 *  turn content (user_message / assistant_response) contain the term are returned. */
export function listCopilotSessionsForProject(repoPath: string, limit = 50, search?: string): CopilotSessionSummary[] {
  const cpDb = getCopilotDb();
  if (!cpDb) return [];
  try {
    const normalized = repoPath.replace(/\\/g, '/');
    const searchTerm = search?.trim().toLowerCase() || '';

    // Build optional content-search condition
    const searchClause = searchTerm
      ? `AND (
           instr(lower(coalesce(s.summary, '')), ?) > 0
           OR instr(lower(coalesce(s.created_at, '')), ?) > 0
           OR EXISTS (
             SELECT 1 FROM turns t2
             WHERE t2.session_id = s.id
               AND (instr(lower(coalesce(t2.user_message, '')), ?) > 0
                 OR instr(lower(coalesce(t2.assistant_response, '')), ?) > 0)
           )
         )`
      : '';

    const params: unknown[] = [];
    if (searchTerm) params.push(searchTerm, searchTerm, searchTerm, searchTerm);
    params.push(limit * 3);

    const rows = cpDb.prepare(`
      SELECT s.id, s.summary, s.cwd, s.created_at, s.updated_at,
             (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.id) as turn_count,
             (SELECT MIN(t.timestamp) FROM turns t WHERE t.session_id = s.id) as first_turn_at,
             (SELECT MAX(t.timestamp) FROM turns t WHERE t.session_id = s.id) as last_turn_at,
             (SELECT COALESCE(SUM(LENGTH(t.user_message)), 0) FROM turns t WHERE t.session_id = s.id) as user_chars,
             (SELECT COALESCE(SUM(LENGTH(t.assistant_response)), 0) FROM turns t WHERE t.session_id = s.id) as assistant_chars
      FROM sessions s
      WHERE s.cwd IS NOT NULL
      ${searchClause}
      ORDER BY s.created_at DESC
      LIMIT ?
    `).all(...params) as Record<string, unknown>[];

    const turnTimestampsStmt = cpDb.prepare(
      'SELECT timestamp FROM turns WHERE session_id = ? ORDER BY turn_index'
    );

    const isWindows = process.platform === 'win32';
    const results: CopilotSessionSummary[] = [];
    for (const row of rows) {
      const cwd = ((row.cwd as string) ?? '').replace(/\\/g, '/');
      // Require exact match or a path-separator boundary to avoid prefix
      // collisions (e.g. "pilot-console" matching "pilot-console-wt-worktree1")
      const cwdCmp = isWindows ? cwd.toLowerCase() : cwd;
      const normCmp = isWindows ? normalized.toLowerCase() : normalized;
      const match = cwdCmp === normCmp || cwdCmp.startsWith(normCmp + '/');
      if (match) {
        const firstAt = row.first_turn_at as string | null;
        const lastAt = row.last_turn_at as string | null;
        let durationMs: number | null = null;
        if (firstAt && lastAt) {
          durationMs = new Date(lastAt).getTime() - new Date(firstAt).getTime();
          if (durationMs < 0) durationMs = null;
        }

        // Compute active time by summing gaps under the threshold
        let activeMs: number | null = null;
        const turnCount = row.turn_count as number;
        if (turnCount >= 2) {
          const timestamps = turnTimestampsStmt.all(row.id as string) as { timestamp: string }[];
          let active = 0;
          for (let i = 1; i < timestamps.length; i++) {
            const gap = new Date(timestamps[i].timestamp).getTime() - new Date(timestamps[i - 1].timestamp).getTime();
            if (gap > 0 && gap <= ACTIVE_GAP_THRESHOLD_MS) {
              active += gap;
            }
          }
          activeMs = active > 0 ? active : null;
        }

        results.push({
          id: row.id as string,
          summary: (row.summary as string) ?? null,
          cwd: row.cwd as string,
          createdAt: row.created_at as string,
          updatedAt: (row.updated_at as string) ?? null,
          turnCount,
          durationMs,
          activeMs,
          userMsgChars: (row.user_chars as number) ?? 0,
          assistantMsgChars: (row.assistant_chars as number) ?? 0,
        });
        if (results.length >= limit) break;
      }
    }
    return results;
  } finally {
    cpDb.close();
  }
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
