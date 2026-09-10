import { useCallback, useEffect, useRef, useState } from 'react';

export interface GitHubError {
  message: string;
  code: string | null;
}

interface State<T> {
  data: T | null;
  loading: boolean;
  error: GitHubError | null;
  /** Set once the first load settles; used to distinguish initial load from refresh. */
  loaded: boolean;
}

interface Options {
  /** Poll interval (ms) while the browser tab is focused. 0 disables polling. */
  pollMs?: number;
  /** Skip fetching entirely (e.g. no linked project yet). */
  enabled?: boolean;
}

/**
 * Fetches a GitHub-backed project resource with loading/error state, a manual
 * refresh (bypassing the server cache via `?refresh=1`), and light focus-aware
 * polling. Nothing is persisted client-side; GitHub stays the source of truth.
 */
export function useGitHubResource<T>(
  projectId: string,
  path: string,
  options: Options = {},
): State<T> & { refresh: () => void } {
  const { pollMs = 30_000, enabled = true } = options;
  const [state, setState] = useState<State<T>>({ data: null, loading: enabled, error: null, loaded: false });
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  const load = useCallback(
    async (force: boolean) => {
      if (!enabled) return;
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setState((s) => ({ ...s, loading: true }));
      try {
        const sep = path.includes('?') ? '&' : '?';
        const url = `/api/projects/${encodeURIComponent(projectId)}/github${path}${force ? `${sep}refresh=1` : ''}`;
        const res = await fetch(url, { signal: ac.signal });
        const body = await res.json().catch(() => ({}));
        if (ac.signal.aborted || !mountedRef.current) return;
        if (!res.ok) {
          setState({
            data: null,
            loading: false,
            loaded: true,
            error: { message: body.error || `Request failed (${res.status})`, code: body.code ?? null },
          });
          return;
        }
        setState({ data: body as T, loading: false, loaded: true, error: null });
      } catch (err) {
        if (ac.signal.aborted || !mountedRef.current) return;
        setState({ data: null, loading: false, loaded: true, error: { message: (err as Error).message, code: null } });
      }
    },
    [projectId, path, enabled],
  );

  useEffect(() => {
    mountedRef.current = true;
    if (enabled) {
      void load(false);
    } else {
      setState({ data: null, loading: false, error: null, loaded: false });
    }
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, [load, enabled]);

  useEffect(() => {
    if (!enabled || !pollMs) return;
    const tick = () => {
      if (document.visibilityState === 'visible') void load(false);
    };
    const timer = window.setInterval(tick, pollMs);
    return () => window.clearInterval(timer);
  }, [load, enabled, pollMs]);

  const refresh = useCallback(() => void load(true), [load]);

  return { ...state, refresh };
}
