import { getDb } from './db';
import { getProjectById, getWorktreeById } from './project-store';

export type MergeRequestStatus = 'pending' | 'approved' | 'merging' | 'merged' | 'rejected' | 'conflict';
export type MergePriority = 'normal' | 'urgent';

export interface MergeRequest {
  id: string;
  projectId: string;
  worktreeId: string;
  branch: string;
  status: MergeRequestStatus;
  priority: MergePriority;
  requestedAt: string | null;
  resolvedAt: string | null;
  summary: string | null;
  leadNote: string | null;
}

export interface MergeExecutionResult {
  request: MergeRequest;
  pullRequestUrl: string | null;
  autoMergeRequested: boolean;
}

export interface MergeLock {
  projectId: string;
  heldByWorktreeId: string | null;
  heldSince: string | null;
  expiresAt: string | null;
  stale: boolean;
}

function rowToRequest(row: Record<string, unknown>): MergeRequest {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    worktreeId: row.worktree_id as string,
    branch: row.branch as string,
    status: row.status as MergeRequestStatus,
    priority: row.priority as MergePriority,
    requestedAt: (row.requested_at as string) ?? null,
    resolvedAt: (row.resolved_at as string) ?? null,
    summary: (row.summary as string) ?? null,
    leadNote: (row.lead_note as string) ?? null,
  };
}

