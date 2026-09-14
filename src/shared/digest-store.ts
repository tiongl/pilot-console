import { execFileSync } from 'child_process';
import { getDb } from './db';
import { getProjectById, getWorktreeById } from './project-store';
import type { AgentDigest, AgentDigestScope, AgentDigestStatus } from './types';

const DIGEST_STATUSES = new Set<AgentDigestStatus>(['in_progress', 'blocked', 'ready_to_merge', 'idle']);
const DIGEST_SCOPES = new Set<AgentDigestScope>(['small', 'medium', 'large']);

function rowToDigest(row: Record<string, unknown>): AgentDigest {
  let touchedFiles: string[] = [];
  if (typeof row.touched_files === 'string' && row.touched_files) {
    try {
      const parsed: unknown = JSON.parse(row.touched_files);
      if (Array.isArray(parsed) && parsed.every((file) => typeof file === 'string')) touchedFiles = parsed;
    } catch {
      touchedFiles = [];
    }
  }
  return {
    worktreeId: row.worktree_id as string,
    projectId: row.project_id as string,
    headline: (row.headline as string) ?? null,
    status: (row.status as AgentDigestStatus) ?? null,
    detail: (row.detail as string) ?? null,
    scope: (row.scope as AgentDigestScope) ?? null,
    touchedFiles,
    riskNotes: (row.risk_notes as string) ?? null,
    stuckSince: (row.stuck_since as string) ?? null,
    updatedAt: (row.updated_at as string) ?? null,
  };
}

function getDigestRow(worktreeId: string): AgentDigest | null {
  const row = getDb().prepare('SELECT * FROM agent_digests WHERE worktree_id = ?').get(worktreeId) as Record<string, unknown> | undefined;
  return row ? rowToDigest(row) : null;
}

function assertWorktree(worktreeId: string, projectId?: string) {
  const worktree = getWorktreeById(worktreeId);
  if (!worktree) throw new Error('Worktree not found');
  if (projectId && worktree.projectId !== projectId) throw new Error('Worktree does not belong to this project');
  return worktree;
}

export function getDigest(worktreeId: string, projectId?: string): AgentDigest | null {
  assertWorktree(worktreeId, projectId);
  return getDigestRow(worktreeId);
}

export function listDigests(projectId: string): AgentDigest[] {
  if (!getProjectById(projectId)) throw new Error('Project not found');
  const rows = getDb()
    .prepare('SELECT * FROM agent_digests WHERE project_id = ? ORDER BY updated_at DESC')
    .all(projectId) as Record<string, unknown>[];
  return rows.map(rowToDigest);
}

export interface UpdateDigestInput {
  headline?: string | null;
  status?: AgentDigestStatus | null;
  detail?: string | null;
  scope?: AgentDigestScope | null;
  touchedFiles?: string[];
  riskNotes?: string | null;
}

export function upsertDigest(worktreeId: string, input: UpdateDigestInput): AgentDigest {
  const worktree = assertWorktree(worktreeId);
  if (input.status !== undefined && input.status !== null && !DIGEST_STATUSES.has(input.status)) {
    throw new Error(`Invalid digest status: ${input.status}`);
  }
  if (input.scope !== undefined && input.scope !== null && !DIGEST_SCOPES.has(input.scope)) {
    throw new Error(`Invalid digest scope: ${input.scope}`);
  }
  if (input.touchedFiles !== undefined && (!Array.isArray(input.touchedFiles) || input.touchedFiles.some((file) => typeof file !== 'string'))) {
    throw new Error('touchedFiles must be an array of strings');
  }

  const existing = getDigestRow(worktreeId);
  const next = {
    headline: input.headline !== undefined ? input.headline : existing?.headline ?? null,
    status: input.status !== undefined ? input.status : existing?.status ?? 'idle',
    detail: input.detail !== undefined ? input.detail : existing?.detail ?? null,
    scope: input.scope !== undefined ? input.scope : existing?.scope ?? null,
    touchedFiles: input.touchedFiles !== undefined ? input.touchedFiles : existing?.touchedFiles ?? [],
    riskNotes: input.riskNotes !== undefined ? input.riskNotes : existing?.riskNotes ?? null,
  };
  getDb().prepare(`
    INSERT INTO agent_digests
      (worktree_id, project_id, headline, status, detail, scope, touched_files, risk_notes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(worktree_id) DO UPDATE SET
      project_id = excluded.project_id,
      headline = excluded.headline,
      status = excluded.status,
      detail = excluded.detail,
      scope = excluded.scope,
      touched_files = excluded.touched_files,
      risk_notes = excluded.risk_notes,
      updated_at = datetime('now')
  `).run(
    worktreeId,
    worktree.projectId,
    next.headline,
    next.status,
    next.detail,
    next.scope,
    JSON.stringify(next.touchedFiles),
    next.riskNotes,
  );
  return getDigestRow(worktreeId)!;
}

function gitLog(worktreePath: string): string {
  try {
    return execFileSync('git', ['log', '-1', '--pretty=format:%s'], {
      cwd: worktreePath,
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function gitTouchedFiles(worktreePath: string): string[] {
  try {
    const output = execFileSync('git', ['status', '--short'], {
      cwd: worktreePath,
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.split(/\r?\n/)
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function reconcileDigest(worktreeId: string): AgentDigest {
  const worktree = assertWorktree(worktreeId);
  const existing = getDigestRow(worktreeId);
  if (worktree.type === 'directory') {
    return existing ?? bootstrapDigest(worktreeId);
  }
  return upsertDigest(worktreeId, {
    headline: existing?.headline || gitLog(worktree.worktreePath) || `Working in ${worktree.name}`,
    status: existing?.status ?? 'idle',
    detail: existing?.detail,
    scope: existing?.scope,
    touchedFiles: gitTouchedFiles(worktree.worktreePath),
    riskNotes: existing?.riskNotes,
  });
}

export function bootstrapDigest(worktreeId: string): AgentDigest {
  const worktree = assertWorktree(worktreeId);
  const headline = gitLog(worktree.worktreePath);
  return upsertDigest(worktreeId, {
    headline: headline || `Working in ${worktree.name}`,
    status: 'idle',
    detail: 'Digest seeded from the latest repository state. The next worktree agent update will replace this summary.',
    scope: null,
    touchedFiles: [],
    riskNotes: null,
  });
}
