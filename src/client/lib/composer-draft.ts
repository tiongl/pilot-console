/**
 * Browser-side persistence of the composer draft, keyed by sessionId.
 *
 * The composer text is otherwise just React state, so a refresh/reload loses any
 * typed-but-unsent message. Persisting it per session lets the pane restore the
 * draft after a reload and keeps drafts from bleeding between sessions.
 *
 * Everything here is best-effort: storage may be disabled (private mode) or
 * throw on quota. Any failure degrades silently to "no draft" so the composer
 * never breaks. The key prefix mirrors the transcript cache's per-session
 * namespacing scheme (see transcript-cache.ts).
 */

const KEY_PREFIX = 'pilot-console-agent-draft-v1:';

function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

function draftKey(sessionId: string): string {
  return KEY_PREFIX + sessionId;
}

/** Read the saved draft for a session, or `null` when there is none. */
export function readDraft(sessionId: string): string | null {
  if (!sessionId) return null;
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(draftKey(sessionId));
    return raw && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Persist the composer draft for a session (best-effort). An empty draft is
 * cleared rather than stored, so the persisted value always mirrors the unsent
 * composer contents.
 */
export function writeDraft(sessionId: string, text: string): void {
  if (!sessionId) return;
  if (!text) {
    clearDraft(sessionId);
    return;
  }
  const store = storage();
  if (!store) return;
  try {
    store.setItem(draftKey(sessionId), text);
  } catch {
    /* ignore */
  }
}

/** Remove a session's saved draft (best-effort). */
export function clearDraft(sessionId: string): void {
  if (!sessionId) return;
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(draftKey(sessionId));
  } catch {
    /* ignore */
  }
}
