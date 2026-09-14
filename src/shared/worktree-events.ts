import { EventEmitter } from 'events';

// Event bus for worktree/delegation changes — decouples the store/cleanup layer
// from the websocket server to avoid circular imports (cli-bridge already imports
// project-store, so reusing cliBridgeEvents here would create a cycle).
// Emits 'worktrees-changed' with { projectId } after a Lead-driven mutation so the
// notify WebSocket can push a sidebar refresh to connected clients.
export const worktreeEvents = new EventEmitter();

export interface WorktreesChangedPayload {
  projectId: string;
}

/** Notify listeners that a project's worktrees/delegations changed. No-op without a projectId. */
export function emitWorktreesChanged(projectId: string | null | undefined): void {
  if (!projectId) return;
  worktreeEvents.emit('worktrees-changed', { projectId } satisfies WorktreesChangedPayload);
}
