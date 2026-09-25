import { defineTool } from '@github/copilot-sdk';
import { createWorktree, listWorktrees } from './project-store';
import { getDigest, listDigests } from './digest-store';
import { getDb } from './db';
import { executeApprovedMerge, getMergeRequest, resolveMergeRequest } from './merge-store';
import { getOrBootstrapProjectMemory, refreshProjectMemory } from './project-memory-store';
import { recordCosBriefing } from './cos-briefing-store';
import {
  countActiveDelegations,
  countActiveReviews,
  createDelegation,
  getDelegationForWorktree,
  hasWorkingBuilderDelegation,
  listDelegations,
  markWorktreeDelegation,
  shortTitle,
  updateDelegation,
} from './delegation-store';
import { hasPendingPlanReview, resolveLeadPlanReview } from './delegation-runtime';
import {
  GitHubCliError,
  createBoardIssue,
  createPullRequest,
  getBoard,
  getDefaultProjectLink,
  getIssueDetail,
  listIssues,
  listMilestones,
  listPullRequests,
  moveBoardItem,
  updateIssue,
} from './github-store';
import {
  createTodo,
  deleteTodo,
  getTodo,
  listTodos,
  renderTodoOutline,
  updateTodo,
} from './todo-store';

/** Ceiling on workers one project may have in flight at once. */
export const MAX_ACTIVE_DELEGATIONS = 3;

/**
 * Ceiling on spin_off_review reviewers in flight at once, counted separately
 * from builders so a review can always start even when builders are maxed out.
 */
export const MAX_ACTIVE_REVIEWS = 2;

const BRIEFING_MAX_CHARS = 280;

/** Collapse whitespace and hard-cap length so audit rows and CoS briefings stay scannable. */
export function condenseBriefing(summary: string, maxChars = BRIEFING_MAX_CHARS): string {
  const flat = summary.replace(/\s+/g, ' ').trim();
  if (flat.length <= maxChars) return flat;
  const clipped = flat.slice(0, maxChars);
  const lastBreak = Math.max(clipped.lastIndexOf('. '), clipped.lastIndexOf(' '));
  return `${(lastBreak > maxChars * 0.6 ? clipped.slice(0, lastBreak) : clipped).replace(/[.,;:\s]+$/, '')}…`;
}

function audit(
  projectId: string,
  action: string,
  reasoning: string,
  riskLevel: 'low' | 'medium' | 'high' = 'low',
  subjectId?: string,
) {
  getDb().prepare(`
    INSERT INTO project_audit_log (id, project_id, actor, action, reasoning, risk_level, subject_id)
    VALUES (?, ?, 'project_lead', ?, ?, ?, ?)
  `).run(crypto.randomUUID(), projectId, action, reasoning, riskLevel, subjectId ?? null);
}

/** Worktree/branch-safe name derived from a delegation title. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

function interventionMode(projectId: string): 'flag_only' | 'flag_nudge' | 'flag_nudge_cancel' {  const row = getDb().prepare(
    'SELECT intervention_mode FROM project_autonomy_settings WHERE project_id = ?',
  ).get(projectId) as { intervention_mode?: string } | undefined;
  if (row?.intervention_mode === 'flag_nudge_cancel') return 'flag_nudge_cancel';
  if (row?.intervention_mode === 'flag_nudge') return 'flag_nudge';
  return 'flag_only';
}

function skillInstallMode(projectId: string): 'suggest_only' | 'approve_and_install' {
  const row = getDb().prepare(
    'SELECT skill_install_mode FROM project_autonomy_settings WHERE project_id = ?',
  ).get(projectId) as { skill_install_mode?: string } | undefined;
  return row?.skill_install_mode === 'approve_and_install' ? 'approve_and_install' : 'suggest_only';
}

function githubTaskMode(projectId: string): 'off' | 'read_only' | 'manage' {
  let mode: string | undefined;
  try {
    const row = getDb().prepare(
      'SELECT github_task_mode FROM project_autonomy_settings WHERE project_id = ?',
    ).get(projectId) as { github_task_mode?: string } | undefined;
    mode = row?.github_task_mode;
  } catch {
    // Older databases/harnesses without the column (or table) default to off.
    return 'off';
  }
  if (mode === 'manage') return 'manage';
  if (mode === 'read_only') return 'read_only';
  return 'off';
}

export function reviewPlanForWorker(
  projectId: string,
  worktreeId: string,
  plan: string,
  scope: 'small' | 'medium' | 'large',
) {
  const digest = getDigest(worktreeId, projectId);
  const mode = getDb().prepare(
    'SELECT merge_mode FROM project_autonomy_settings WHERE project_id = ?',
  ).get(projectId) as { merge_mode?: string } | undefined;
  const conflicts = listDigests(projectId)
    .filter((item) => item.worktreeId !== worktreeId && item.status === 'in_progress')
    .some((item) => item.touchedFiles.some((file) => digest?.touchedFiles.includes(file)));

  let action: 'approve' | 'approve-with-note' | 'request-changes' | 'escalate-to-user';
  let reason: string;
  if (digest?.status === 'blocked') {
    action = 'request-changes';
    reason = 'The worktree is already blocked; revise the plan to address the blocker before proceeding.';
  } else if (conflicts) {
    action = 'escalate-to-user';
    reason = 'The plan overlaps files currently being changed by another worktree.';
  } else if (scope === 'small') {
    action = 'approve';
    reason = 'Small-scope work can proceed without additional user ceremony.';
  } else if (scope === 'medium' && mode?.merge_mode === 'full_auto') {
    action = 'approve-with-note';
    reason = 'Medium-scope work is approved under the project autonomy policy; keep the plan within the declared scope.';
  } else {
    action = 'escalate-to-user';
    reason = 'Non-trivial work requires explicit user confirmation in the current project policy.';
  }
  audit(projectId, 'review_plan', `${action}: ${reason}\n${plan}`, scope === 'large' ? 'high' : 'medium');
  return { action, reason };
}

/**
 * Get a usable session handle for a worker, resuming it when it is not live in
 * this process.
 *
 * A worker's runtime session is released on a server restart, and deliberately
 * released once its delegation is closed out, but the conversation itself
 * survives. Treating "not in memory" as "gone" left the lead unable to talk to
 * a worker that was perfectly resumable.
 */
async function findOrResumeWorker(projectId: string, worktreeId: string, userId?: string) {
  const { findLiveWorktreeAgent, resumeAgentSession } = await import('./agent-bridge');
  const live = findLiveWorktreeAgent(projectId, worktreeId);
  if (live) return live;

  const delegation = getDelegationForWorktree(worktreeId);
  if (!delegation?.sessionId || !userId) return undefined;
  try {
    return await resumeAgentSession(userId, delegation.sessionId);
  } catch (err) {
    console.error(`[project-lead-tools] Could not resume worker ${delegation.sessionId}:`, err);
    return undefined;
  }
}

/**
 * The model a delegated worker should run on: whatever the lead itself is
 * using.
 *
 * Workers were created with no model at all, so they silently fell back to
 * `auto` however carefully the user had picked a model for the lead — the lead
 * would reason on one model and its workers, which do the actual work, on
 * another. Resolved at delegation time; changing the lead's model afterwards
 * does not reach into workers that are already running.
 */
async function leadModel(getSessionId?: () => string | undefined): Promise<string | undefined> {
  const sessionId = getSessionId?.();
  if (!sessionId) return undefined;
  const { getAgentSession } = await import('./agent-bridge');
  return getAgentSession(sessionId)?.model;
}

