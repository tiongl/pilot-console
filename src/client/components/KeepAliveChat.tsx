import { useState, useEffect, useRef } from 'react';
import ProjectChatPage from '../pages/ProjectChatPage';

const MAX_CACHED = 3;

interface CacheEntry {
  /** Stable key: "projectId:main" or "projectId:worktree:worktreeId" */
  cacheKey: string;
  projectId: string;
  worktreeId?: string;
}

/**
 * Keeps up to MAX_CACHED ProjectChatPage instances alive, hiding inactive
 * ones with CSS instead of unmounting them.  When a new project/worktree is
 * opened and the cache is full, the least-recently-used entry is evicted
 * (unmounted).
 */
export default function KeepAliveChat({
  projectId,
  worktreeId,
}: {
  projectId?: string;
  worktreeId?: string;
}) {
  const cacheKey = worktreeId
    ? `${projectId}:worktree:${worktreeId}`
    : `${projectId}:main`;

  const [entries, setEntries] = useState<CacheEntry[]>([]);
  // Track the previous active key so we know when it changes
  const prevKeyRef = useRef(cacheKey);

  // Update cache whenever active key changes
  useEffect(() => {
    if (!projectId) return;
    setEntries(prev => {
      const idx = prev.findIndex(e => e.cacheKey === cacheKey);
      if (idx >= 0) {
        // Move to end (most-recently-used)
        const next = [...prev];
        const [entry] = next.splice(idx, 1);
        next.push(entry);
        return next;
      }
      // Add new entry, evict oldest if over limit
      const entry: CacheEntry = { cacheKey, projectId, worktreeId };
      const next = [...prev, entry];
      if (next.length > MAX_CACHED) {
        next.shift(); // evict LRU
      }
      return next;
    });
    prevKeyRef.current = cacheKey;
  }, [cacheKey, projectId, worktreeId]);

  if (!projectId) return null;

  return (
    <div className="relative w-full h-full">
      {entries.map(entry => {
        const isActive = entry.cacheKey === cacheKey;
        return (
          <div
            key={entry.cacheKey}
            className="absolute inset-0"
            style={{
              display: isActive ? 'block' : 'none',
              zIndex: isActive ? 1 : 0,
            }}
          >
            <ProjectChatPage
              projectId={entry.projectId}
              worktreeId={entry.worktreeId}
              visible={isActive}
            />
          </div>
        );
      })}
    </div>
  );
}