export function getMergeRequest(id: string): MergeRequest | null {
  const row = getDb().prepare('SELECT * FROM merge_requests WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToRequest(row) : null;
}

export function getMergeRequestForWorktree(worktreeId: string): MergeRequest | null {
  const row = getDb().prepare('SELECT * FROM merge_requests WHERE worktree_id = ?').get(worktreeId) as Record<string, unknown> | undefined;
  return row ? rowToRequest(row) : null;
}

export function listMergeRequests(projectId?: string): MergeRequest[] {
  const rows = (projectId
    ? getDb().prepare('SELECT * FROM merge_requests WHERE project_id = ? ORDER BY priority DESC, requested_at').all(projectId)
    : getDb().prepare('SELECT * FROM merge_requests ORDER BY priority DESC, requested_at').all()) as Record<string, unknown>[];
  return rows.map(rowToRequest);
}

export function getMergeLock(projectId: string): MergeLock | null {
  const row = getDb().prepare('SELECT * FROM merge_locks WHERE project_id = ?').get(projectId) as
    | { project_id: string; held_by_worktree_id: string | null; held_since: string | null; expires_at: string | null }
    | undefined;
  if (!row) return null;

  const stale = Boolean(row.expires_at && new Date(row.expires_at).getTime() <= Date.now());
  if (stale) {
    getDb().prepare('DELETE FROM merge_locks WHERE project_id = ?').run(projectId);
    return null;
  }
  return {
    projectId: row.project_id,
    heldByWorktreeId: row.held_by_worktree_id,
    heldSince: row.held_since,
    expiresAt: row.expires_at,
    stale: false,
  };
}

export function requestMerge(worktreeId: string, summary: string): MergeRequest {
  const worktree = getWorktreeById(worktreeId);
  if (!worktree) throw new Error('Worktree not found');
  const existing = getMergeRequestForWorktree(worktreeId);
  if (existing && ['pending', 'approved', 'merging'].includes(existing.status)) return existing;
  const id = existing?.id ?? crypto.randomUUID();
  getDb().prepare(`
    INSERT INTO merge_requests (id, project_id, worktree_id, branch, status, summary, requested_at, resolved_at)
    VALUES (?, ?, ?, ?, 'pending', ?, datetime('now'), NULL)
    ON CONFLICT(worktree_id) DO UPDATE SET
      status = 'pending', summary = excluded.summary, requested_at = datetime('now'), resolved_at = NULL, lead_note = NULL
  `).run(id, worktree.projectId, worktreeId, worktree.branch, summary);
  return getMergeRequest(id)!;
}

export function setMergePriority(id: string, priority: MergePriority): MergeRequest {
  if (!['normal', 'urgent'].includes(priority)) throw new Error('Invalid merge priority');
  getDb().prepare('UPDATE merge_requests SET priority = ? WHERE id = ?').run(priority, id);
  const request = getMergeRequest(id);
  if (!request) throw new Error('Merge request not found');
  return request;
}

export function resolveMergeRequest(id: string, status: 'approved' | 'rejected' | 'conflict', note?: string): MergeRequest {
  const request = getMergeRequest(id);
  if (!request) throw new Error('Merge request not found');
  if (request.status === 'merged') throw new Error('Merged requests cannot be changed');
  getDb().prepare(`
    UPDATE merge_requests SET status = ?, lead_note = ?, resolved_at = datetime('now') WHERE id = ?
  `).run(status, note ?? null, id);
  return getMergeRequest(id)!;
}

export function acquireMergeLock(projectId: string, worktreeId: string, timeoutMinutes = 15): void {
  if (!getProjectById(projectId)) throw new Error('Project not found');
  const existing = getDb().prepare('SELECT * FROM merge_locks WHERE project_id = ?').get(projectId) as
    | { held_by_worktree_id: string; expires_at: string | null }
    | undefined;
  if (existing && existing.held_by_worktree_id !== worktreeId && existing.expires_at && new Date(existing.expires_at).getTime() > Date.now()) {
    throw new Error(`Merge lock held by worktree ${existing.held_by_worktree_id}`);
  }
  getDb().prepare(`
    INSERT INTO merge_locks (project_id, held_by_worktree_id, held_since, expires_at)
    VALUES (?, ?, datetime('now'), datetime('now', ?))
    ON CONFLICT(project_id) DO UPDATE SET
      held_by_worktree_id = excluded.held_by_worktree_id,
      held_since = excluded.held_since,
      expires_at = excluded.expires_at
  `).run(projectId, worktreeId, `+${timeoutMinutes} minutes`);
}

export function releaseMergeLock(projectId: string, worktreeId?: string): void {
  if (worktreeId) {
    getDb().prepare('DELETE FROM merge_locks WHERE project_id = ? AND held_by_worktree_id = ?').run(projectId, worktreeId);
  } else {
    getDb().prepare('DELETE FROM merge_locks WHERE project_id = ?').run(projectId);
  }
}

function getMergeMode(projectId: string): 'advisory' | 'auto_queue' | 'full_auto' {
  const row = getDb().prepare(
    'SELECT merge_mode FROM project_autonomy_settings WHERE project_id = ?',
  ).get(projectId) as { merge_mode?: string } | undefined;
  return row?.merge_mode === 'full_auto' || row?.merge_mode === 'auto_queue'
    ? row.merge_mode
    : 'advisory';
}

function extractPullRequestUrl(output: string): string | null {
  const match = output.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
  return match?.[0] ?? null;
}

/**
 * Create a PR from an approved worktree request without delegating merge
 * authority to the worker's shell. The lock is held only for the duration of
 * the server-side operation and is released on every terminal path.
 */
export async function executeApprovedMerge(id: string): Promise<MergeExecutionResult> {
  const request = getMergeRequest(id);
  if (!request) throw new Error('Merge request not found');
  if (request.status !== 'approved') {
    throw new Error(`Merge request is ${request.status}, not approved`);
  }

  const project = getProjectById(request.projectId);
  if (!project) throw new Error('Project not found');

  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);
  const mergeMode = getMergeMode(request.projectId);

  acquireMergeLock(request.projectId, request.worktreeId);
  getDb().prepare(
    "UPDATE merge_requests SET status = 'merging', lead_note = ? WHERE id = ?",
  ).run(request.leadNote, request.id);

  try {
    const { stdout } = await execFileAsync('gh', [
      'pr', 'create',
      '--head', request.branch,
      '--title', request.summary?.trim() || `Merge ${request.branch}`,
      '--body', request.summary?.trim() || `Merge request for ${request.branch}.`,
    ], {
      cwd: project.repoPath,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 32_000,
    });
    const pullRequestUrl = extractPullRequestUrl(stdout);
    if (!pullRequestUrl) {
      throw new Error('gh pr create did not return a pull request URL');
    }

    if (mergeMode === 'full_auto') {
      await execFileAsync('gh', [
        'pr', 'merge', pullRequestUrl, '--auto', '--squash', '--delete-branch',
      ], {
        cwd: project.repoPath,
        encoding: 'utf8',
        timeout: 120_000,
        maxBuffer: 32_000,
      });
    }

    const note = [
      request.leadNote,
      pullRequestUrl ? `PR created: ${pullRequestUrl}` : 'PR created.',
      mergeMode === 'full_auto' && pullRequestUrl ? 'Auto-merge requested.' : null,
    ].filter(Boolean).join(' ');
    const updated = getDb().prepare(
      "UPDATE merge_requests SET status = 'merging', lead_note = ?, resolved_at = datetime('now') WHERE id = ?",
    ).run(note, request.id);
    if (updated.changes !== 1) throw new Error('Merge request disappeared during execution');

    return {
      request: getMergeRequest(request.id)!,
      pullRequestUrl,
      autoMergeRequested: mergeMode === 'full_auto',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    getDb().prepare(
      "UPDATE merge_requests SET status = 'conflict', lead_note = ?, resolved_at = datetime('now') WHERE id = ?",
    ).run(`Merge execution failed: ${message}`, request.id);
    throw new Error(`Merge execution failed: ${message}`);
  } finally {
    releaseMergeLock(request.projectId, request.worktreeId);
  }
}
