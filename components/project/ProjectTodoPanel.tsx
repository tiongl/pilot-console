'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Plus, Trash2, ChevronRight, ChevronDown, Download } from 'lucide-react';

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
}

export default function ProjectTodoPanel({ projectId, projectName }: Props) {
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [newText, setNewText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

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
    const md = `# Project Notes\n\n${buildMarkdown(rootItems)}\n`;

    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${projectName || 'project'}-notes.md`;
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
        <div className="group flex items-center gap-1 py-0.5 hover:bg-accent/50 rounded px-1">
          {/* Expand/collapse toggle */}
          <button
            className="h-4 w-4 shrink-0 flex items-center justify-center text-muted-foreground"
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
            className="h-3.5 w-3.5 shrink-0 rounded border-muted-foreground/50"
          />

          {/* Text — editable on blur */}
          <input
            type="text"
            defaultValue={todo.text}
            onBlur={(e) => {
              if (e.target.value !== todo.text) updateTodo(todo.id, { text: e.target.value });
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
            className={`flex-1 bg-transparent text-xs outline-none border-none px-1 min-w-0 ${todo.done ? 'line-through text-muted-foreground' : ''}`}
          />

          {/* Actions */}
          <div className="hidden group-hover:flex items-center gap-0.5 shrink-0">
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
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b flex items-center gap-2">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Notes</h3>
        {todos.length > 0 && (
          <Button variant="ghost" size="icon" className="h-6 w-6 ml-auto" onClick={exportToMarkdown} title="Export as Markdown">
            <Download className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-0">
        {rootTodos.map(todo => renderTodo(todo))}
        {todos.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-4">No notes yet</p>
        )}
      </div>
      <div className="border-t px-2 py-2">
        <form onSubmit={(e) => { e.preventDefault(); addTodo(); }} className="flex gap-1">
          <Input
            ref={inputRef}
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            placeholder="Add a note..."
            className="h-7 text-xs"
          />
          <Button type="submit" size="icon" variant="ghost" className="h-7 w-7 shrink-0" disabled={!newText.trim()}>
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </form>
      </div>
    </div>
  );
}
