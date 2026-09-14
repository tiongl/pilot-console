import { randomUUID } from 'crypto';
import { getDb } from './db';
import { emitWorktreesChanged } from './worktree-events';

export type DelegationStatus =
  | 'planning'
  | 'awaiting_plan_review'
  | 'working'
  | 'blocked'
  | 'done'
  | 'cancelled'
  /** Cleaned up: the worktree is gone and the lead page no longer lists it. */
  | 'closed';

/** Statuses that still occupy a slot against the per-project concurrency cap. */
const ACTIVE_STATUSES: DelegationStatus[] = ['planning', 'awaiting_plan_review', 'working', 'blocked'];

export interface Delegation {
  id: string;
  projectId: string;
  worktreeId: string;
  worktreeName: string | null;
  sessionId: string | null;
  title: string;
  task: string;
  status: DelegationStatus;
  note: string | null;
  unread: number;
  /** 1 when this is a spin_off_review reviewer rather than a builder worker. */
  isReview: number;
  /** 1 when the reviewer's condensed reasoning should be folded back to the lead. */
  deepMerge: number;
  createdAt: string | null;
  updatedAt: string | null;
}

const SELECT = `
  SELECT d.id, d.project_id AS projectId, d.worktree_id AS worktreeId, w.name AS worktreeName,
         d.session_id AS sessionId, d.title, d.task, d.status, d.note, d.unread,
         d.is_review AS isReview, d.deep_merge AS deepMerge,
         d.created_at AS createdAt, d.updated_at AS updatedAt
  FROM delegations d
  LEFT JOIN worktrees w ON w.id = d.worktree_id
`;

/** Keep tab labels and sidebar entries short enough to read at a glance. */
export function shortTitle(text: string, maxChars = 40): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= maxChars) return flat;
  const clipped = flat.slice(0, maxChars);
  const lastSpace = clipped.lastIndexOf(' ');
  return `${(lastSpace > maxChars * 0.5 ? clipped.slice(0, lastSpace) : clipped).replace(/[.,;:\s]+$/, '')}…`;
}

export function createDelegation(input: {
  projectId: string;
  worktreeId: string;
  title: string;
  task: string;
  sessionId?: string | null;
  isReview?: boolean;
  deepMerge?: boolean;
}): Delegation {
  const id = randomUUID();
  getDb().prepare(`
    INSERT INTO delegations (id, project_id, worktree_id, session_id, title, task, status, is_review, deep_merge)
    VALUES (?, ?, ?, ?, ?, ?, 'planning', ?, ?)
  `).run(
    id,
    input.projectId,
    input.worktreeId,
    input.sessionId ?? null,
    shortTitle(input.title),
    input.task,
    input.isReview ? 1 : 0,
    input.deepMerge ? 1 : 0,
  );
  emitWorktreesChanged(input.projectId);
  return getDelegation(id)!;
}

export function getDelegation(id: string): Delegation | undefined {
  return getDb().prepare(`${SELECT} WHERE d.id = ?`).get(id) as Delegation | undefined;
}

/** The newest delegation for a worktree — how a worker finds its own record. */
export function getDelegationForWorktree(worktreeId: string): Delegation | undefined {
  return getDb()
    .prepare(`${SELECT} WHERE d.worktree_id = ? ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1`)
    .get(worktreeId) as Delegation | undefined;
}

export function listDelegations(projectId: string): Delegation[] {
  return getDb()
    .prepare(`${SELECT} WHERE d.project_id = ? ORDER BY d.created_at ASC, d.rowid ASC`)
    .all(projectId) as Delegation[];
}

/** Every delegation across all projects — drives the sidebar tree. */
export function listAllDelegations(): Delegation[] {
  return getDb().prepare(`${SELECT} ORDER BY d.created_at ASC, d.rowid ASC`).all() as Delegation[];
}

export function listActiveDelegations(projectId: string): Delegation[] {  const placeholders = ACTIVE_STATUSES.map(() => '?').join(',');
  return getDb()
    .prepare(`${SELECT} WHERE d.project_id = ? AND d.status IN (${placeholders}) ORDER BY d.created_at ASC`)
    .all(projectId, ...ACTIVE_STATUSES) as Delegation[];
}

export function countActiveDelegations(projectId: string): number {
  const placeholders = ACTIVE_STATUSES.map(() => '?').join(',');
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM delegations WHERE project_id = ? AND is_review = 0 AND status IN (${placeholders})`,
    )
    .get(projectId, ...ACTIVE_STATUSES) as { n: number };
  return row?.n ?? 0;
}

/** In-flight spin_off_review reviewers, counted against their own cap. */
export function countActiveReviews(projectId: string): number {
  const placeholders = ACTIVE_STATUSES.map(() => '?').join(',');
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM delegations WHERE project_id = ? AND is_review = 1 AND status IN (${placeholders})`,
    )
    .get(projectId, ...ACTIVE_STATUSES) as { n: number };
  return row?.n ?? 0;
}

export function updateDelegation(
  id: string,
  patch: { status?: DelegationStatus; sessionId?: string | null; note?: string | null; unread?: boolean },
): Delegation | undefined {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.status !== undefined) { sets.push('status = ?'); values.push(patch.status); }
  if (patch.sessionId !== undefined) { sets.push('session_id = ?'); values.push(patch.sessionId); }
  if (patch.note !== undefined) { sets.push('note = ?'); values.push(patch.note); }
  if (patch.unread !== undefined) { sets.push('unread = ?'); values.push(patch.unread ? 1 : 0); }
  if (sets.length === 0) return getDelegation(id);
  sets.push("updated_at = datetime('now')");
  getDb().prepare(`UPDATE delegations SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  const updated = getDelegation(id);
  if (updated) emitWorktreesChanged(updated.projectId);
  return updated;
}

/** Flag a worktree's delegation as needing attention (plan review, blocker). */
export function markWorktreeDelegation(
  worktreeId: string,
  patch: { status?: DelegationStatus; note?: string | null; unread?: boolean },
): Delegation | undefined {
  const existing = getDelegationForWorktree(worktreeId);
  if (!existing) return undefined;
  return updateDelegation(existing.id, patch);
}

/**
 * Retire every delegation on a worktree that is being removed, and report how
 * many changed. Marking them first means any UI poll that lands between this
 * and the worktree's deletion already sees them as finished; the rows
 * themselves then go with the worktree via `ON DELETE CASCADE`.
 */
export function closeDelegationsForWorktree(worktreeId: string): number {
  return getDb()
    .prepare(
      "UPDATE delegations SET status = 'closed', unread = 0, updated_at = datetime('now') " +
        "WHERE worktree_id = ? AND status != 'closed'",
    )
    .run(worktreeId).changes;
}

export function clearDelegationUnread(id: string): void {
  getDb().prepare("UPDATE delegations SET unread = 0, updated_at = datetime('now') WHERE id = ?").run(id);
}
/** Per-project unread counts, for sidebar badges. */
export function unreadDelegationCounts(): Record<string, number> {
  const rows = getDb().prepare(`
    SELECT project_id AS projectId, COUNT(*) AS n
    FROM delegations WHERE unread = 1 GROUP BY project_id
  `).all() as Array<{ projectId: string; n: number }>;
  return Object.fromEntries(rows.map((r) => [r.projectId, r.n]));
}
