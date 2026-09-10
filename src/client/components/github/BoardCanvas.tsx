import { useEffect, useMemo, useState } from 'react';
import { Plus, X, Pencil, Play, Loader2 } from 'lucide-react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import { LabelChip } from '../../pages/ProjectIssuesPage';
import { IssueEditDialog } from './IssueEditDialog';
import type { GitHubBoardColumn, GitHubBoardItem } from '@/types';

const NO_STATUS = '__no_status__';

export interface BoardCanvasProps {
  /** Console project id (for API base). */
  consoleProjectId: string;
  /** GitHub Projects V2 node id. */
  ghProjectId: string;
  /** Single-select field id used for the columns; null disables editing. */
  groupFieldId: string | null;
  columns: GitHubBoardColumn[];
  items: GitHubBoardItem[];
  onRefresh: () => void;
  onStartSession: (issueNumber: number) => void;
  startingIssue: number | null;
}

/** A kanban rendering of a Projects V2 view, grouped by a single-select field. */
export function BoardCanvas({
  consoleProjectId,
  ghProjectId,
  groupFieldId,
  columns: groupColumns,
  items: initialItems,
  onRefresh,
  onStartSession,
  startingIssue,
}: BoardCanvasProps) {
  const [items, setItems] = useState<GitHubBoardItem[]>(initialItems);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingItem, setEditingItem] = useState<GitHubBoardItem | null>(null);
  useEffect(() => setItems(initialItems), [initialItems]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const editable = groupFieldId != null;
  const base = `/api/projects/${encodeURIComponent(consoleProjectId)}/github`;

  const columns = useMemo(() => [...groupColumns, { id: NO_STATUS, name: 'No Status' }], [groupColumns]);
  const itemsByStatus = (name: string) =>
    items.filter((it) => (name === 'No Status' ? it.status === null : it.status === name));

  const activeItem = items.find((it) => it.itemId === activeId) ?? null;
  const onDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id));

  const onDragEnd = async (e: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = e;
    if (!over || !groupFieldId) return;
    const itemId = String(active.id);
    const targetColId = String(over.id);
    const item = items.find((it) => it.itemId === itemId);
    if (!item) return;
    const targetName = targetColId === NO_STATUS ? null : groupColumns.find((c) => c.id === targetColId)?.name ?? null;
    if (item.status === targetName) return;
    const optionId = targetColId === NO_STATUS ? null : targetColId;
    const prevStatus = item.status;
    setItems((cur) => cur.map((it) => (it.itemId === itemId ? { ...it, status: targetName } : it)));
    try {
      const res = await fetch(`${base}/board/item/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ghProjectId, itemId, fieldId: groupFieldId, optionId }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Move failed (${res.status})`);
    } catch (err) {
      setItems((cur) => cur.map((it) => (it.itemId === itemId ? { ...it, status: prevStatus } : it)));
      toast.error((err as Error).message);
      onRefresh();
    }
  };

  const createCard = async (columnId: string, title: string) => {
    setBusy(true);
    try {
      const optionId = columnId === NO_STATUS ? null : columnId;
      const res = await fetch(`${base}/board/item/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ghProjectId, statusFieldId: groupFieldId, optionId, title }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Create failed (${res.status})`);
      toast.success('Issue created');
      onRefresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const removeCard = async (item: GitHubBoardItem) => {
    if (!confirm(`Remove "${item.title}" from the board? The issue/PR itself will not be deleted.`)) return;
    const snapshot = items;
    setItems((cur) => cur.filter((it) => it.itemId !== item.itemId));
    try {
      const res = await fetch(`${base}/board/item`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ghProjectId, itemId: item.itemId }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Remove failed (${res.status})`);
    } catch (err) {
      setItems(snapshot);
      toast.error((err as Error).message);
    }
  };

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
      <div className="flex h-full gap-3 overflow-x-auto pb-2">
        {columns.map((col) => {
          const colItems = itemsByStatus(col.name);
          if (col.name === 'No Status' && colItems.length === 0) return null;
          return (
            <Column
              key={col.id}
              id={col.id}
              name={col.name}
              count={colItems.length}
              editable={editable}
              busy={busy}
              onCreate={(title) => createCard(col.id, title)}
            >
              {colItems.map((item) => (
                <Card
                  key={item.itemId}
                  item={item}
                  editable={editable}
                  dragging={activeId === item.itemId}
                  starting={startingIssue === item.number}
                  onEdit={() => setEditingItem(item)}
                  onRemove={() => removeCard(item)}
                  onStartSession={onStartSession}
                />
              ))}
            </Column>
          );
        })}
      </div>
      <DragOverlay>{activeItem ? <Card item={activeItem} editable={false} dragging /> : null}</DragOverlay>

      <IssueEditDialog
        open={editingItem != null}
        onOpenChange={(open) => {
          if (!open) setEditingItem(null);
        }}
        consoleProjectId={consoleProjectId}
        ghProjectId={ghProjectId}
        item={editingItem}
        columns={groupColumns}
        groupFieldId={groupFieldId}
        onSaved={onRefresh}
      />
    </DndContext>
  );
}

function Column({
  id,
  name,
  count,
  editable,
  busy,
  onCreate,
  children,
}: {
  id: string;
  name: string;
  count: number;
  editable: boolean;
  busy?: boolean;
  onCreate?: (title: string) => void;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id, disabled: !editable });
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');

  const submit = () => {
    const t = title.trim();
    if (!t || !onCreate) return;
    onCreate(t);
    setTitle('');
    setAdding(false);
  };

  return (
    <div
      ref={setNodeRef}
      className={`flex w-72 shrink-0 flex-col rounded-lg transition-colors ${isOver ? 'bg-primary/10 ring-1 ring-primary/40' : 'bg-muted/40'}`}
    >
      <div className="flex items-center justify-between px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <span>{name}</span>
        <span className="rounded-full bg-background px-1.5 py-0.5">{count}</span>
      </div>
      <div className="flex flex-col gap-2 overflow-y-auto px-2 pb-2">
        {children}
        {editable &&
          (adding ? (
            <div className="rounded-md border bg-card p-2">
              <Textarea
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    submit();
                  }
                  if (e.key === 'Escape') setAdding(false);
                }}
                placeholder="Issue title…"
                rows={2}
                className="text-sm"
              />
              <div className="mt-2 flex items-center gap-2">
                <Button size="xs" onClick={submit} disabled={busy || !title.trim()}>
                  Add
                </Button>
                <Button size="xs" variant="ghost" onClick={() => setAdding(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-background hover:text-foreground"
            >
              <Plus className="h-3.5 w-3.5" /> Add card
            </button>
          ))}
      </div>
    </div>
  );
}

function Card({
  item,
  editable,
  dragging,
  starting,
  onEdit,
  onRemove,
  onStartSession,
}: {
  item: GitHubBoardItem;
  editable: boolean;
  dragging: boolean;
  starting?: boolean;
  onEdit?: () => void;
  onRemove?: () => void;
  onStartSession?: (issueNumber: number) => void;
}) {
  const { attributes, listeners, setNodeRef } = useDraggable({ id: item.itemId, disabled: !editable });
  const canEdit = editable && item.number != null && onEdit;
  const canStart = item.contentType === 'Issue' && item.number != null && onStartSession;

  return (
    <div
      ref={setNodeRef}
      {...(editable ? { ...listeners, ...attributes } : {})}
      className={`group relative rounded-md border bg-card p-2.5 text-sm shadow-sm ${editable ? 'cursor-grab active:cursor-grabbing' : ''} ${dragging ? 'opacity-50' : ''}`}
    >
      {(canEdit || onRemove || canStart) && (
        <div className="absolute right-1 top-1 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          {canStart && (
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onStartSession?.(item.number!)}
              disabled={starting}
              className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-primary disabled:opacity-50"
              title="Start / resume Copilot session for this issue"
            >
              {starting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onEdit?.()}
              className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              title="Edit"
            >
              <Pencil className="h-3 w-3" />
            </button>
          )}
          {onRemove && (
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={onRemove}
              className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-destructive"
              title="Remove from board"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      )}
      {item.url ? (
        <a href={item.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="font-medium hover:underline">
          {item.title}
        </a>
      ) : (
        <span className="font-medium">{item.title}</span>
      )}
      {item.number != null && <span className="ml-1 text-xs text-muted-foreground">#{item.number}</span>}
      {item.labels.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {item.labels.map((l) => (
            <LabelChip key={l.name} name={l.name} color={l.color} />
          ))}
        </div>
      )}
      <div className="mt-1.5 flex items-center justify-between text-[10px] text-muted-foreground">
        <span>{item.contentType === 'PullRequest' ? 'PR' : item.contentType === 'DraftIssue' ? 'Draft' : 'Issue'}</span>
        {item.assignees.length > 0 && <span>@{item.assignees.map((a) => a.login).join(', @')}</span>}
      </div>
    </div>
  );
}
