import { getDb } from './db';
import { v4 as uuidv4 } from 'uuid';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReportSchedule {
  id: string;
  name: string;
  prompt: string;
  cronExpression: string;
  rendererType: string;
  enabled: boolean;
  cwd: string | null;
  maxRuntimeMs: number;
  maxRunsRetained: number;
  createdBy: string | null;
  nextRunAt: string | null;
  lastStartedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReportRun {
  id: string;
  scheduleId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'timed_out';
  triggeredBy: 'scheduler' | 'manual';
  startedAt: string | null;
  completedAt: string | null;
  rawOutput: string | null;
  renderedOutput: string | null;
  rendererType: string | null;
  exitCode: number | null;
  wasTruncated: boolean;
  error: string | null;
  promptSnapshot: string | null;
  daemonSessionId: string | null;
}

/** Run summary without large output fields */
export interface ReportRunSummary {
  id: string;
  scheduleId: string;
  status: string;
  triggeredBy: string;
  startedAt: string | null;
  completedAt: string | null;
  rendererType: string | null;
  exitCode: number | null;
  wasTruncated: boolean;
  error: string | null;
  read: boolean;
}

// ---------------------------------------------------------------------------
// Schedules CRUD
// ---------------------------------------------------------------------------

export function createSchedule(data: {
  name: string;
  prompt: string;
  cronExpression: string;
  rendererType?: string;
  cwd?: string | null;
  maxRuntimeMs?: number;
  maxRunsRetained?: number;
  createdBy?: string;
  nextRunAt?: string;
  enabled?: boolean;
}): ReportSchedule {
  const db = getDb();
  const id = uuidv4();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO report_schedules (id, name, prompt, cron_expression, renderer_type, enabled, cwd, max_runtime_ms, max_runs_retained, created_by, next_run_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    data.name,
    data.prompt,
    data.cronExpression,
    data.rendererType ?? 'plaintext',
    data.enabled === false ? 0 : 1,
    data.cwd ?? null,
    data.maxRuntimeMs ?? 300000,
    data.maxRunsRetained ?? 50,
    data.createdBy ?? null,
    data.nextRunAt ?? null,
    now,
    now,
  );

  return getScheduleById(id)!;
}

export function getScheduleById(id: string): ReportSchedule | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM report_schedules WHERE id = ?').get(id) as any;
  return row ? mapScheduleRow(row) : null;
}

export function listSchedules(): ReportSchedule[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM report_schedules ORDER BY created_at DESC').all() as any[];
  return rows.map(mapScheduleRow);
}

