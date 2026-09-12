'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Plus, Trash2, ChevronRight, ChevronDown, Download, Copy, Check } from 'lucide-react';

interface TodoItem {
  id: string;
  projectId: string;
  parentId: string | null;
  text: string;
  done: number;
  position: number;
  createdAt: string;
}

interface Props {
  projectId: string;
  projectName?: string;
  /**
   * Poll interval in ms. The Project Lead edits this same list through its own
   * tools, so a panel that only loaded once would show a stale plan.
   */
  pollMs?: number;
}

export default function ProjectTodoPanel({ projectId, projectName, pollMs = 8000 }: Props) {
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [newText, setNewText] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const copyTodo = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const fetchTodos = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/todos`);
      if (res.ok) {
        const data = await res.json();
        setTodos(data.todos);
      }
    } catch {}
  }, [projectId]);

  useEffect(() => { fetchTodos(); }, [fetchTodos]);

  // Text boxes are uncontrolled and keyed on their text, so applying a poll
  // while the user is typing would remount the box out from under them and
  // lose the edit. Skip those rounds; the next one picks the changes up.
  useEffect(() => {
    if (!pollMs) return;
    const timer = setInterval(() => {
      const active = document.activeElement;
      if (active && rootRef.current?.contains(active)) return;
      void fetchTodos();
    }, pollMs);
    return () => clearInterval(timer);
  }, [fetchTodos, pollMs]);

  const addTodo = async (parentId: string | null = null) => {
    const text = parentId ? '' : newText.trim();
    if (!parentId && !text) return;

    await fetch(`/api/projects/${projectId}/todos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text || 'New item', parentId }),
    });
    if (!parentId) setNewText('');
    // Expand parent if adding child
    if (parentId) {
      setCollapsed(prev => {
        const next = new Set(prev);
        next.delete(parentId);
        return next;
      });
    }
    fetchTodos();
  };

  const updateTodo = async (id: string, updates: Partial<{ text: string; done: boolean; parentId: string | null }>) => {
    await fetch(`/api/projects/${projectId}/todos/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    fetchTodos();
  };

  const deleteTodo = async (id: string) => {
    await fetch(`/api/projects/${projectId}/todos/${id}`, { method: 'DELETE' });
    fetchTodos();
  };

  const toggleCollapse = (id: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const exportToMarkdown = () => {
    const buildMarkdown = (items: TodoItem[], depth: number = 0): string => {
      return items.map(item => {
        const indent = '  '.repeat(depth);
        const checkbox = item.done ? '[x]' : '[ ]';
        const line = `${indent}- ${checkbox} ${item.text}`;
        const children = todos.filter(t => t.parentId === item.id);
        if (children.length > 0) {
          return line + '\n' + buildMarkdown(children, depth + 1);
        }
        return line;
      }).join('\n');
    };

    const rootItems = todos.filter(t => !t.parentId);
    const md = `# Project TODOs\n\n${buildMarkdown(rootItems)}\n`;

    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${projectName || 'project'}-todos.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Build tree structure
  const rootTodos = todos.filter(t => !t.parentId);
  const childrenOf = (parentId: string) => todos.filter(t => t.parentId === parentId);

  const renderTodo = (todo: TodoItem, depth: number = 0) => {
    const children = childrenOf(todo.id);
    const hasChildren = children.length > 0;
    const isCollapsed = collapsed.has(todo.id);

    return (
      <div key={todo.id} style={{ paddingLeft: depth * 16 }}>
        <div className="group flex items-start gap-1 py-0.5 hover:bg-accent/50 rounded px-1">
          {/* Expand/collapse toggle */}
          <button
            className="h-5 w-4 shrink-0 flex items-center justify-center text-muted-foreground mt-0.5"
            onClick={() => hasChildren && toggleCollapse(todo.id)}
          >
            {hasChildren ? (
              isCollapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
            ) : (
              <span className="h-3 w-3" />
            )}
          </button>

          {/* Checkbox */}
          <input
            type="checkbox"
            checked={!!todo.done}
            onChange={(e) => updateTodo(todo.id, { done: e.target.checked })}
            className="h-3.5 w-3.5 shrink-0 rounded border-muted-foreground/50 mt-1"
          />

          {/* Text — multi-line, auto-resize. Keyed on the text so an edit made
              elsewhere (the lead's tools, the other panel) is picked up; the
              poll never lands while this box has focus, so it cannot clobber
              what the user is typing. */}
          <textarea
            key={todo.text}
            defaultValue={todo.text}
            rows={1}
            data-testid={`todo-text-${todo.id}`}
            onBlur={(e) => {
              // An empty box is an accidental clear, not a request to store a
              // blank row: the server rejects it, so restore what was there.
              if (!e.target.value.trim()) { e.target.value = todo.text; return; }
              if (e.target.value !== todo.text) updateTodo(todo.id, { text: e.target.value });
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); }
            }}
            onInput={(e) => {
              const el = e.target as HTMLTextAreaElement;
              el.style.height = 'auto';
              el.style.height = el.scrollHeight + 'px';
            }}
            ref={(el) => {
              if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; }
            }}
            className={`flex-1 bg-transparent text-xs outline-none border-none px-1 min-w-0 resize-none overflow-hidden leading-5 ${todo.done ? 'line-through text-muted-foreground' : ''}`}
          />

          {/* Actions */}
          <div className="hidden group-hover:flex items-center gap-0.5 shrink-0 mt-0.5">
            <button
              onClick={() => copyTodo(todo.text, todo.id)}
              className="h-5 w-5 flex items-center justify-center text-muted-foreground hover:text-foreground rounded"
              title="Copy"
            >
              {copiedId === todo.id ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
            </button>
            <button
              onClick={() => addTodo(todo.id)}
              className="h-5 w-5 flex items-center justify-center text-muted-foreground hover:text-foreground rounded"
              title="Add sub-item"
            >
              <Plus className="h-3 w-3" />
            </button>
            <button
              onClick={() => deleteTodo(todo.id)}
              className="h-5 w-5 flex items-center justify-center text-muted-foreground hover:text-destructive rounded"
              title="Delete"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        </div>

        {/* Children */}
        {hasChildren && !isCollapsed && children.map(child => renderTodo(child, depth + 1))}
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full" ref={rootRef} data-testid="todo-panel">
      <div className="px-3 py-2 border-b flex items-center gap-2">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">TODO Prompt</h3>
        {todos.length > 0 && (
          <Button variant="ghost" size="icon" className="h-6 w-6 ml-auto" onClick={exportToMarkdown} title="Export as Markdown">
            <Download className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-0">
        {rootTodos.map(todo => renderTodo(todo))}
        {todos.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-4">No todos yet</p>
        )}
      </div>
      <div className="border-t px-2 py-2">
        <form onSubmit={(e) => { e.preventDefault(); addTodo(); }} className="flex gap-1">
          <textarea
            ref={inputRef}
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addTodo(); } }}
            onInput={(e) => { const el = e.target as HTMLTextAreaElement; el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 80) + 'px'; }}
            placeholder="Add a note..."
            rows={1}
            className="flex-1 bg-transparent text-xs outline-none border border-input rounded px-2 py-1.5 min-w-0 resize-none overflow-hidden leading-5"
          />
          <Button type="submit" size="icon" variant="ghost" className="h-7 w-7 shrink-0" disabled={!newText.trim()}>
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </form>
      </div>
    </div>
  );
}
