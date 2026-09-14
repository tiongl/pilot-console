import { defineTool } from '@github/copilot-sdk';
import { getMergeRequestForWorktree, requestMerge } from './merge-store';

export function createMergeTools(worktreeId: string) {
  return [
    defineTool('request_merge', {
      description: 'Request that this worktree be reviewed for merging.',
      parameters: {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
      },
      handler: ({ summary }: { summary: string }) => requestMerge(worktreeId, summary),
      skipPermission: true,
      defer: 'never',
    }),
    defineTool('check_merge_status', {
      description: 'Check the current merge request status for this worktree.',
      parameters: { type: 'object', properties: {} },
      handler: () => getMergeRequestForWorktree(worktreeId),
      skipPermission: true,
      defer: 'never',
    }),
  ];
}
