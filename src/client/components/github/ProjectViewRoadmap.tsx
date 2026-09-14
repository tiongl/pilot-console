import { Play, Loader2 } from 'lucide-react';
import type { GitHubBoardItem } from '@/types';

const DAY_MS = 86_400_000;

function parseDate(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * A simple timeline rendering of a Projects V2 roadmap view. Items with a
 * start/target date are laid out as bars over the overall time range; items
 * without dates are listed below.
 */
export function ProjectViewRoadmap({
  items,
  onStartSession,
  startingIssue,
}: {
  items: GitHubBoardItem[];
  onStartSession: (issueNumber: number) => void;
  startingIssue: number | null;
}) {
  const dated = items
    .map((it) => {
      const start = parseDate(it.startDate);
      const target = parseDate(it.targetDate);
      if (start == null && target == null) return null;
      const s = start ?? target!;
      const e = target ?? start!;
      return { item: it, start: Math.min(s, e), end: Math.max(s, e) };
    })
    .filter((v): v is { item: GitHubBoardItem; start: number; end: number } => v !== null)
    .sort((a, b) => a.start - b.start);

  const undated = items.filter((it) => parseDate(it.startDate) == null && parseDate(it.targetDate) == null);

  if (dated.length === 0) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        <p>No items in this roadmap have a start or target date, so there is nothing to plot on a timeline.</p>
        {undated.length > 0 && <UndatedList items={undated} onStartSession={onStartSession} startingIssue={startingIssue} />}
      </div>
    );
  }

  const min = Math.min(...dated.map((d) => d.start));
  const max = Math.max(...dated.map((d) => d.end));
  const span = Math.max(max - min, DAY_MS);
  const pct = (t: number) => ((t - min) / span) * 100;
  const fmt = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  return (
    <div className="h-full overflow-auto p-4">
      <div className="mb-2 flex justify-between text-xs text-muted-foreground">
        <span>{fmt(min)}</span>
        <span>{fmt(max)}</span>
      </div>
      <div className="space-y-1.5">
        {dated.map(({ item, start, end }) => {
          const left = pct(start);
          const width = Math.max(pct(end) - left, 2);
          return (
            <div key={item.itemId} className="group flex items-center gap-2">
              <div className="w-48 shrink-0 truncate text-xs">
                {item.url ? (
                  <a href={item.url} target="_blank" rel="noreferrer" className="hover:underline">
                    {item.title}
                  </a>
                ) : (
                  item.title
                )}
                {item.number != null && <span className="ml-1 text-muted-foreground">#{item.number}</span>}
              </div>
              <div className="relative h-5 flex-1 rounded bg-muted/40">
                <div
                  className="absolute top-0 h-5 rounded bg-primary/70"
                  style={{ left: `${left}%`, width: `${width}%` }}
                  title={`${fmt(start)} → ${fmt(end)}`}
                />
              </div>
              {item.contentType === 'Issue' && item.number != null && (
                <button
                  type="button"
                  onClick={() => onStartSession(item.number!)}
                  disabled={startingIssue === item.number}
                  className="shrink-0 rounded border p-1 text-muted-foreground opacity-0 transition-opacity hover:text-primary group-hover:opacity-100 disabled:opacity-50"
                  title="Start / resume Copilot session for this issue"
                >
                  {startingIssue === item.number ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {undated.length > 0 && <UndatedList items={undated} onStartSession={onStartSession} startingIssue={startingIssue} />}
    </div>
  );
}

function UndatedList({
  items,
  onStartSession,
  startingIssue,
}: {
  items: GitHubBoardItem[];
  onStartSession: (issueNumber: number) => void;
  startingIssue: number | null;
}) {
  return (
    <div className="mt-6">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">No dates</p>
      <ul className="space-y-1">
        {items.map((it) => (
          <li key={it.itemId} className="flex items-center gap-2 text-xs">
            <span className="flex-1 truncate">
              {it.title}
              {it.number != null && <span className="ml-1 text-muted-foreground">#{it.number}</span>}
            </span>
            {it.contentType === 'Issue' && it.number != null && (
              <button
                type="button"
                onClick={() => onStartSession(it.number!)}
                disabled={startingIssue === it.number}
                className="rounded border p-1 text-muted-foreground hover:text-primary disabled:opacity-50"
                title="Start / resume Copilot session for this issue"
              >
                {startingIssue === it.number ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
