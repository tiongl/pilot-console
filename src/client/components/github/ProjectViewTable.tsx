import { useState } from 'react';
import { Play, Loader2, Pencil } from 'lucide-react';
import { LabelChip } from '../../pages/ProjectIssuesPage';
import { IssueEditDialog } from './IssueEditDialog';
import type { GitHubBoardColumn, GitHubBoardItem } from '@/types';

/** A spreadsheet-style rendering of a Projects V2 table view. */
export function ProjectViewTable({
  consoleProjectId,
  ghProjectId,
  items,
  groupFieldName,
  groupFieldId,
  columns,
  onRefresh,
  onStartSession,
  startingIssue,
}: {
  consoleProjectId: string;
  ghProjectId: string;
  items: GitHubBoardItem[];
  groupFieldName: string | null;
  groupFieldId: string | null;
  columns: GitHubBoardColumn[];
  onRefresh: () => void;
  onStartSession: (issueNumber: number) => void;
  startingIssue: number | null;
}) {
  const [editingItem, setEditingItem] = useState<GitHubBoardItem | null>(null);

  // Extra field columns = union of field names across items, minus the group field.
  const extraFields = Array.from(
    items.reduce((set, it) => {
      Object.keys(it.fields).forEach((k) => {
        if (k !== groupFieldName) set.add(k);
      });
      return set;
    }, new Set<string>()),
  );

  if (items.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">No items in this view.</p>;
  }

  return (
    <div className="h-full overflow-auto">
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 z-10 bg-background">
          <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-3 py-2 font-medium">Title</th>
            <th className="px-3 py-2 font-medium">Type</th>
            {groupFieldName && <th className="px-3 py-2 font-medium">{groupFieldName}</th>}
            <th className="px-3 py-2 font-medium">Assignees</th>
            <th className="px-3 py-2 font-medium">Labels</th>
            {extraFields.map((f) => (
              <th key={f} className="px-3 py-2 font-medium">{f}</th>
            ))}
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <tr key={it.itemId} className="border-b hover:bg-accent/40">
              <td className="max-w-xs px-3 py-2">
                {it.url ? (
                  <a href={it.url} target="_blank" rel="noreferrer" className="font-medium hover:underline">
                    {it.title}
                  </a>
                ) : (
                  <span className="font-medium">{it.title}</span>
                )}
                {it.number != null && <span className="ml-1 text-xs text-muted-foreground">#{it.number}</span>}
              </td>
              <td className="px-3 py-2 text-xs text-muted-foreground">
                {it.contentType === 'PullRequest' ? 'PR' : it.contentType === 'DraftIssue' ? 'Draft' : 'Issue'}
              </td>
              {groupFieldName && (
                <td className="px-3 py-2">
                  {it.status ? (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{it.status}</span>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </td>
              )}
              <td className="px-3 py-2 text-xs text-muted-foreground">
                {it.assignees.length ? it.assignees.map((a) => `@${a.login}`).join(', ') : '—'}
              </td>
              <td className="px-3 py-2">
                {it.labels.length ? (
                  <div className="flex flex-wrap gap-1">
                    {it.labels.map((l) => (
                      <LabelChip key={l.name} name={l.name} color={l.color} />
                    ))}
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                )}
              </td>
              {extraFields.map((f) => (
                <td key={f} className="px-3 py-2 text-xs text-muted-foreground">{it.fields[f] ?? '—'}</td>
              ))}
              <td className="px-3 py-2 text-right">
                <div className="flex items-center justify-end gap-1">
                  {it.number != null && (
                    <button
                      type="button"
                      onClick={() => setEditingItem(it)}
                      className="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                      title="Edit"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                  )}
                  {it.contentType === 'Issue' && it.number != null && (
                    <button
                      type="button"
                      onClick={() => onStartSession(it.number!)}
                      disabled={startingIssue === it.number}
                      className="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs text-muted-foreground hover:text-primary disabled:opacity-50"
                      title="Start / resume Copilot session for this issue"
                    >
                      {startingIssue === it.number ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Play className="h-3 w-3" />
                      )}
                      Work
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <IssueEditDialog
        open={editingItem != null}
        onOpenChange={(open) => {
          if (!open) setEditingItem(null);
        }}
        consoleProjectId={consoleProjectId}
        ghProjectId={ghProjectId}
        item={editingItem}
        columns={columns}
        groupFieldId={groupFieldId}
        onSaved={onRefresh}
      />
    </div>
  );
}
