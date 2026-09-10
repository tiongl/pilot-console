import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, X, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import type { GitHubBoardColumn, GitHubBoardItem } from '@/types';

const DONE_RE = /done|closed|complete|shipped/i;

/** Find the column that represents "done" (by name), else the last column. */
export function findDoneColumn(columns: GitHubBoardColumn[]): GitHubBoardColumn | null {
  return columns.find((c) => DONE_RE.test(c.name)) ?? (columns.length ? columns[columns.length - 1] : null);
}

/** Items whose linked issue/PR is closed/merged but whose status isn't Done yet. */
export function closedNotDoneItems(items: GitHubBoardItem[], doneName: string | null): GitHubBoardItem[] {
  return items.filter((it) => {
    const closed =
      it.state === 'closed' || it.linkedPullRequests.some((pr) => pr.state === 'merged' || pr.state === 'closed');
    return closed && it.status !== doneName;
  });
}

/**
 * A repeatable prompt listing board items whose issue/PR has closed/merged but
 * that aren't in the Done column. The user picks which to move; it recomputes on
 * every refresh so newly-closed items reappear. Only shown when the view groups
 * by a single-select field that has a recognizable Done column.
 */
export function ReconcileDonePanel({
  consoleProjectId,
  ghProjectId,
  groupFieldId,
  columns,
  items,
  onRefresh,
}: {
  consoleProjectId: string;
  ghProjectId: string;
  groupFieldId: string | null;
  columns: GitHubBoardColumn[];
  items: GitHubBoardItem[];
  onRefresh: () => void;
}) {
  const doneColumn = useMemo(() => findDoneColumn(columns), [columns]);
  const candidates = useMemo(
    () => (groupFieldId && doneColumn ? closedNotDoneItems(items, doneColumn.name) : []),
    [items, groupFieldId, doneColumn],
  );

  const signature = candidates.map((c) => c.itemId).join(',');
  const [dismissed, setDismissed] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  // Reset selection + visibility whenever the candidate set changes (e.g. refresh).
  useEffect(() => {
    setSelected(new Set(candidates.map((c) => c.itemId)));
    setDismissed(false);
  }, [signature, candidates]);

  if (!groupFieldId || !doneColumn || candidates.length === 0 || dismissed) return null;

  const toggle = (id: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const moveSelected = async () => {
    setBusy(true);
    const base = `/api/projects/${encodeURIComponent(consoleProjectId)}/github`;
    const ids = candidates.filter((c) => selected.has(c.itemId));
    let ok = 0;
    for (const item of ids) {
      try {
        const res = await fetch(`${base}/board/item/move`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ghProjectId, itemId: item.itemId, fieldId: groupFieldId, optionId: doneColumn.id }),
        });
        if (res.ok) ok += 1;
      } catch {
        // continue; summary reported below
      }
    }
    setBusy(false);
    if (ok > 0) toast.success(`Moved ${ok} item${ok === 1 ? '' : 's'} to ${doneColumn.name}`);
    if (ok < ids.length) toast.error(`${ids.length - ok} item(s) could not be moved`);
    onRefresh();
  };

  return (
    <div className="mb-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 font-medium">
          <CheckCircle2 className="h-4 w-4 text-amber-600" />
          {candidates.length} item{candidates.length === 1 ? '' : 's'} closed but not in &ldquo;{doneColumn.name}&rdquo;
        </div>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="rounded p-0.5 text-muted-foreground hover:text-foreground"
          title="Dismiss (reappears on next refresh)"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto">
        {candidates.map((it) => (
          <li key={it.itemId} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={selected.has(it.itemId)}
              onChange={() => toggle(it.itemId)}
              className="h-3.5 w-3.5"
            />
            <span className="min-w-0 flex-1 truncate text-xs">
              {it.title}
              {it.number != null && <span className="ml-1 text-muted-foreground">#{it.number}</span>}
              {it.status && <span className="ml-1 text-muted-foreground">({it.status})</span>}
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex justify-end">
        <Button size="sm" onClick={moveSelected} disabled={busy || selected.size === 0}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
          Move {selected.size} to {doneColumn.name}
        </Button>
      </div>
    </div>
  );
}
