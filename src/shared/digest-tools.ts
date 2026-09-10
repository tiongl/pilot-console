import { defineTool } from '@github/copilot-sdk';
import { upsertDigest } from './digest-store';

interface UpdateDigestArgs {
  headline: string;
  status: 'in_progress' | 'blocked' | 'ready_to_merge' | 'idle';
  detail: string;
  scope: 'small' | 'medium' | 'large';
  touched_files?: string[];
  risk_notes?: string;
}

export function createWorktreeAgentTools(worktreeId: string) {
  return [
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
        return { ok: true, updatedAt: digest.updatedAt };
      },
      skipPermission: true,
      defer: 'never',
    }),
  ];
}