export function updateSchedule(id: string, data: Partial<{
  name: string;
  prompt: string;
  cronExpression: string;
  rendererType: string;
  enabled: boolean;
  cwd: string | null;
  maxRuntimeMs: number;
  maxRunsRetained: number;
  nextRunAt: string | null;
  lastStartedAt: string | null;
}>): ReportSchedule {
  const db = getDb();
  const existing = getScheduleById(id);
  if (!existing) throw new Error('Schedule not found');

  const fields: string[] = [];
  const values: any[] = [];

  if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name); }
  if (data.prompt !== undefined) { fields.push('prompt = ?'); values.push(data.prompt); }
  if (data.cronExpression !== undefined) { fields.push('cron_expression = ?'); values.push(data.cronExpression); }
  if (data.rendererType !== undefined) { fields.push('renderer_type = ?'); values.push(data.rendererType); }
  if (data.enabled !== undefined) { fields.push('enabled = ?'); values.push(data.enabled ? 1 : 0); }
  if (data.cwd !== undefined) { fields.push('cwd = ?'); values.push(data.cwd); }
  if (data.maxRuntimeMs !== undefined) { fields.push('max_runtime_ms = ?'); values.push(data.maxRuntimeMs); }
  if (data.maxRunsRetained !== undefined) { fields.push('max_runs_retained = ?'); values.push(data.maxRunsRetained); }
  if (data.nextRunAt !== undefined) { fields.push('next_run_at = ?'); values.push(data.nextRunAt); }
  if (data.lastStartedAt !== undefined) { fields.push('last_started_at = ?'); values.push(data.lastStartedAt); }

  if (fields.length === 0) return existing;

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  db.prepare(`UPDATE report_schedules SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getScheduleById(id)!;
}

export function deleteSchedule(id: string): void {
  const db = getDb();
  db.prepare('DELETE FROM report_schedules WHERE id = ?').run(id);
}

/**
 * Get schedules that are due to run: enabled, next_run_at <= now,
 * and not currently running (no run in 'running' status).
 */
export function getDueSchedules(): ReportSchedule[] {
  const db = getDb();
  const now = new Date().toISOString();
  const rows = db.prepare(`
    SELECT s.* FROM report_schedules s
    WHERE s.enabled = 1
      AND s.next_run_at IS NOT NULL
      AND s.next_run_at <= ?
      AND NOT EXISTS (
        SELECT 1 FROM report_runs r
        WHERE r.schedule_id = s.id AND r.status = 'running'
      )
  `).all(now) as any[];
  return rows.map(mapScheduleRow);
}

// ---------------------------------------------------------------------------
// Runs CRUD
// ---------------------------------------------------------------------------

export function createRun(data: {
  scheduleId: string;
  triggeredBy: 'scheduler' | 'manual';
  promptSnapshot: string;
}): ReportRun {
  const db = getDb();
  const id = uuidv4();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO report_runs (id, schedule_id, status, triggered_by, started_at, prompt_snapshot)
    VALUES (?, ?, 'running', ?, ?, ?)
  `).run(id, data.scheduleId, data.triggeredBy, now, data.promptSnapshot);

  return getRunById(id)!;
}

export function getRunById(id: string): ReportRun | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM report_runs WHERE id = ?').get(id) as any;
  return row ? mapRunRow(row) : null;
}

export function listRunsForSchedule(scheduleId: string, limit = 20): ReportRunSummary[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, schedule_id, status, triggered_by, started_at, completed_at, renderer_type, exit_code, was_truncated, error, read
    FROM report_runs
    WHERE schedule_id = ?
    ORDER BY started_at DESC
    LIMIT ?
  `).all(scheduleId, limit) as any[];
  return rows.map(mapRunSummaryRow);
}

export function completeRun(id: string, data: {
  status: 'completed' | 'failed' | 'timed_out';
  rawOutput: string;
  renderedOutput: string | null;
  rendererType: string;
  exitCode: number;
  wasTruncated: boolean;
  error?: string;
}): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE report_runs SET
      status = ?, completed_at = ?, raw_output = ?, rendered_output = ?,
      renderer_type = ?, exit_code = ?, was_truncated = ?, error = ?
    WHERE id = ?
  `).run(
    data.status, now, data.rawOutput, data.renderedOutput,
    data.rendererType, data.exitCode, data.wasTruncated ? 1 : 0, data.error ?? null,
    id,
  );
}

export function updateRunDaemonSession(id: string, daemonSessionId: string): void {
  const db = getDb();
  db.prepare('UPDATE report_runs SET daemon_session_id = ? WHERE id = ?').run(daemonSessionId, id);
}

export function getRunningRunForSchedule(scheduleId: string): ReportRun | null {
  const db = getDb();
  const row = db.prepare(
    "SELECT * FROM report_runs WHERE schedule_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1"
  ).get(scheduleId) as any;
  return row ? mapRunRow(row) : null;
}

export function pruneOldRuns(scheduleId: string, maxRetained: number): number {
  const db = getDb();
  const result = db.prepare(`
    DELETE FROM report_runs
    WHERE schedule_id = ? AND id NOT IN (
      SELECT id FROM report_runs
      WHERE schedule_id = ?
      ORDER BY started_at DESC
      LIMIT ?
    )
  `).run(scheduleId, scheduleId, maxRetained);
  return result.changes;
}

export function deleteRunById(id: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM report_runs WHERE id = ?').run(id);
  return result.changes > 0;
}

export function deleteAllRuns(): number {
  const db = getDb();
  const result = db.prepare('DELETE FROM report_runs').run();
  return result.changes;
}

