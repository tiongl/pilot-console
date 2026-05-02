import { useState, useEffect, useCallback } from 'react';

const STORAGE_KEY = 'automation_last_seen_at';

function getLastSeen(): string {
  return localStorage.getItem(STORAGE_KEY) || new Date(0).toISOString();
}

function setLastSeen(timestamp: string): void {
  localStorage.setItem(STORAGE_KEY, timestamp);
}

/**
 * Centralized hook for automation badge count.
 * Tracks unseen completed runs since last visit to the automation page.
 */
export function useAutomationBadge() {
  const [count, setCount] = useState(0);

  const refresh = useCallback(async () => {
    const since = getLastSeen();
    try {
      const res = await fetch(`/api/admin/runs/unseen-count?since=${encodeURIComponent(since)}`);
      if (res.ok) {
        const data = await res.json();
        setCount(data.count ?? 0);
      }
    } catch {}
  }, []);

  /** Mark all current runs as seen. Call with the latest server completedAt. */
  const markSeen = useCallback((latestCompletedAt?: string) => {
    const ts = latestCompletedAt || new Date().toISOString();
    setLastSeen(ts);
    setCount(0);
  }, []);

  /** Increment count by 1 (for websocket notifications) */
  const increment = useCallback(() => {
    setCount(prev => prev + 1);
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 60_000);
    return () => clearInterval(interval);
  }, [refresh]);

  return { count, refresh, markSeen, increment };
}
