import type { AgentTranscriptEvent } from '@/types';

/**
 * Browser-side cache of the last-rendered agent transcript, keyed by sessionId.
 *
 * Reopening a session used to paint blank until the server's `replay` landed.
 * Caching the transcript lets the pane paint the previous conversation
 * immediately (optimistically) and then reconcile to the authoritative replay.
 *
 * Everything here is best-effort: storage may be disabled (private mode),
 * throw on quota, or hold a payload from an older schema. Any failure degrades
 * silently to "no cache" so the pane falls back to today's behavior.
 */

const SCHEMA_VERSION = 1;
const KEY_PREFIX = 'pilot-console-agent-transcript-v1:';
const INDEX_KEY = 'pilot-console-agent-transcript-index-v1';

/**
 * Cap the events stored per session. Mirrors the server's replay window so the
 * cache never holds more than a fresh replay would render, keeping each entry
 * bounded even for very long conversations.
 */
const MAX_CACHED_EVENTS = 400;

/** Cap the number of distinct sessions cached; oldest are evicted (LRU). */
const MAX_CACHED_SESSIONS = 20;

interface CacheEntry {
  version: number;
  sessionId: string;
  events: AgentTranscriptEvent[];
  savedAt: number;
}

interface IndexRecord {
  sessionId: string;
  savedAt: number;
}

function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

function entryKey(sessionId: string): string {
  return KEY_PREFIX + sessionId;
}

/** Shallow structural check so a malformed/old payload is discarded, not rendered. */
function isTranscriptEvent(value: unknown): value is AgentTranscriptEvent {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return typeof e.kind === 'string' && typeof e.id === 'string' && typeof e.ts === 'number';
}

function readIndex(store: Storage): IndexRecord[] {
  try {
    const raw = store.getItem(INDEX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is IndexRecord =>
        !!r && typeof r === 'object' && typeof (r as IndexRecord).sessionId === 'string',
    );
  } catch {
    return [];
  }
}

function writeIndex(store: Storage, index: IndexRecord[]): void {
  try {
    store.setItem(INDEX_KEY, JSON.stringify(index));
  } catch {
    /* ignore */
  }
}

/** Record a write in the LRU index and evict the oldest sessions past the cap. */
function touchIndex(store: Storage, sessionId: string, savedAt: number): void {
  let index = readIndex(store).filter((r) => r.sessionId !== sessionId);
  index.push({ sessionId, savedAt });
  index.sort((a, b) => a.savedAt - b.savedAt);
  while (index.length > MAX_CACHED_SESSIONS) {
    const evicted = index.shift();
    if (evicted) {
      try {
        store.removeItem(entryKey(evicted.sessionId));
      } catch {
        /* ignore */
      }
    }
  }
  writeIndex(store, index);
}

/**
 * Read the cached transcript for a session, or `null` when there is none, the
 * schema/shape doesn't match, the stored id doesn't match, or storage is
 * unavailable. Keyed strictly by sessionId so one session can never render
 * another's transcript.
 */
export function readTranscript(sessionId: string): AgentTranscriptEvent[] | null {
  if (!sessionId) return null;
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(entryKey(sessionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CacheEntry>;
    if (
      !parsed ||
      parsed.version !== SCHEMA_VERSION ||
      parsed.sessionId !== sessionId ||
      !Array.isArray(parsed.events)
    ) {
      return null;
    }
    const events = parsed.events.filter(isTranscriptEvent);
    if (events.length !== parsed.events.length) return null;
    return events;
  } catch {
    return null;
  }
}

/**
 * Persist the transcript for a session (best-effort). `system` events are
 * dropped (they are filtered out of the view) and the list is capped to the
 * most recent {@link MAX_CACHED_EVENTS}. On a quota error the oldest cached
 * session is evicted and the write retried once.
 */
export function writeTranscript(sessionId: string, events: AgentTranscriptEvent[]): void {
  if (!sessionId) return;
  const store = storage();
  if (!store) return;

  const trimmed = events.filter((e) => e.kind !== 'system').slice(-MAX_CACHED_EVENTS);
  const savedAt = Date.now();
  const entry: CacheEntry = { version: SCHEMA_VERSION, sessionId, events: trimmed, savedAt };
  const serialized = JSON.stringify(entry);

  const attempt = (): boolean => {
    try {
      store.setItem(entryKey(sessionId), serialized);
      return true;
    } catch {
      return false;
    }
  };

  if (attempt()) {
    touchIndex(store, sessionId, savedAt);
    return;
  }

  // Quota/failure: drop the oldest cached session and try once more.
  const index = readIndex(store).filter((r) => r.sessionId !== sessionId);
  index.sort((a, b) => a.savedAt - b.savedAt);
  const oldest = index.shift();
  if (oldest) {
    try {
      store.removeItem(entryKey(oldest.sessionId));
    } catch {
      /* ignore */
    }
    writeIndex(store, index);
  }
  if (attempt()) {
    touchIndex(store, sessionId, savedAt);
  }
}

/** Remove a session's cached transcript (best-effort). */
export function clearTranscript(sessionId: string): void {
  if (!sessionId) return;
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(entryKey(sessionId));
    writeIndex(store, readIndex(store).filter((r) => r.sessionId !== sessionId));
  } catch {
    /* ignore */
  }
}
