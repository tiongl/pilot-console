import { randomUUID } from 'crypto';
import { markWorktreeDelegation, getDelegationForWorktree } from './delegation-store';

export interface LeadPlanDecision {
  approved: boolean;
  note: string;
}

interface PendingPlanReview {
  worktreeId: string;
  projectId: string;
  title: string;
  resolve: (decision: LeadPlanDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Plan reviews the Project Lead has been asked for but has not answered yet. */
const pendingPlanReviews = new Map<string, PendingPlanReview>();

/** How long a worker waits for its lead before falling back to asking the user. */
export const PLAN_REVIEW_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Deliver a message into the project's persistent Project Lead conversation.
 *
 * Uses the same session the lead page shows, so anything a worker says lands in
 * the transcript the user reads. If the lead is mid-turn the message is queued
 * by `sendToSession` and delivered when that turn ends, so this never blocks.
 */
export async function notifyProjectLead(
  userId: string,
  projectId: string,
  message: string,
): Promise<void> {
  const { getOrCreatePersistentLeadSession, sendToSession } = await import('./agent-bridge');
  const session = await getOrCreatePersistentLeadSession(userId, projectId, 'project_lead');
  await sendToSession(session, message);
}

/**
 * Ask the Project Lead to review a worker's plan and block until it answers.
 *
 * Resolves `null` if no lead decision arrives before the timeout, so the caller
 * can fall back to escalating the plan to the user instead of hanging forever.
 */
export async function requestLeadPlanReview(input: {
  userId: string;
  projectId: string;
  worktreeId: string;
  summary: string;
  planContent: string;
}): Promise<LeadPlanDecision | null> {
  const delegation = getDelegationForWorktree(input.worktreeId);
  if (!delegation) return null;

  // A second plan from the same worker supersedes any review still pending.
  cancelLeadPlanReview(input.worktreeId, 'Superseded by a newer plan');

  markWorktreeDelegation(input.worktreeId, { status: 'awaiting_plan_review', unread: true, note: input.summary });

  const decision = new Promise<LeadPlanDecision | null>((resolve) => {
    const timer = setTimeout(() => {
      pendingPlanReviews.delete(input.worktreeId);
      resolve(null);
    }, PLAN_REVIEW_TIMEOUT_MS);
    // Node keeps the process alive for pending timers; this one must not.
    timer.unref?.();
    pendingPlanReviews.set(input.worktreeId, {
      worktreeId: input.worktreeId,
      projectId: input.projectId,
      title: delegation.title,
      resolve: (value) => resolve(value),
      timer,
    });
  });

  const prompt = [
    `[worker plan review · ${delegation.title}]`,
    `Worktree id: ${input.worktreeId}`,
    '',
    `A worker you delegated to has finished planning and is waiting for your approval before it touches any files.`,
    '',
    `Summary: ${input.summary}`,
    '',
    'Plan:',
    input.planContent || '(no plan content provided)',
    '',
    `Review it against what you asked for, then call decide_worker_plan with worktreeId "${input.worktreeId}" and decision "approve" or "request_changes". If you request changes, say specifically what to change — the worker will revise and ask again.`,
  ].join('\n');

  try {
    await notifyProjectLead(input.userId, input.projectId, prompt);
  } catch (err) {
    cancelLeadPlanReview(input.worktreeId, 'Could not reach the Project Lead');
    console.error('[delegation] failed to reach project lead for plan review:', err);
    return null;
  }

  return decision;
}

/** Answer a pending plan review. Returns false when nothing was waiting. */
export function resolveLeadPlanReview(
  worktreeId: string,
  approved: boolean,
  note: string,
): boolean {
  const pending = pendingPlanReviews.get(worktreeId);
  if (!pending) return false;
  pendingPlanReviews.delete(worktreeId);
  clearTimeout(pending.timer);
  markWorktreeDelegation(worktreeId, {
    status: approved ? 'working' : 'planning',
    note,
    unread: false,
  });
  pending.resolve({ approved, note });
  return true;
}

/** Abandon a pending review without a decision (supersede, shutdown, failure). */
export function cancelLeadPlanReview(worktreeId: string, reason: string): void {
  const pending = pendingPlanReviews.get(worktreeId);
  if (!pending) return;
  pendingPlanReviews.delete(worktreeId);
  clearTimeout(pending.timer);
  pending.resolve({ approved: false, note: reason });
}

export function hasPendingPlanReview(worktreeId: string): boolean {
  return pendingPlanReviews.has(worktreeId);
}

/** Stable id helper so audit rows and notices can be correlated in logs. */
export function delegationEventId(): string {
  return randomUUID();
}
