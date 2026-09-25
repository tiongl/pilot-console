import { EventEmitter } from 'events';

// Event bus for Lavish artifact changes — decouples the store/runtime layer from
// the websocket server (mirrors worktree-events.ts) to avoid import cycles.
// Emits 'artifacts-changed' with { projectId } after an artifact is created,
// deleted, or changes status, so the notify WebSocket can push an instant tab
// refresh to the Project Lead page instead of waiting on its 8s poll.
export const lavishEvents = new EventEmitter();

export interface ArtifactsChangedPayload {
  projectId: string;
}

/** Notify listeners that a project's Lavish artifacts changed. No-op without a projectId. */
export function emitArtifactsChanged(projectId: string | null | undefined): void {
  if (!projectId) return;
  lavishEvents.emit('artifacts-changed', { projectId } satisfies ArtifactsChangedPayload);
}
