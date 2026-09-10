import { useCallback, useEffect, useState } from 'react';
import { Check, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { GitHubScopeGate } from './GitHubScopeGate';
import type { GitHubError } from '../../hooks/useGitHubResource';
import type { GitHubProjectLink, GitHubProjectV2Summary } from '@/types';

/**
 * Lets the user associate this console project with GitHub Projects V2 boards
 * (auto-detected from the repo) and pick the default one. Persists only the
 * link config via PUT /links; never stores board content.
 */
export function GitHubProjectPicker({ projectId }: { projectId: string }) {
  const [available, setAvailable] = useState<GitHubProjectV2Summary[]>([]);
  const [links, setLinks] = useState<GitHubProjectLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<GitHubError | null>(null);

  const base = `/api/projects/${encodeURIComponent(projectId)}/github`;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [projRes, linkRes] = await Promise.all([
        fetch(`${base}/linked-projects`),
        fetch(`${base}/links`),
      ]);
      const projBody = await projRes.json().catch(() => ({}));
      const linkBody = await linkRes.json().catch(() => ({}));
      if (!projRes.ok) {
        setError({ message: projBody.error || 'Failed to load projects', code: projBody.code ?? null });
        setLinks(linkBody.links ?? []);
        return;
      }
      setAvailable(projBody.projects ?? []);
      setLinks(linkBody.links ?? []);
    } catch (err) {
      setError({ message: (err as Error).message, code: null });
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedIds = new Set(links.map((l) => l.ghProjectId));
  const defaultId = links.find((l) => l.isDefault)?.ghProjectId ?? links[0]?.ghProjectId ?? null;

  const persist = async (next: GitHubProjectV2Summary[], nextDefault: string | null) => {
    setSaving(true);
    try {
      const payload = next.map((p) => ({
        ghProjectId: p.id,
        ghProjectNumber: p.number,
        title: p.title,
        isDefault: p.id === nextDefault,
      }));
      const res = await fetch(`${base}/links`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ links: payload }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) setLinks(body.links ?? []);
    } finally {
      setSaving(false);
    }
  };

  const toggle = (proj: GitHubProjectV2Summary) => {
    const isSelected = selectedIds.has(proj.id);
    const currentSelected = available.filter((p) => selectedIds.has(p.id));
    let next: GitHubProjectV2Summary[];
    let nextDefault = defaultId;
    if (isSelected) {
      next = currentSelected.filter((p) => p.id !== proj.id);
      if (defaultId === proj.id) nextDefault = next[0]?.id ?? null;
    } else {
      next = [...currentSelected, proj];
      if (!nextDefault) nextDefault = proj.id;
    }
    void persist(next, nextDefault);
  };

  const makeDefault = (proj: GitHubProjectV2Summary) => {
    const currentSelected = available.filter((p) => selectedIds.has(p.id) || p.id === proj.id);
    void persist(currentSelected, proj.id);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">GitHub Project board</span>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => void load()} disabled={loading} title="Refresh">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
        </div>
      ) : error ? (
        GitHubScopeGate({ error }) ?? <p className="text-xs text-destructive">{error.message}</p>
      ) : available.length === 0 ? (
        <p className="text-xs text-muted-foreground">No Projects V2 boards are linked to this repository on GitHub.</p>
      ) : (
        <ul className="space-y-1">
          {available.map((proj) => {
            const selected = selectedIds.has(proj.id);
            const isDefault = defaultId === proj.id;
            return (
              <li key={proj.id} className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm">
                <button
                  type="button"
                  onClick={() => toggle(proj)}
                  disabled={saving}
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${selected ? 'border-primary bg-primary text-primary-foreground' : 'border-input'}`}
                  title={selected ? 'Unlink' : 'Link'}
                >
                  {selected && <Check className="h-3 w-3" />}
                </button>
                <span className="min-w-0 flex-1 truncate">
                  {proj.title}
                  <span className="ml-1 text-xs text-muted-foreground">#{proj.number}</span>
                </span>
                {selected &&
                  (isDefault ? (
                    <span className="shrink-0 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] text-primary">default</span>
                  ) : (
                    <button type="button" onClick={() => makeDefault(proj)} disabled={saving} className="shrink-0 text-[10px] text-muted-foreground hover:text-foreground">
                      make default
                    </button>
                  ))}
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-[11px] text-muted-foreground">
        The default board powers the Board and PRs-by-task views. Only the link is stored; issues, PRs and cards are always fetched live.
      </p>
    </div>
  );
}