export function createProjectLeadTools(  projectId: string,
  userId?: string,
  getSessionId?: () => string | undefined,
) {
  const ghMode = githubTaskMode(projectId);
  const tools = [
    defineTool('get_project_memory', {
      description: 'Read (and bootstrap if missing) this Project Lead\'s persistent understanding of the project: README, recent commits, worktrees, digests, and open decisions. Call this at the start of a new conversation to get up to speed.',
      parameters: { type: 'object', properties: {} },
      handler: () => getOrBootstrapProjectMemory(projectId),
      skipPermission: true,
      defer: 'never',
    }),
    defineTool('refresh_project_memory', {
      description: 'Re-synthesize this project\'s memory from the current repository and project state, overwriting the prior bootstrap. Use when the project has changed significantly since the last bootstrap.',
      parameters: { type: 'object', properties: {} },
      handler: () => refreshProjectMemory(projectId),
      skipPermission: true,
      defer: 'never',
    }),
    defineTool('brief_chief_of_staff', {
      description: 'Send a one-or-two sentence briefing to the Chief of Staff summarizing what was decided in this conversation, so the CoS stays aware without reading the full transcript. Call this after reaching a decision, completing a review, or before ending a significant conversation. Keep it headline-style: what changed and what it unblocks. Longer summaries are truncated.',
      parameters: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: `Headline-style summary, 1-2 sentences, at most ${BRIEFING_MAX_CHARS} characters. No preamble, bullet lists, or transcript detail.`,
            maxLength: BRIEFING_MAX_CHARS,
          },
        },
        required: ['summary'],
      },
      handler: ({ summary }: { summary: string }) => {
        const condensed = condenseBriefing(summary);
        const briefing = recordCosBriefing(projectId, condensed);
        audit(projectId, 'brief_chief_of_staff', condensed, 'low');
        return briefing;
      },
      skipPermission: true,
      defer: 'never',
    }),
    defineTool('list_worktrees', {
      description: 'List all worktrees belonging to this project.',
      parameters: { type: 'object', properties: {} },
      handler: () => listWorktrees(projectId),
      skipPermission: true,
      defer: 'never',
    }),
    defineTool('get_digest', {
      description: 'Read the current structured digest for one project worktree.',
      parameters: {
        type: 'object',
        properties: { worktreeId: { type: 'string' } },
        required: ['worktreeId'],
      },
      handler: ({ worktreeId }: { worktreeId: string }) => getDigest(worktreeId, projectId),
      skipPermission: true,
      defer: 'never',
    }),
    defineTool('list_digests', {
      description: 'List all current worktree digests for this project.',
      parameters: { type: 'object', properties: {} },
      handler: () => listDigests(projectId),
      skipPermission: true,
      defer: 'never',
    }),
    defineTool('detect_conflicts', {
      description: 'Find overlapping touched files across active worktrees. This returns candidates, not a merge verdict.',
      parameters: { type: 'object', properties: {} },
      handler: () => {
        const digests = listDigests(projectId).filter((digest) => digest.status === 'in_progress' || digest.status === 'ready_to_merge');
        const byFile = new Map<string, string[]>();
        for (const digest of digests) {
          for (const file of digest.touchedFiles) {
            const worktrees = byFile.get(file) ?? [];
            if (!worktrees.includes(digest.worktreeId)) worktrees.push(digest.worktreeId);
            byFile.set(file, worktrees);
          }
        }
        const conflicts = [...byFile.entries()]
          .filter(([, worktrees]) => worktrees.length > 1)
          .map(([file, worktrees]) => ({ file, worktrees }));
        return { conflicts, checkedWorktrees: digests.map((digest) => digest.worktreeId) };
      },
      skipPermission: true,
      defer: 'never',
    }),
    defineTool('review_plan', {
      description: 'Review a worker plan against its declared scope and return a routing decision.',
      parameters: {
        type: 'object',
        properties: {
          worktreeId: { type: 'string' },
          plan: { type: 'string' },
          scope: { type: 'string', enum: ['small', 'medium', 'large'] },
        },
        required: ['worktreeId', 'plan', 'scope'],
      },
      handler: ({ worktreeId, plan, scope }: { worktreeId: string; plan: string; scope: 'small' | 'medium' | 'large' }) => {
        getDigest(worktreeId, projectId);
        const action = scope === 'small' ? 'approve' : 'escalate-to-user';
        audit(projectId, 'review_plan', `${action}: ${plan}`, scope === 'large' ? 'high' : 'medium');
        return {
          action,
          reason: scope === 'small'
            ? 'Small-scope work can proceed without an additional plan gate.'
            : 'Non-trivial work requires explicit user confirmation in the current release.',
        };
      },
      skipPermission: true,
      defer: 'never',
    }),
    defineTool('record_requirements', {
      description: 'Record confirmed requirements for a non-trivial work item as a resumable project decision artifact.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          desiredOutcome: { type: 'string' },
          constraints: { type: 'string' },
          acceptanceCriteria: { type: 'string' },
          dependencies: { type: 'string' },
          openQuestions: { type: 'string' },
        },
        required: ['title', 'desiredOutcome', 'acceptanceCriteria'],
      },
      handler: ({
        title,
        desiredOutcome,
        constraints,
        acceptanceCriteria,
        dependencies,
        openQuestions,
      }: {
        title: string;
        desiredOutcome: string;
        constraints?: string;
        acceptanceCriteria: string;
        dependencies?: string;
        openQuestions?: string;
      }) => {
        const id = crypto.randomUUID();
        const question = [
          `Desired outcome: ${desiredOutcome}`,
          `Constraints: ${constraints || 'None recorded'}`,
          `Acceptance criteria: ${acceptanceCriteria}`,
          `Dependencies: ${dependencies || 'None recorded'}`,
          `Open questions: ${openQuestions || 'None recorded'}`,
        ].join('\n');
        const status = openQuestions ? 'open' : 'confirmed';
        getDb().prepare(`
          INSERT INTO decision_threads (id, project_id, title, question, status, session_id)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(id, projectId, title, question, status, getSessionId?.() ?? null);
        audit(projectId, 'record_requirements', title, openQuestions ? 'medium' : 'low', id);
        return { id, title, status };
      },
      skipPermission: true,
      defer: 'never',
    }),
    defineTool('list_decision_threads', {
      description:
        'List this project\'s decision threads with their ids, so a specific one can be resolved. Defaults to open threads.',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            description: "Filter by status: 'open', 'confirmed', 'resolved', or 'all'. Defaults to 'open'.",
          },
        },
      },
      handler: async ({ status }: { status?: string }) => {
        const requested = status ?? 'open';
        const wanted = requested === 'all' ? null : requested;
        const rows = getDb().prepare(`
          SELECT id, title, question, status, decision, rationale, follow_up_actions AS followUpActions, updated_at AS updatedAt
          FROM decision_threads
          WHERE project_id = ? AND (? IS NULL OR status = ?)
          ORDER BY updated_at DESC
          LIMIT 50
        `).all(projectId, wanted, wanted);
        return { threads: rows, count: rows.length };
      },
      skipPermission: true,
      defer: 'never',
    }),
    defineTool('resolve_decision_thread', {
      description:
        'Close a decision thread with the verdict that was reached. Use list_decision_threads first to get the id.',
      parameters: {
        type: 'object',
        properties: {
          threadId: { type: 'string', description: 'Id of the thread to close.' },
          decision: { type: 'string', description: 'The verdict that was reached.' },
          rationale: { type: 'string', description: 'Why this decision was made.' },
          alternativesConsidered: { type: 'string', description: 'Options that were weighed and set aside.' },
          followUpActions: { type: 'string', description: 'Work this decision creates.' },
          status: {
            type: 'string',
            description: "Resulting status: 'resolved' (default) or 'confirmed' when the user signed off.",
          },
        },
        required: ['threadId', 'decision'],
      },
      handler: async ({
        threadId,
        decision,
        rationale,
        alternativesConsidered,
        followUpActions,
        status,
      }: {
        threadId: string;
        decision: string;
        rationale?: string;
        alternativesConsidered?: string;
        followUpActions?: string;
        status?: string;
      }) => {
        const thread = getDb().prepare(
          'SELECT id, title, status FROM decision_threads WHERE id = ? AND project_id = ?',
        ).get(threadId, projectId) as { id: string; title: string | null; status: string } | undefined;
        if (!thread) throw new Error('Decision thread does not belong to this project');

        const nextStatus = status === 'confirmed' ? 'confirmed' : 'resolved';
        getDb().prepare(`
          UPDATE decision_threads SET
            status = ?,
            decision = ?,
            rationale = COALESCE(?, rationale),
            alternatives_considered = COALESCE(?, alternatives_considered),
            follow_up_actions = COALESCE(?, follow_up_actions),
            updated_at = datetime('now')
          WHERE id = ? AND project_id = ?
        `).run(
          nextStatus,
          decision,
          rationale ?? null,
          alternativesConsidered ?? null,
          followUpActions ?? null,
          threadId,
          projectId,
        );
        audit(
          projectId,
          'resolve_decision_thread',
          condenseBriefing(`${thread.title || 'Decision'} → ${decision}`),
          'medium',
          threadId,
        );
        // The summary lists open threads, so it is stale the moment one closes.
        refreshProjectMemory(projectId);
        return { id: threadId, status: nextStatus, decision };
      },
      skipPermission: true,
      defer: 'never',
    }),
    defineTool('approve_merge', {
      description: 'Approve a merge request after project-level review.',
      parameters: {
        type: 'object',
        properties: { requestId: { type: 'string' }, note: { type: 'string' } },
        required: ['requestId'],
      },
      handler: async ({ requestId, note }: { requestId: string; note?: string }) => {
        const request = getMergeRequest(requestId);
        if (!request || request.projectId !== projectId) throw new Error('Merge request does not belong to this project');
        resolveMergeRequest(requestId, 'approved', note);
        audit(projectId, 'approve_merge', note ?? 'Approved merge request');
        const result = await executeApprovedMerge(requestId);
        // The work is submitted, so the worker has nothing left to do. Release
        // its runtime session; nudge_worker resumes the conversation if the
        // lead needs follow-up changes. Cleanup must never fail the merge.
        try {
          const { endWorktreeAgentSessions } = await import('./agent-bridge');
          await endWorktreeAgentSessions(projectId, request.worktreeId);
        } catch (err) {
          console.error(`[project-lead-tools] Could not release worker session for ${request.worktreeId}:`, err);
        }
        return result;
      },
      skipPermission: true,
      defer: 'never',
    }),
    defineTool('reject_merge', {
      description: 'Reject a merge request with a reason recorded in the project audit trail.',
      parameters: {
        type: 'object',
        properties: { requestId: { type: 'string' }, reason: { type: 'string' } },
        required: ['requestId', 'reason'],
      },
      handler: ({ requestId, reason }: { requestId: string; reason: string }) => {
        const request = getMergeRequest(requestId);
        if (!request || request.projectId !== projectId) throw new Error('Merge request does not belong to this project');
        const result = resolveMergeRequest(requestId, 'rejected', reason);
        audit(projectId, 'reject_merge', reason, 'medium');
        return result;
      },
      skipPermission: true,
      defer: 'never',
    }),
    defineTool('delegate_to_worker', {
      description:
        'Start a background worker on a task. Creates (or reuses) a worktree, opens a Copilot session in it, and hands it the task. The worker plans first and must get your approval via decide_worker_plan before it changes any files. This returns immediately — do not wait for the worker, end your turn and check back later.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'What the worker should accomplish, with the context and acceptance criteria it needs.' },
          title: { type: 'string', description: 'Short label for this work (a few words), used as the tab and sidebar name.' },
          worktreeId: { type: 'string', description: 'Reuse this existing worktree. Omit to create a new one.' },
          branch: { type: 'string', description: 'Branch for a new worktree. Defaults to a name derived from the title.' },
        },
        required: ['task', 'title'],
      },
      handler: async ({ task, title, worktreeId, branch }: {
        task: string; title: string; worktreeId?: string; branch?: string;
      }) => {
        if (!userId) throw new Error('This Project Lead session cannot start workers (no owning user).');

        const active = countActiveDelegations(projectId);
        if (active >= MAX_ACTIVE_DELEGATIONS) {
          throw new Error(
            `This project already has ${active} workers in flight (limit ${MAX_ACTIVE_DELEGATIONS}). Wait for one to finish, or cancel it, before delegating more.`,
          );
        }

        const label = shortTitle(title);
        let targetWorktreeId = worktreeId;
        if (targetWorktreeId) {
          const existing = listWorktrees(projectId).find((w) => w.id === targetWorktreeId);
          if (!existing) throw new Error('Worktree does not belong to this project');
          if (getDelegationForWorktree(targetWorktreeId)?.status === 'working') {
            throw new Error('That worktree already has a worker running. Pick another, or let it finish.');
          }
        } else {
          const slug = slugify(label) || `task-${Date.now()}`;
          const created = createWorktree(projectId, slug, branch?.trim() || `lead/${slug}`, true, {
            seedPrompt: task,
          });
          targetWorktreeId = created.id;
        }

        const { createAgentSession, sendToSession } = await import('./agent-bridge');
        // Plan mode: the worker drafts a plan and cannot touch files until the
        // lead approves it through decide_worker_plan. It is also unattended —
        // no client is subscribed to answer permission prompts, so it must not
        // be asked any, or it would block forever on the first one.
        const model = await leadModel(getSessionId);
        const session = await createAgentSession(
          userId,
          projectId,
          targetWorktreeId,
          model,
          'agent',
          'plan',
          { unattended: true },
        );
        const delegation = createDelegation({
          projectId,
          worktreeId: targetWorktreeId,
          title: label,
          task,
          sessionId: session.sessionId,
        });

        await sendToSession(session, [
          `You are a background worker for this project. The Project Lead has assigned you this task:`,
          '',
          task,
          '',
          'Work in this worktree only. Before changing any files, produce a short plan and submit it for review — the Project Lead approves or requests changes, and you revise until it is approved.',
          'Publish progress with update_digest as you go, and use ask_project_lead if you hit a blocker or an ambiguous requirement instead of guessing.',
        ].join('\n'));

        audit(projectId, 'delegate_to_worker', `${label}: ${task}`, 'high');
        return {
          ok: true,
          delegationId: delegation.id,
          worktreeId: targetWorktreeId,
          sessionId: session.sessionId,
          title: label,
          model: session.model,
          note: 'Worker started and planning. End your turn; it will come back to you for plan review.',
        };
      },
      skipPermission: true,
      defer: 'never',
    }),
    defineTool('spin_off_review', {
      description:
        'Hand a review off to a review sub-agent instead of doing it inline. Spawns an unattended review persona in an EXISTING worktree, seeded with your focus brief (and optional context), that may read the diff and run tests but never commits or modifies files. It works async and reports a pass / changes-needed verdict back to you, which you then own. This returns immediately — do not wait for it, end your turn and act on the verdict when it arrives.',
      parameters: {
        type: 'object',
        properties: {
          worktreeId: { type: 'string', description: 'The existing worktree whose diff/changes to review (typically a worker\'s worktree).' },
          focus: { type: 'string', description: 'Your distilled brief: what the change should do, the specific risks/areas to check, and the acceptance criteria. This is the primary context the reviewer carries.' },
          transcriptSnapshot: { type: 'string', description: 'Optional extra context to hand over (e.g. a condensed slice of your own reasoning). Appended verbatim to the seed.' },
          deepMerge: { type: 'boolean', description: 'When true, the reviewer\'s condensed reasoning is folded back to you on finish so you can answer follow-ups as if you reviewed. Defaults to false (verdict only).' },
        },
        required: ['worktreeId', 'focus'],
      },
      handler: async ({ worktreeId, focus, transcriptSnapshot, deepMerge }: {
        worktreeId: string; focus: string; transcriptSnapshot?: string; deepMerge?: boolean;
      }) => {
        if (!userId) throw new Error('This Project Lead session cannot start reviews (no owning user).');

        const activeReviews = countActiveReviews(projectId);
        if (activeReviews >= MAX_ACTIVE_REVIEWS) {
          throw new Error(
            `This project already has ${activeReviews} reviews in flight (limit ${MAX_ACTIVE_REVIEWS}). Wait for one to finish before spinning off another.`,
          );
        }

        const existing = listWorktrees(projectId).find((w) => w.id === worktreeId);
        if (!existing) throw new Error('Worktree does not belong to this project');

        // A reviewer runs the test suite; if a builder is still changing files in
        // this worktree the results would be meaningless. Make the lead wait for
        // the worker to finish. Scoped to builders so a review never blocks another.
        if (hasWorkingBuilderDelegation(worktreeId)) {
          throw new Error(
            'That worktree still has a worker running. Wait for it to finish (or cancel it) before spinning off a review, so tests do not run while files change underneath the reviewer.',
          );
        }

        const label = shortTitle(`Review: ${existing.name ?? worktreeId}`);

        const { createAgentSession, sendToSession } = await import('./agent-bridge');
        // Autopilot + unattended: the reviewer reads and runs tests immediately
        // with no plan-approval handshake (that gate is only for builders in
        // 'plan' mode), and no permission prompts, since nobody is subscribed to
        // answer them. isReview strips its merge tools so it cannot initiate a
        // merge; the seed forbids any write/commit as defense in depth.
        const model = await leadModel(getSessionId);
        const session = await createAgentSession(
          userId,
          projectId,
          worktreeId,
          model,
          'agent',
          'autopilot',
          { unattended: true, isReview: true },
        );
        const delegation = createDelegation({
          projectId,
          worktreeId,
          title: label,
          task: focus,
          sessionId: session.sessionId,
          isReview: true,
          deepMerge: deepMerge === true,
        });

        // Note: the reviewer writes its verdict to this worktree's digest via
        // update_digest, which overwrites the worker's own summary. That is an
        // accepted tradeoff — post-review the verdict is the useful digest, and
        // the worker's summary remains in its notify message and session tab.
        // Making the digest additive would need a merge of two authors' fields;
        // left for a follow-up if the dashboard ever needs both side by side.
        await sendToSession(session, [
          'You are the Project Lead\'s REVIEW PERSONA. You are reviewing the changes in THIS worktree, and your findings will be attributed to the Project Lead as if the Lead reviewed them itself.',
          '',
          'Focus brief (what to check, the risks, and the acceptance criteria):',
          focus,
          ...(transcriptSnapshot && transcriptSnapshot.trim()
            ? ['', 'Additional context from the Lead:', transcriptSnapshot]
            : []),
          '',
          'You MAY read the diff (e.g. `git --no-pager diff` against the base branch) and RUN THE TESTS to validate. You MUST NEVER commit, push, request a merge, or modify any tracked file — you are report-only. Running the test suite is allowed; changing the branch is not.',
          '',
          'When you are done, produce a VERDICT of exactly `pass` or `changes-needed`, with concrete findings backed by evidence (file:line references, failing test names/output). Publish it with update_digest: set status to `ready_to_merge` for a pass or `blocked` for changes-needed, put the verdict and headline finding in `headline`, and the full findings in `detail`. Write in FIRST-PERSON Lead voice (e.g. "I reviewed the auth changes; the token refresh has a race — src/auth.ts:88"), because it will be attributed to the Lead. Your update_digest report IS the report that goes back to the Lead.',
          '',
          'Be concise and self-terminate after reporting the verdict — do no open-ended work.',
        ].join('\n'));

        audit(projectId, 'spin_off_review', `${label}: ${condenseBriefing(focus)}`, 'medium', worktreeId);
        return {
          ok: true,
          reviewId: delegation.id,
          worktreeId,
          sessionId: session.sessionId,
          title: label,
          model: session.model,
          note: 'Review started unattended. End your turn; it will report a verdict back to you.',
        };
      },
      skipPermission: true,
      defer: 'never',
    }),
    defineTool('decide_worker_plan', {
      description:
        'Approve or request changes on a plan a worker submitted for review. The worker is blocked until you answer.',
      parameters: {
        type: 'object',
        properties: {
          worktreeId: { type: 'string' },
          decision: { type: 'string', enum: ['approve', 'request_changes'] },
          note: { type: 'string', description: 'For request_changes, say specifically what to change.' },
        },
        required: ['worktreeId', 'decision'],
      },
      handler: ({ worktreeId, decision, note }: { worktreeId: string; decision: 'approve' | 'request_changes'; note?: string }) => {
        if (!hasPendingPlanReview(worktreeId)) {
          throw new Error('No plan is awaiting review for that worktree.');
        }
        const approved = decision === 'approve';
        if (!approved && !note?.trim()) {
          throw new Error('Requesting changes requires a note saying what to change.');
        }
        resolveLeadPlanReview(worktreeId, approved, note?.trim() || 'Approved by Project Lead');
        audit(projectId, 'decide_worker_plan', `${decision}: ${note ?? ''}`, approved ? 'medium' : 'low');
        return { ok: true, decision };
      },
      skipPermission: true,
      defer: 'never',
    }),
    defineTool('list_delegations', {
      description: 'List the workers you have started for this project and their current state.',
      parameters: { type: 'object', properties: {} },
      handler: () => listDelegations(projectId).map((d) => ({
        worktreeId: d.worktreeId,
        title: d.title,
        status: d.status,
        note: d.note,
        updatedAt: d.updatedAt,
      })),
      skipPermission: true,
      defer: 'never',
    }),
    defineTool('nudge_worker', {
      description: 'Send a guidance message — or the answer to a worker question — to a live worktree agent. Always allowed for workers you started yourself; for workers the user started it requires flag_nudge or flag_nudge_cancel intervention mode.',
      parameters: {
        type: 'object',
        properties: { worktreeId: { type: 'string' }, message: { type: 'string' } },
        required: ['worktreeId', 'message'],
      },
      handler: async ({ worktreeId, message }: { worktreeId: string; message: string }) => {
        // Answering a worker you started is part of the delegation loop, not an
        // intervention in the user's own session, so autonomy settings only
        // gate the latter.
        const isOwnWorker = Boolean(getDelegationForWorktree(worktreeId));
        if (!isOwnWorker && interventionMode(projectId) === 'flag_only') {
          throw new Error('Worker nudges are disabled by project autonomy settings');
        }
        const session = await findOrResumeWorker(projectId, worktreeId, userId);
        if (!session) throw new Error('No live worktree agent session found');
        const { sendAgentMessage } = await import('./agent-bridge');
        await sendAgentMessage(session.sessionId, message);
        if (isOwnWorker) markWorktreeDelegation(worktreeId, { status: 'working', unread: false });
        audit(projectId, 'nudge_worker', message, 'medium');
        return { ok: true, sessionId: session.sessionId };
      },
      skipPermission: true,
      defer: 'never',
    }),
    defineTool('cancel_worker', {
      description: 'Stop a live worktree agent. Always allowed for workers you started yourself; otherwise requires flag_nudge_cancel intervention mode.',
      parameters: {
        type: 'object',
        properties: { worktreeId: { type: 'string' }, reason: { type: 'string' } },
        required: ['worktreeId', 'reason'],
      },
      handler: async ({ worktreeId, reason }: { worktreeId: string; reason: string }) => {
        const own = getDelegationForWorktree(worktreeId);
        if (!own && interventionMode(projectId) !== 'flag_nudge_cancel') {
          throw new Error('Worker cancellation is disabled by project autonomy settings');
        }
        const { cancelAgent, endAgentSession, findLiveWorktreeAgent } = await import('./agent-bridge');
        const session = findLiveWorktreeAgent(projectId, worktreeId);
        if (own) updateDelegation(own.id, { status: 'cancelled', note: reason, unread: false });
        audit(projectId, 'cancel_worker', reason, 'high');
        const redelegate = `You can start fresh work in this worktree with delegate_to_worker using worktreeId "${worktreeId}".`;
        if (!session) {
          // A worker whose session already ended is in exactly the state
          // cancelling is meant to produce. Reporting that as a failure left
          // the lead unable to close out a dead worker and move on.
          if (!own) throw new Error('No live worktree agent session found');
          return {
            ok: true,
            sessionId: null,
            note: `That worker had already stopped, so there was nothing to interrupt. The delegation is closed. ${redelegate}`,
          };
        }
        // Interrupt the turn, then release the runtime session. Cancelling only
        // the turn left the session connected and idle forever; the transcript
        // is persisted and the conversation stays resumable either way.
        await cancelAgent(session.sessionId);
        await endAgentSession(session.sessionId);
        return { ok: true, sessionId: session.sessionId, note: `Worker stopped and its session closed. ${redelegate}` };
      },
      skipPermission: true,
      defer: 'never',
    }),
    defineTool('list_closable_worktrees', {
      description:
        'Check which worktrees can be cleaned up. Reports, for every worktree in the project, ' +
        'whether its work has already been merged and what (if anything) still blocks removal. ' +
        'Use this before close_worktree to find finished work that is still holding a tab open.',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        const { assessWorktreeCleanup } = await import('./worktree-cleanup');
        const results = [];
        for (const worktree of listWorktrees(projectId)) {
          try {
            results.push(await assessWorktreeCleanup(projectId, worktree.id));
          } catch (error) {
            results.push({
              worktreeId: worktree.id,
              name: worktree.name,
              safe: false,
              error: (error as Error).message,
            });
          }
        }
        return { worktrees: results };
      },
      skipPermission: true,
      defer: 'never',
    }),
    defineTool('close_worktree', {
      description:
        'Remove a worktree once its work is merged: ends its agent sessions, closes its ' +
        'delegations so the tab disappears, and deletes the worktree. Refuses when the ' +
        'worktree has uncommitted changes, unmerged commits, a merge in flight, or a worker ' +
        'mid-turn — ask the user to clean those up rather than trying to work around them.',
      parameters: {
        type: 'object',
        properties: {
          worktreeId: { type: 'string' },
          reason: { type: 'string', description: 'Why this worktree is finished with.' },
        },
        required: ['worktreeId', 'reason'],
      },
      handler: async ({ worktreeId, reason }: { worktreeId: string; reason: string }) => {
        const { closeWorktree } = await import('./worktree-cleanup');
        // Never forced: the lead has no way to see what uncommitted work would
        // be destroyed, so an unsafe close is always the user's call.
        const result = await closeWorktree(projectId, worktreeId);
        audit(projectId, 'close_worktree', reason, 'medium', worktreeId);
        return {
          ok: true,
          worktree: result.name,
          branch: result.branch,
          closedSessions: result.closedSessions.length,
          closedDelegations: result.closedDelegations,
          mergeEvidence: result.assessment.mergeEvidence,
          note: `Worktree ${result.name} removed; its sessions and delegations are closed.`,
        };
      },
      skipPermission: true,
      defer: 'never',
    }),
    // The lead's own working list. It is the same list the user edits on the
    // project page, so it is a shared plan rather than scratch memory the user
    // cannot see — which is the point of storing it instead of keeping it in
    // the conversation, where compaction eventually loses it.
    defineTool('list_todos', {
      description:
        "Read this project's todo list: the shared plan shown on the project page and in the " +
        'Project Lead detail panel. Each line carries the id the other todo tools take. ' +
        'Check this before planning work so you build on the list instead of duplicating it.',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        const todos = listTodos(projectId);
        return {
          outline: renderTodoOutline(projectId),
          total: todos.length,
          remaining: todos.filter((t) => !t.done).length,
        };
      },
      skipPermission: true,
      defer: 'never',
    }),
    defineTool('add_todos', {
      description:
        'Add items to the project todo list. Pass several at once when breaking work down. ' +
        'Give parentId (a todo id from list_todos) to nest an item under another. ' +
        'The user sees these immediately, so write them as work to be done, not as notes.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: 'The todos to add, in the order they should appear.',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                parentId: {
                  type: 'string',
                  description: 'Optional id of the todo to nest this one under.',
                },
              },
              required: ['text'],
            },
          },
        },
        required: ['items'],
      },
      handler: async ({ items }: { items: Array<{ text: string; parentId?: string }> }) => {
        if (!Array.isArray(items) || items.length === 0) {
          throw new Error('Pass at least one todo to add.');
        }
        // Added one at a time so a bad parentId reports which item failed
        // rather than rolling back the whole batch silently.
        const added = items.map((item, index) => {
          try {
            const todo = createTodo({ projectId, text: item.text, parentId: item.parentId ?? null });
            return { id: todo.id, text: todo.text };
          } catch (error) {
            throw new Error(`Item ${index + 1} ("${item.text}") was rejected: ${(error as Error).message}`);
          }
        });
        return { ok: true, added, outline: renderTodoOutline(projectId) };
      },
      skipPermission: true,
      defer: 'never',
    }),
    defineTool('update_todo', {
      description:
        'Change one todo: tick it off with done, reword it with text, or renest it with ' +
        'parentId (null moves it to the top level). Tick items off as work actually lands, ' +
        'so the list the user reads matches the state of the project.',
      parameters: {
        type: 'object',
        properties: {
          todoId: { type: 'string' },
          text: { type: 'string' },
          done: { type: 'boolean' },
          parentId: {
            type: ['string', 'null'],
            description: 'New parent todo id, or null for the top level.',
          },
        },
        required: ['todoId'],
      },
      handler: async ({
        todoId,
        ...patch
      }: {
        todoId: string;
        text?: string;
        done?: boolean;
        parentId?: string | null;
      }) => {
        const todo = updateTodo(projectId, todoId, patch);
        if (!todo) throw new Error(`No todo ${todoId} in this project`);
        return { ok: true, todo: { id: todo.id, text: todo.text, done: !!todo.done } };
      },
      skipPermission: true,
      defer: 'never',
    }),
    defineTool('delete_todo', {
      description:
        'Remove a todo and everything nested under it. Only for items that should never be ' +
        'done — tick off finished work with update_todo instead, so the user keeps the record.',
      parameters: {
        type: 'object',
        properties: { todoId: { type: 'string' } },
        required: ['todoId'],
      },
      handler: async ({ todoId }: { todoId: string }) => {
        const todo = getTodo(projectId, todoId);
        if (!todo) throw new Error(`No todo ${todoId} in this project`);
        const removed = listTodos(projectId).filter((t) => t.parentId === todoId).length;
        deleteTodo(projectId, todoId);
        return {
          ok: true,
          deleted: todo.text,
          alsoDeletedSubItems: removed,
          outline: renderTodoOutline(projectId),
        };
      },
      skipPermission: true,
      defer: 'never',
    }),
    defineTool('start_server', {
      description:
        'Start a server (dev server, API server, etc.) with live console output streamed to a dedicated tab. ' +
        'The server persists independently; if this session restarts, the server keeps running. ' +
        'User can stop/restart via the tab or you can call stop_server.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Shell command to run (e.g., "npm run dev", "python app.py", "cargo run")',
          },
          name: {
            type: 'string',
            description: 'Display name for the tab (e.g., "Dev Server", "API Server")',
          },
          cwd: {
            type: 'string',
            description: 'Working directory for the command. Defaults to project root if not specified.',
          },
          env: {
            type: 'object',
            description: 'Additional environment variables to set (e.g., {"PORT": "3001", "DEBUG": "true"})',
            additionalProperties: { type: 'string' },
          },
        },
        required: ['command', 'name'],
      },
      handler: async ({
        command,
        name,
        cwd,
        env,
      }: {
        command: string;
        name: string;
        cwd?: string;
        env?: Record<string, string>;
      }) => {
        const { createServer } = await import('./server-store');
        const { spawnServer } = await import('./server-runtime');
        if (!userId) throw new Error('This Project Lead session cannot start servers (no owning user).');

        const server = createServer({
          projectId,
          command,
          name,
          cwd,
          env,
        });

        try {
          const result = await spawnServer(userId, server);
          audit(projectId, 'start_server', `Started server: ${name} (${command})`, 'low');
          return {
            ok: true,
            serverId: result.serverId,
            name: server.name,
            status: result.status,
          };
        } catch (err) {
          audit(projectId, 'start_server', `Failed to start server: ${name} - ${err instanceof Error ? err.message : String(err)}`, 'high');
          throw err;
        }
      },
      skipPermission: false,
      defer: 'auto',
    }),
    defineTool('stop_server', {
      description: 'Stop a running server by its ID. The server tab persists but shows stopped state.',
      parameters: {
        type: 'object',
        properties: {
          serverId: {
            type: 'string',
            description: 'The server ID returned by start_server',
          },
        },
        required: ['serverId'],
      },
      handler: async ({ serverId }: { serverId: string }) => {
        const { getServerById } = await import('./server-store');
        const { stopServer: stopServerProcess } = await import('./server-runtime');

        const server = getServerById(serverId);
        if (!server) {
          throw new Error(`Server ${serverId} not found`);
        }

        stopServerProcess(serverId);
        audit(projectId, 'stop_server', `Stopped server: ${server.name}`, 'low');

        return { ok: true, serverId, status: 'stopped' };
      },
      skipPermission: false,
      defer: 'never',
    }),
    defineTool('list_servers', {
      description: 'List all servers (running or stopped) that have been started for this project.',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        const { listServersByProject } = await import('./server-store');
        const servers = listServersByProject(projectId);
        return {
          servers: servers.map((s) => ({
            id: s.id,
            name: s.name,
            command: s.command,
            status: s.status,
            startedAt: s.startedAt,
          })),
        };
      },
      skipPermission: true,
      defer: 'never',
    }),
    defineTool('open_artifact', {
      description:
        'Open an HTML artifact file in a LIVE Lavish review tab (via `lavish-axi`), embedded same-origin in a ' +
        'dedicated pilot-console tab. Returns an artifactId. The artifact renders with the Lavish SDK ' +
        '(annotations, editable Mermaid whiteboards, layout-issue inbox, human feedback). After opening, call ' +
        'poll_artifact_feedback to receive queued human feedback. Use for visual artifacts, plans, comparisons, ' +
        'diagrams, or any browser-based review surface.',
      parameters: {
        type: 'object',
        properties: {
          htmlPath: {
            type: 'string',
            description: 'Absolute path to the .html artifact file to open in Lavish.',
          },
          name: {
            type: 'string',
            description: 'Display name for the tab (e.g., "Architecture Plan", "API Comparison").',
          },
        },
        required: ['htmlPath', 'name'],
      },
      handler: async ({ htmlPath, name }: { htmlPath: string; name: string }) => {
        // Row creation and the module loads must stay inside the try: createArtifact
        // is an FK-constrained INSERT (lavish_artifacts.project_id REFERENCES projects,
        // foreign_keys = ON), so it can throw (e.g. a Lead session pinned to a
        // since-deleted project). Left unguarded it aborted with no row AND no audit,
        // so the tab silently never appeared and the failure was invisible.
        try {
          const { createArtifact } = await import('./lavish-store');
          const { spawnLavishArtifact } = await import('./lavish-runtime');

          const artifact = createArtifact({ projectId, name, htmlPath });
          const result = await spawnLavishArtifact(userId ?? '', artifact);
          audit(projectId, 'open_artifact', `Opened Lavish artifact: ${name} (${htmlPath})`, 'low');
          return {
            ok: true,
            artifactId: result.artifactId,
            name: artifact.name,
            status: result.status,
            note: 'A live Lavish tab is opening. Call poll_artifact_feedback to receive human feedback.',
          };
        } catch (err) {
          // Best-effort audit. project_audit_log.project_id has the SAME
          // `REFERENCES projects(id)` FK that createArtifact can throw on, so for a
          // since-deleted project the audit INSERT would throw too — that must never
          // mask the original error, so swallow any audit failure and always rethrow.
          try {
            audit(projectId, 'open_artifact', `Failed to open artifact: ${name} - ${err instanceof Error ? err.message : String(err)}`, 'high');
          } catch {
            // ignore audit failure; the original error below is what matters
          }
          throw err;
        }
      },
      skipPermission: false,
      defer: 'never',
    }),
    defineTool('poll_artifact_feedback', {
      description:
        'Check for queued human feedback on a live Lavish artifact. This is a BOUNDED, non-blocking poll: it ' +
        'returns any feedback the reviewer has queued, or { pending: true } if none arrived within the timeout ' +
        '(then you may poll again later). Optionally include an agentReply to show your response to the reviewer ' +
        'in Lavish Editor. Does NOT block your turn indefinitely.',
      parameters: {
        type: 'object',
        properties: {
          artifactId: {
            type: 'string',
            description: 'The artifact ID returned by open_artifact.',
          },
          agentReply: {
            type: 'string',
            description: 'Optional message to show the reviewer in Lavish Editor as your reply.',
          },
          timeoutMs: {
            type: 'number',
            description: 'How long to wait for feedback (1000–120000 ms). Defaults to 20000.',
          },
        },
        required: ['artifactId'],
      },
      handler: async ({
        artifactId,
        agentReply,
        timeoutMs,
      }: {
        artifactId: string;
        agentReply?: string;
        timeoutMs?: number;
      }) => {
        const { pollArtifactFeedback } = await import('./lavish-runtime');
        const feedback = await pollArtifactFeedback(artifactId, { agentReply, timeoutMs });
        if (feedback.timedOut || !feedback.raw) {
          return { ok: true, pending: true, note: 'No feedback yet. Poll again later.' };
        }
        return { ok: true, pending: false, feedback: feedback.raw };
      },
      skipPermission: true,
      defer: 'never',
    }),
    defineTool('close_artifact', {
      description: 'Close a live Lavish artifact tab by its ID (ends the session and removes the tab).',
      parameters: {
        type: 'object',
        properties: {
          artifactId: {
            type: 'string',
            description: 'The artifact ID returned by open_artifact.',
          },
        },
        required: ['artifactId'],
      },
      handler: async ({ artifactId }: { artifactId: string }) => {
        const { getArtifactById, deleteArtifact } = await import('./lavish-store');
        const { stopLavishArtifact } = await import('./lavish-runtime');

        const artifact = getArtifactById(artifactId);
        if (!artifact) throw new Error(`Artifact ${artifactId} not found`);

        stopLavishArtifact(artifactId);
        deleteArtifact(artifactId);
        audit(projectId, 'close_artifact', `Closed Lavish artifact: ${artifact.name}`, 'low');
        return { ok: true, artifactId };
      },
      skipPermission: false,
      defer: 'never',
    }),
    defineTool('browse_skills', {
      description: 'List Copilot skills/plugins available to suggest to the user: the plugins already installed, plus (optionally) plugins browsable from a given marketplace. Use this to decide what skill would help with a task (e.g. Lavish for interactive HTML/diagram editing) before suggesting it.',
      parameters: {
        type: 'object',
        properties: {
          marketplace: {
            type: 'string',
            description: 'Optional marketplace name to browse for installable plugins. Omit to only list installed plugins.',
          },
        },
      },
      handler: async ({ marketplace }: { marketplace?: string }) => {
        const { listInstalledPlugins, browsePlugins } = await import('./skill-catalog');
        const installed = listInstalledPlugins();
        const browsable = marketplace ? browsePlugins(marketplace) : [];
        return { installed, browsable, marketplace: marketplace ?? null };
      },
      skipPermission: true,
      defer: 'never',
    }),
    defineTool('install_skill', {
      description: 'Install a Copilot skill/plugin on the user\'s behalf. Behavior is gated by the project\'s skill_install_mode setting. Under "suggest_only" this REFUSES and tells you to only recommend the skill to the user. Under "approve_and_install" it installs — but ONLY after the user has approved via ask_user; you must pass approved:true, which you may only set once the user has said yes. On success it installs persistently AND loads the plugin into your own live session.',
      parameters: {
        type: 'object',
        properties: {
          plugin: {
            type: 'string',
            description: 'The plugin to install: a marketplace plugin name, or a repo slug like "kunchenguid/lavish-axi".',
          },
          marketplace: {
            type: 'string',
            description: 'Optional marketplace name. Omit for a repo-slug plugin (e.g. kunchenguid/lavish-axi).',
          },
          approved: {
            type: 'boolean',
            description: 'Set to true ONLY after the user has explicitly approved the install via ask_user. Required for the install to proceed under approve_and_install mode.',
          },
        },
        required: ['plugin'],
      },
      handler: async ({ plugin, marketplace, approved }: { plugin: string; marketplace?: string; approved?: boolean }) => {
        const mode = skillInstallMode(projectId);
        const { pluginRef, installPlugin } = await import('./skill-catalog');
        const ref = pluginRef(plugin, marketplace);

        if (mode === 'suggest_only') {
          return {
            installed: false,
            mode,
            message: `This project is in "suggest_only" mode, so I can't install ${ref} for you. Recommend the skill to the user and explain how it would help; they can install it themselves, or an admin can switch this project to "approve_and_install".`,
          };
        }

        if (!approved) {
          return {
            installed: false,
            mode,
            message: `Installing ${ref} needs the user's explicit approval first. Ask them with ask_user, then call install_skill again with approved:true only if they say yes.`,
          };
        }

        const output = installPlugin(plugin, marketplace);

        // Load the plugin into the Lead's own live session so it is usable
        // without a restart. Guard against a missing/closed session.
        let sessionLoaded = false;
        let sessionNote = 'Installed. Start or resume this Project Lead session to load the plugin.';
        try {
          const sessionId = getSessionId?.();
          if (sessionId) {
            const { writeToSession } = await import('./cli-bridge');
            sessionLoaded = writeToSession(sessionId, `/plugin install ${ref}\n`);
            if (sessionLoaded) sessionNote = 'Installed and loaded into this live session.';
          }
        } catch {
          sessionLoaded = false;
        }

        audit(projectId, 'install_skill', `Installed skill ${ref} (session loaded: ${sessionLoaded})`, 'medium');
        return { installed: true, mode, plugin: ref, sessionLoaded, note: sessionNote, output };
      },
      skipPermission: true,
      defer: 'never',
    }),
    defineTool('uninstall_skill', {
      description: 'Uninstall a Copilot skill/plugin. Use for symmetry when a suggested skill is no longer wanted.',
      parameters: {
        type: 'object',
        properties: {
          plugin: { type: 'string', description: 'The plugin name or repo slug to uninstall.' },
          marketplace: { type: 'string', description: 'Optional marketplace name.' },
        },
        required: ['plugin'],
      },
      handler: async ({ plugin, marketplace }: { plugin: string; marketplace?: string }) => {
        const { pluginRef, uninstallPlugin } = await import('./skill-catalog');
        const output = uninstallPlugin(plugin, marketplace);
        audit(projectId, 'uninstall_skill', `Uninstalled skill ${pluginRef(plugin, marketplace)}`, 'low');
        return { uninstalled: true, plugin: pluginRef(plugin, marketplace), output };
      },
      skipPermission: true,
      defer: 'never',
    }),
    ...(ghMode !== 'off' ? createGitHubTaskReadTools(projectId) : []),
    ...(ghMode === 'manage' ? createGitHubTaskWriteTools(projectId) : []),
  ];

  return tools;
}

