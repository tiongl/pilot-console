/**
 * Watches delegated workers and tells the Project Lead when one stops running.
 *
 * The lead is explicitly forbidden from polling for its workers, so it learns
 * about them only through the messages they send it. A worker that stops
 * without reporting never sends anything: its delegation sits in an active
 * status indefinitely while the lead assumes the work is still in progress.
 */

import {
  listAllDelegations,
  updateDelegation,
  type Delegation,
  type DelegationStatus,
} from '../shared/delegation-store';
import { getDb } from '../shared/db';

let monitorInterval: ReturnType<typeof setInterval> | null = null;

const CHECK_INTERVAL_MS = 60_000;

/**
 * How long a delegation must have been untouched before its worker is worth
 * inspecting. Workers report at milestones, so this only needs to outlast a
 * normal quiet stretch of work.
 */
export const STALL_GRACE_MS = 10 * 60 * 1000;

/** Statuses that claim the worker is still alive and working on something. */
const WATCHED_STATUSES: DelegationStatus[] = ['planning', 'awaiting_plan_review', 'working'];

/**
 * SQLite writes `datetime('now')` as UTC with no zone marker, which
 * `Date.parse` would read as local time — far enough off to hide every stall.
 */
export function parseDbTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const normalized = /[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value.replace(' ', 'T')}Z`;
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Whether a delegation has been quiet long enough to inspect. Pure, for tests. */
export function isStale(
  updatedAt: string | null | undefined,
  now: number,
  graceMs = STALL_GRACE_MS,
): boolean {
  const ts = parseDbTimestamp(updatedAt);
  // An unparseable timestamp is not evidence of a stall; leave it alone.
  if (ts === null) return false;
  return now - ts >= graceMs;
}

/** The user who owns a delegation, via the session that was opened for it. */
function ownerOf(delegation: Delegation): string | undefined {
  if (!delegation.sessionId) return undefined;
  const row = getDb()
    .prepare('SELECT user_id FROM cli_sessions WHERE id = ?')
    .get(delegation.sessionId) as { user_id?: string } | undefined;
  return row?.user_id;
}

/**
 * Whether the worker behind a delegation is still doing something.
 *
 * A session missing from this process is not proof of death — the runtime is
 * hosted by the daemon and outlives a server restart — so an absent session is
 * resumed before judging it. A session that resumes but sits idle has stopped
 * working without reporting, which is the case the lead needs to hear about.
 */
async function workerIsRunning(delegation: Delegation): Promise<boolean> {
  const { findLiveWorktreeAgent, resumeAgentSession } = await import('../shared/agent-bridge');

  let session = findLiveWorktreeAgent(delegation.projectId, delegation.worktreeId);
  if (!session && delegation.sessionId) {
    const userId = ownerOf(delegation);
    if (userId) {
      try {
        session = await resumeAgentSession(userId, delegation.sessionId);
      } catch (err) {
        console.warn(`[delegation-monitor] Could not resume ${delegation.sessionId}:`, err);
        return false;
      }
    }
  }
  return Boolean(session?.alive && session.status === 'busy');
}

export async function sweepStalledDelegations(now = Date.now()): Promise<number> {
  const { hasPendingPlanReview, notifyProjectLead } = await import('../shared/delegation-runtime');

  let flagged = 0;
  for (const delegation of listAllDelegations()) {
    if (!WATCHED_STATUSES.includes(delegation.status)) continue;
    if (!isStale(delegation.updatedAt, now)) continue;
    // Waiting on the lead is the system working as intended, not a stall. Once
    // the review itself is gone the worker is stuck on a promise nobody holds.
    if (delegation.status === 'awaiting_plan_review' && hasPendingPlanReview(delegation.worktreeId)) {
      continue;
    }
    if (await workerIsRunning(delegation)) continue;

    const note = 'Worker stopped without reporting a result.';
    updateDelegation(delegation.id, { status: 'blocked', note, unread: true });
    flagged += 1;
    console.warn(
      `[delegation-monitor] ${delegation.title} (${delegation.worktreeId}) stopped without finishing`,
    );

    const userId = ownerOf(delegation);
    if (!userId) continue;
    const message = [
      `[worker stopped · ${delegation.title}]`,
      `Worktree id: ${delegation.worktreeId}`,
      '',
      'This worker is no longer working and never reported a result. Its session ended or went idle mid-task — usually a crash or an interrupted turn, not a decision it made.',
      '',
      `Check what it left behind with get_digest. To retry, close it out with cancel_worker and start it again with delegate_to_worker using worktreeId "${delegation.worktreeId}" so its existing branch and work are reused.`,
    ].join('\n');
    try {
      await notifyProjectLead(userId, delegation.projectId, message);
    } catch (err) {
      console.error(`[delegation-monitor] Could not notify lead for ${delegation.worktreeId}:`, err);
    }
  }
  return flagged;
}

/** Start the stall sweep. Called once at server startup. */
export function startDelegationMonitor(): void {
  if (monitorInterval) {
    console.warn('[delegation-monitor] Already running');
    return;
  }
  console.log('[delegation-monitor] Starting worker stall monitor (60s interval)');
  const tick = () => {
    sweepStalledDelegations().catch((err) => {
      console.error('[delegation-monitor] Sweep failed:', err);
    });
  };
  monitorInterval = setInterval(tick, CHECK_INTERVAL_MS);
  monitorInterval.unref?.();
  tick();
}

export function stopDelegationMonitor(): void {
  if (!monitorInterval) return;
  clearInterval(monitorInterval);
  monitorInterval = null;
  console.log('[delegation-monitor] Stopped');
}
