import { defineTool } from '@github/copilot-sdk';
import type { Tool } from '@github/copilot-sdk';
import { upsertDigest } from './digest-store';
import { getDelegationForWorktree, markWorktreeDelegation } from './delegation-store';
import { notifyProjectLead } from './delegation-runtime';

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
        if (args.status === 'blocked') {
          markWorktreeDelegation(worktreeId, { status: 'blocked', note: args.headline, unread: true });
        } else if (args.status === 'ready_to_merge') {
          markWorktreeDelegation(worktreeId, { status: 'done', note: args.headline, unread: true });
        } else if (args.status === 'in_progress') {
          markWorktreeDelegation(worktreeId, { status: 'working', note: args.headline });
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