/** Turn a thrown GitHubCliError into a structured result so a tool never throws `gh` failures. */
function ghErrorResult(err: unknown): { ok: false; code: string; message: string } {
  if (err instanceof GitHubCliError) {
    return { ok: false, code: err.code, message: err.message };
  }
  return { ok: false, code: 'failed', message: err instanceof Error ? err.message : String(err) };
}

/** Message returned when a write tool is called without an ask_user go-ahead. */
function needsConfirmation(action: string): { ok: false; confirmed: false; message: string } {
  return {
    ok: false,
    confirmed: false,
    message: `${action} changes GitHub on the user's behalf. Get an explicit go-ahead first with ask_user, then call this tool again with confirmed:true — only once they have said yes.`,
  };
}

/**
 * Read-only GitHub task tools. Registered when github_task_mode is read_only or
 * manage. Each wraps the matching github-store reader and returns its result (or
 * a structured error) so the Lead can ground planning in real issues/PRs/board.
 */
function createGitHubTaskReadTools(projectId: string) {
  return [
    defineTool('list_github_issues', {
      description: 'List this repository\'s GitHub issues (open and closed) to ground planning in real work. Read-only.',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        try {
          return { ok: true, issues: await listIssues(projectId) };
        } catch (err) {
          return ghErrorResult(err);
        }
      },
      skipPermission: true,
      defer: 'never',
    }),
    defineTool('get_github_issue', {
      description: 'Fetch a single GitHub issue with its full body/markdown by number. Read-only.',
      parameters: {
        type: 'object',
        properties: {
          number: { type: 'number', description: 'The issue number.' },
        },
        required: ['number'],
      },
      handler: async ({ number }: { number: number }) => {
        try {
          return { ok: true, issue: await getIssueDetail(projectId, number) };
        } catch (err) {
          return ghErrorResult(err);
        }
      },
      skipPermission: true,
      defer: 'never',
    }),
    defineTool('list_pull_requests', {
      description: 'List this repository\'s pull requests (open and closed). Read-only.',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        try {
          return { ok: true, pullRequests: await listPullRequests(projectId) };
        } catch (err) {
          return ghErrorResult(err);
        }
      },
      skipPermission: true,
      defer: 'never',
    }),
    defineTool('list_milestones', {
      description: 'List this repository\'s milestones with open/closed issue counts. Read-only.',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        try {
          return { ok: true, milestones: await listMilestones(projectId) };
        } catch (err) {
          return ghErrorResult(err);
        }
      },
      skipPermission: true,
      defer: 'never',
    }),
    defineTool('get_github_board', {
      description: 'Fetch the linked GitHub Projects V2 board (columns and cards). Defaults to the project\'s default linked board. Read-only.',
      parameters: {
        type: 'object',
        properties: {
          ghProjectId: { type: 'string', description: 'Optional Projects V2 node ID. Omit to use the default linked board.' },
        },
      },
      handler: async ({ ghProjectId }: { ghProjectId?: string }) => {
        const resolved = ghProjectId || getDefaultProjectLink(projectId)?.ghProjectId;
        if (!resolved) {
          return { ok: false, message: 'No GitHub Project is linked to this project. Link a board in project settings first.' };
        }
        try {
          return { ok: true, board: await getBoard(projectId, resolved) };
        } catch (err) {
          return ghErrorResult(err);
        }
      },
      skipPermission: true,
      defer: 'never',
    }),
  ];
}

