import { defineTool } from '@github/copilot-sdk';
import type { Tool } from '@github/copilot-sdk';
import { upsertDigest } from './digest-store';
import { getDelegationForWorktree, markWorktreeDelegation, type Delegation } from './delegation-store';
import { notifyProjectLead } from './delegation-runtime';

/** Char budget for the reviewer reasoning folded back on a deepMerge review. */
const REVIEW_REASONING_BUDGET = 2000;

/**
 * Fold a spin_off_review reviewer's verdict back to the Project Lead, framed so
 * the Lead owns it as its own completed review. On a deepMerge review, a
 * bounded condensation of the reviewer's reasoning is appended so the Lead can
 * answer follow-ups; otherwise only the verdict + findings are sent (the raw
 * reasoning stays viewable in the reviewer's own tab).
 */
async function buildReviewMergeBack(
  delegation: Delegation,
  worktreeId: string,
  args: UpdateDigestArgs,
  passed: boolean,
): Promise<string> {
  const verdict = passed ? 'pass' : 'changes-needed';
  const lines = [
    `[review finished · ${delegation.title}]`,
    `Worktree id: ${worktreeId}`,
    `Verdict: ${verdict}`,
    '',
    args.headline,
    '',
    args.detail,
  ];

  if (delegation.deepMerge && delegation.sessionId) {
    try {
      const { summarizeSessionReasoning } = await import('./agent-bridge');
      const reasoning = summarizeSessionReasoning(delegation.sessionId, REVIEW_REASONING_BUDGET);
      if (reasoning) {
        lines.push('', 'My reasoning (folded in for follow-up):', reasoning);
      }
    } catch (err) {
      console.error(`[digest-tools] Could not fold reviewer reasoning for ${worktreeId}:`, err);
    }
  }

  lines.push(
    '',
    passed
      ? 'This is your review. Act on it: approve_merge if you agree, or nudge_worker with the findings.'
      : 'This is your review. Act on it: nudge_worker with the findings so the worker can address them, or reject_merge.',
  );
  return lines.join('\n');
}

interface UpdateDigestArgs {
  headline: string;
  status: 'in_progress' | 'blocked' | 'ready_to_merge' | 'idle';
  detail: string;
  scope: 'small' | 'medium' | 'large';
  touched_files?: string[];
  risk_notes?: string;
}

interface AskLeadArgs {
  question: string;
  urgency?: 'blocking' | 'non_blocking';
}

export function createWorktreeAgentTools(
  worktreeId: string,
  projectId?: string | null,
  userId?: string,
) {
  const tools: Tool<any>[] = [
    defineTool<UpdateDigestArgs>('update_digest', {
      description: 'Publish the current compact status of this worktree for the project dashboard.',
      parameters: {
        type: 'object',
        properties: {
          headline: { type: 'string', description: 'A short description of the current work.' },
          status: { type: 'string', enum: ['in_progress', 'blocked', 'ready_to_merge', 'idle'] },
          detail: { type: 'string', description: 'A concise 2-4 sentence summary.' },
          scope: { type: 'string', enum: ['small', 'medium', 'large'] },
          touched_files: { type: 'array', items: { type: 'string' } },
          risk_notes: { type: 'string' },
        },
        required: ['headline', 'status', 'detail', 'scope'],
      },
      handler: async (args) => {
        const digest = upsertDigest(worktreeId, {
          headline: args.headline,
          status: args.status,
          detail: args.detail,
          scope: args.scope,
          touchedFiles: args.touched_files,
          riskNotes: args.risk_notes,
        });
        // Mirror notable states onto the delegation so the lead's worker tab and
        // the sidebar reflect them without anyone opening the session.
        const delegation = getDelegationForWorktree(worktreeId);
        const wasStatus = delegation?.status;
        if (args.status === 'blocked') {
          markWorktreeDelegation(worktreeId, { status: 'blocked', note: args.headline, unread: true });
        } else if (args.status === 'ready_to_merge') {
          markWorktreeDelegation(worktreeId, { status: 'done', note: args.headline, unread: true });
        } else if (args.status === 'in_progress') {
          markWorktreeDelegation(worktreeId, { status: 'working', note: args.headline });
        }

        // The lead is forbidden from polling for workers, so a worker that
        // finishes or gets stuck has to say so or the lead never finds out.
        // Only announce the transition, not every later repeat of the state.
        const announce =
          (args.status === 'ready_to_merge' && wasStatus !== 'done') ||
          (args.status === 'blocked' && wasStatus !== 'blocked');
        if (delegation && announce && projectId && userId) {
          const finished = args.status === 'ready_to_merge';
          const message = delegation.isReview
            ? await buildReviewMergeBack(delegation, worktreeId, args, finished)
            : [
                `[worker ${finished ? 'finished' : 'blocked'} · ${delegation.title}]`,
                `Worktree id: ${worktreeId}`,
                '',
                args.headline,
                '',
                args.detail,
                '',
                finished
                  ? 'Review it with get_digest, then approve_merge or reject_merge. If more work is needed, use nudge_worker.'
                  : 'Unblock it with nudge_worker, or close it out with cancel_worker if it cannot continue.',
              ].join('\n');
          try {
            await notifyProjectLead(userId, projectId, message);
          } catch (err) {
            // The digest is already saved; failing to reach the lead must not
            // turn the worker's status update into an error.
            console.error(`[digest-tools] Could not notify project lead for ${worktreeId}:`, err);
          }
        }
        return { ok: true, updatedAt: digest.updatedAt };
      },
      skipPermission: true,
      defer: 'never',
    }),
  ];

  // The return channel only exists for work a Project Lead actually delegated;
  // an ad-hoc worktree chat has no lead conversation to answer it.
  if (projectId && userId) {
    tools.push(
      defineTool<AskLeadArgs>('ask_project_lead', {
        description:
          'Ask the Project Lead a question about the work you were given — a blocker, an ambiguous requirement, or a decision outside your scope. The question is delivered into the Project Lead conversation and the lead answers by messaging you back. Use this instead of guessing or stopping silently. Keep it to one specific question.',
        parameters: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'One specific question, with the context needed to answer it.' },
            urgency: {
              type: 'string',
              enum: ['blocking', 'non_blocking'],
              description: 'blocking means you cannot make further progress until this is answered.',
            },
          },
          required: ['question'],
        },
        handler: async ({ question, urgency }: AskLeadArgs) => {
          const delegation = getDelegationForWorktree(worktreeId);
          const label = delegation ? delegation.title : `worktree ${worktreeId}`;
          const blocking = urgency === 'blocking';
          markWorktreeDelegation(
            worktreeId,
            blocking ? { status: 'blocked', note: question, unread: true } : { unread: true },
          );
          await notifyProjectLead(
            userId,
            projectId,
            [
              `[worker question · ${label}${blocking ? ' · BLOCKING' : ''}]`,
              `Worktree id: ${worktreeId}`,
              '',
              question,
              '',
              `Answer by calling nudge_worker with worktreeId "${worktreeId}".`,
            ].join('\n'),
          );
          return {
            ok: true,
            delivered: 'project_lead',
            note: 'The lead will reply in this session. Continue with anything not blocked by this question.',
          };
        },
        skipPermission: true,
        defer: 'never',
      }),
    );
  }

  return tools;
}
