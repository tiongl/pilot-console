import { defineTool } from '@github/copilot-sdk';
import { listWorktrees } from './project-store';
import { getDigest, listDigests } from './digest-store';
import { getDb } from './db';
import { executeApprovedMerge, getMergeRequest, resolveMergeRequest } from './merge-store';
import { getOrBootstrapProjectMemory, refreshProjectMemory } from './project-memory-store';
import { recordCosBriefing } from './cos-briefing-store';

function audit(projectId: string, action: string, reasoning: string, riskLevel: 'low' | 'medium' | 'high' = 'low') {
  getDb().prepare(`
    INSERT INTO project_audit_log (id, project_id, actor, action, reasoning, risk_level)
    VALUES (?, ?, 'project_lead', ?, ?, ?)
  `).run(crypto.randomUUID(), projectId, action, reasoning, riskLevel);
}

function interventionMode(projectId: string): 'flag_only' | 'flag_nudge' | 'flag_nudge_cancel' {
  const row = getDb().prepare(
    'SELECT intervention_mode FROM project_autonomy_settings WHERE project_id = ?',
  ).get(projectId) as { intervention_mode?: string } | undefined;
  if (row?.intervention_mode === 'flag_nudge_cancel') return 'flag_nudge_cancel';
  if (row?.intervention_mode === 'flag_nudge') return 'flag_nudge';
  return 'flag_only';
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

export function createProjectLeadTools(projectId: string) {
  return [
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
      description: 'Send a concise briefing to the Chief of Staff summarizing what was discussed/decided in this conversation, so the CoS stays aware without reading the full transcript. Call this after reaching a decision, completing a review, or before ending a significant conversation.',
      parameters: {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
      },
      handler: ({ summary }: { summary: string }) => {
        const briefing = recordCosBriefing(projectId, summary);
        audit(projectId, 'brief_chief_of_staff', summary, 'low');
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
        getDb().prepare(`
          INSERT INTO decision_threads (id, project_id, title, question, status)
          VALUES (?, ?, ?, ?, ?)
        `).run(id, projectId, title, question, openQuestions ? 'open' : 'confirmed');
        audit(projectId, 'record_requirements', title, openQuestions ? 'medium' : 'low');
        return { id, title, status: openQuestions ? 'open' : 'confirmed' };
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
        return executeApprovedMerge(requestId);
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
    defineTool('nudge_worker', {
      description: 'Send a non-destructive guidance message to a live worktree agent. Requires flag_nudge or flag_nudge_cancel intervention mode.',
      parameters: {
        type: 'object',
        properties: { worktreeId: { type: 'string' }, message: { type: 'string' } },
        required: ['worktreeId', 'message'],
      },
      handler: async ({ worktreeId, message }: { worktreeId: string; message: string }) => {
        const mode = interventionMode(projectId);
        if (mode === 'flag_only') throw new Error('Worker nudges are disabled by project autonomy settings');
        const { findLiveWorktreeAgent, sendAgentMessage } = await import('./agent-bridge');
        const session = findLiveWorktreeAgent(projectId, worktreeId);
        if (!session) throw new Error('No live worktree agent session found');
        await sendAgentMessage(session.sessionId, message);
        audit(projectId, 'nudge_worker', message, 'medium');
        return { ok: true, sessionId: session.sessionId };
      },
      skipPermission: true,
      defer: 'never',
    }),
    defineTool('cancel_worker', {
      description: 'Stop a live worktree agent. Requires flag_nudge_cancel intervention mode.',
      parameters: {
        type: 'object',
        properties: { worktreeId: { type: 'string' }, reason: { type: 'string' } },
        required: ['worktreeId', 'reason'],
      },
      handler: async ({ worktreeId, reason }: { worktreeId: string; reason: string }) => {
        if (interventionMode(projectId) !== 'flag_nudge_cancel') {
          throw new Error('Worker cancellation is disabled by project autonomy settings');
        }
        const { cancelAgent, findLiveWorktreeAgent } = await import('./agent-bridge');
        const session = findLiveWorktreeAgent(projectId, worktreeId);
        if (!session) throw new Error('No live worktree agent session found');
        await cancelAgent(session.sessionId);
        audit(projectId, 'cancel_worker', reason, 'high');
        return { ok: true, sessionId: session.sessionId };
      },
      skipPermission: true,
      defer: 'never',
    }),
  ];
}