/**
 * Write GitHub task tools. Registered ONLY when github_task_mode is manage. Each
 * takes confirmed?:boolean and refuses unless confirmed===true, mirroring the
 * install_skill approval contract: the Lead must get an ask_user go-ahead first.
 */
function createGitHubTaskWriteTools(projectId: string) {
  return [
    defineTool('create_github_issue', {
      description: 'File a new GitHub issue on the default linked board. Requires an ask_user go-ahead: call with confirmed:true only after the user approves. Refuses otherwise.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The issue title.' },
          body: { type: 'string', description: 'Optional issue body (markdown).' },
          confirmed: { type: 'boolean', description: 'Set true ONLY after the user has approved filing this issue via ask_user.' },
        },
        required: ['title'],
      },
      handler: async ({ title, body, confirmed }: { title: string; body?: string; confirmed?: boolean }) => {
        if (confirmed !== true) return needsConfirmation('Filing a GitHub issue');
        const ghProjectId = getDefaultProjectLink(projectId)?.ghProjectId;
        if (!ghProjectId) {
          return { ok: false, message: 'No GitHub Project is linked to this project. Link a board in project settings first.' };
        }
        try {
          const created = await createBoardIssue(projectId, ghProjectId, null, null, title, body ?? '');
          audit(projectId, 'create_github_issue', `Filed issue #${created.number}: ${condenseBriefing(title)}`, 'medium', String(created.number));
          return { ok: true, ...created };
        } catch (err) {
          return ghErrorResult(err);
        }
      },
      skipPermission: false,
      defer: 'never',
    }),
    defineTool('update_github_issue', {
      description: 'Update a GitHub issue\'s title and/or body. Requires an ask_user go-ahead: call with confirmed:true only after the user approves. Refuses otherwise.',
      parameters: {
        type: 'object',
        properties: {
          number: { type: 'number', description: 'The issue number to update.' },
          title: { type: 'string', description: 'New title (optional).' },
          body: { type: 'string', description: 'New body/markdown (optional).' },
          confirmed: { type: 'boolean', description: 'Set true ONLY after the user has approved this update via ask_user.' },
        },
        required: ['number'],
      },
      handler: async ({ number, title, body, confirmed }: { number: number; title?: string; body?: string; confirmed?: boolean }) => {
        if (confirmed !== true) return needsConfirmation('Updating a GitHub issue');
        try {
          await updateIssue(projectId, number, { title, body });
          audit(projectId, 'update_github_issue', `Updated issue #${number}`, 'medium', String(number));
          return { ok: true, number };
        } catch (err) {
          return ghErrorResult(err);
        }
      },
      skipPermission: false,
      defer: 'never',
    }),
    defineTool('open_pull_request', {
      description: 'Push a worker\'s worktree branch and open the pull request that checks it in (auto-closing its linked issue). Requires an ask_user go-ahead: call with confirmed:true only after the user approves. Refuses otherwise.',
      parameters: {
        type: 'object',
        properties: {
          worktreeId: { type: 'string', description: 'The worktree whose branch to push and open a PR for.' },
          title: { type: 'string', description: 'The pull request title.' },
          body: { type: 'string', description: 'Optional PR body (markdown).' },
          draft: { type: 'boolean', description: 'Open as a draft PR.' },
          base: { type: 'string', description: 'Optional base branch. Defaults to the repo default.' },
          confirmed: { type: 'boolean', description: 'Set true ONLY after the user has approved opening this PR via ask_user.' },
        },
        required: ['worktreeId', 'title'],
      },
      handler: async ({ worktreeId, title, body, draft, base, confirmed }: {
        worktreeId: string; title: string; body?: string; draft?: boolean; base?: string; confirmed?: boolean;
      }) => {
        if (confirmed !== true) return needsConfirmation('Opening a pull request');
        try {
          const pr = await createPullRequest(projectId, worktreeId, { title, body, draft, base });
          audit(projectId, 'open_pull_request', `Opened PR #${pr.number}: ${condenseBriefing(title)}`, 'high', worktreeId);
          return { ok: true, ...pr };
        } catch (err) {
          return ghErrorResult(err);
        }
      },
      skipPermission: false,
      defer: 'never',
    }),
    defineTool('move_board_item', {
      description: 'Move a board card to a Status column (or clear it). Requires an ask_user go-ahead: call with confirmed:true only after the user approves. Refuses otherwise.',
      parameters: {
        type: 'object',
        properties: {
          itemId: { type: 'string', description: 'The board item (card) node ID.' },
          fieldId: { type: 'string', description: 'The Status field node ID.' },
          optionId: { type: 'string', description: 'The target option node ID. Omit to clear the field.' },
          ghProjectId: { type: 'string', description: 'Optional Projects V2 node ID. Omit to use the default linked board.' },
          confirmed: { type: 'boolean', description: 'Set true ONLY after the user has approved this move via ask_user.' },
        },
        required: ['itemId', 'fieldId'],
      },
      handler: async ({ itemId, fieldId, optionId, ghProjectId, confirmed }: {
        itemId: string; fieldId: string; optionId?: string; ghProjectId?: string; confirmed?: boolean;
      }) => {
        if (confirmed !== true) return needsConfirmation('Moving a board card');
        const resolved = ghProjectId || getDefaultProjectLink(projectId)?.ghProjectId;
        if (!resolved) {
          return { ok: false, message: 'No GitHub Project is linked to this project. Link a board in project settings first.' };
        }
        try {
          await moveBoardItem(projectId, resolved, itemId, fieldId, optionId ?? null);
          audit(projectId, 'move_board_item', `Moved board card ${itemId}`, 'medium', itemId);
          return { ok: true, itemId };
        } catch (err) {
          return ghErrorResult(err);
        }
      },
      skipPermission: false,
      defer: 'never',
    }),
  ];
}