export function markRunsRead(ids: string[]): void {
  const db = getDb();
  const stmt = db.prepare('UPDATE report_runs SET read = 1 WHERE id = ?');
  const tx = db.transaction(() => { for (const id of ids) stmt.run(id); });
  tx();
}

export function markRunsUnread(ids: string[]): void {
  const db = getDb();
  const stmt = db.prepare('UPDATE report_runs SET read = 0 WHERE id = ?');
  const tx = db.transaction(() => { for (const id of ids) stmt.run(id); });
  tx();
}

/** Mark any runs stuck in 'running' or 'pending' as failed (e.g. after server restart). */
export function cleanupStaleRuns(): number {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE report_runs
    SET status = 'failed', completed_at = ?, error = 'Server restarted while running'
    WHERE status IN ('running', 'pending')
  `).run(now);
  return result.changes;
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function mapScheduleRow(row: any): ReportSchedule {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    cronExpression: row.cron_expression,
    rendererType: row.renderer_type,
    enabled: !!row.enabled,
    cwd: row.cwd,
    maxRuntimeMs: row.max_runtime_ms,
    maxRunsRetained: row.max_runs_retained,
    createdBy: row.created_by,
    nextRunAt: row.next_run_at,
    lastStartedAt: row.last_started_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRunRow(row: any): ReportRun {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    status: row.status,
    triggeredBy: row.triggered_by,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    rawOutput: row.raw_output,
    renderedOutput: row.rendered_output,
    rendererType: row.renderer_type,
    exitCode: row.exit_code,
    wasTruncated: !!row.was_truncated,
    error: row.error,
    promptSnapshot: row.prompt_snapshot,
    daemonSessionId: row.daemon_session_id ?? null,
  };
}

function mapRunSummaryRow(row: any): ReportRunSummary {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    status: row.status,
    triggeredBy: row.triggered_by,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    rendererType: row.renderer_type,
    exitCode: row.exit_code,
    wasTruncated: !!row.was_truncated,
    error: row.error,
    read: !!row.read,
  };
}

// ---------------------------------------------------------------------------
// Cross-schedule queries
// ---------------------------------------------------------------------------

/** Run summary with schedule name for cross-schedule listing */
export interface ReportRunWithSchedule extends ReportRunSummary {
  scheduleName: string;
  rendererType: string | null;
}

export function listAllRuns(limit = 50, since?: string, offset = 0, scheduleId?: string): ReportRunWithSchedule[] {
  const db = getDb();
  let query = `
    SELECT r.id, r.schedule_id, r.status, r.triggered_by, r.started_at, r.completed_at,
           r.renderer_type, r.exit_code, r.was_truncated, r.error, r.read,
           s.name as schedule_name
    FROM report_runs r
    JOIN report_schedules s ON r.schedule_id = s.id
  `;
  const conditions: string[] = [];
  const params: any[] = [];
  if (since) {
    conditions.push('r.completed_at > ?');
    params.push(since);
  }
  if (scheduleId) {
    conditions.push('r.schedule_id = ?');
    params.push(scheduleId);
  }
  if (conditions.length) {
    query += ' WHERE ' + conditions.join(' AND ');
  }
  query += ' ORDER BY r.started_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = db.prepare(query).all(...params) as any[];
  return rows.map(row => ({
    ...mapRunSummaryRow(row),
    scheduleName: row.schedule_name,
    rendererType: row.renderer_type,
  }));
}

export function countAllRuns(scheduleId?: string): number {
  const db = getDb();
  if (scheduleId) {
    const row = db.prepare('SELECT COUNT(*) as cnt FROM report_runs WHERE schedule_id = ?').get(scheduleId) as any;
    return row?.cnt ?? 0;
  }
  const row = db.prepare('SELECT COUNT(*) as cnt FROM report_runs').get() as any;
  return row?.cnt ?? 0;
}

export function countRunsSince(since: string): number {
  const db = getDb();
  const row = db.prepare(
    "SELECT COUNT(*) as cnt FROM report_runs WHERE completed_at > ? AND status IN ('completed', 'failed', 'timed_out')"
  ).get(since) as any;
  return row?.cnt ?? 0;
}
