'use client';

import { useEffect, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Bookmark, Plus, Trash2, Send, X, Copy, Check } from 'lucide-react';

interface Snippet {
  id: string;
  projectId: string | null;
  title: string;
  content: string;
  createdAt: string;
}

interface Props {
  projectId: string;
  onInsert?: (text: string) => void;
}

export default function SnippetPanel({ projectId, onInsert }: Props) {
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const copySnippet = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const fetchSnippets = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/snippets`);
      if (res.ok) {
        const data = await res.json();
        setSnippets(data.snippets);
      }
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { fetchSnippets(); }, [fetchSnippets]);

  const addSnippet = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !content.trim()) return;
    await fetch(`/api/projects/${projectId}/snippets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title.trim(), content: content.trim() }),
    });
    setTitle('');
    setContent('');
    setShowAdd(false);
    fetchSnippets();
  };

  const deleteSnippet = async (id: string) => {
    if (!confirm('Delete this snippet?')) return;
    await fetch(`/api/snippets/${id}`, { method: 'DELETE' });
    fetchSnippets();
  };

  if (loading) return <div className="p-4 text-xs text-muted-foreground">Loading…</div>;

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b flex items-center gap-2">
        <Bookmark className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Snippets</h3>
        <Button variant="ghost" size="icon" className="h-6 w-6 ml-auto" onClick={() => setShowAdd(!showAdd)} title="Add snippet">
          {showAdd ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
        </Button>
      </div>

      {showAdd && (
        <div className="p-3 border-b bg-muted/20">
          <form onSubmit={addSnippet} className="space-y-2">
            <Input value={title} onChange={e => setTitle(e.target.value)} placeholder="Title" className="h-7 text-xs" required />
            <Textarea value={content} onChange={e => setContent(e.target.value)} placeholder="Prompt or command..." rows={3} className="text-xs font-mono resize-none" required />
            <div className="flex gap-1">
              <Button type="submit" size="sm" className="h-7 text-xs">Save</Button>
              <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setShowAdd(false)}>Cancel</Button>
            </div>
          </form>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {snippets.length === 0 && !showAdd ? (
          <p className="text-xs text-muted-foreground text-center py-4">No snippets yet</p>
        ) : (
          <div className="divide-y">
            {snippets.map(s => (
              <div key={s.id} className="group px-3 py-2 hover:bg-accent/50">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium truncate">{s.title}</span>
                  <div className="hidden group-hover:flex items-center gap-0.5">
                      <button onClick={() => copySnippet(s.content, s.id)} className="h-5 w-5 flex items-center justify-center text-muted-foreground hover:text-foreground" title="Copy">
                        {copiedId === s.id ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
                      </button>
                      {onInsert && (
                      <button onClick={() => onInsert(s.content)} className="h-5 w-5 flex items-center justify-center text-muted-foreground hover:text-foreground" title="Insert into terminal">
                        <Send className="h-3 w-3" />
                      </button>
                    )}
                    <button onClick={() => deleteSnippet(s.id)} className="h-5 w-5 flex items-center justify-center text-muted-foreground hover:text-destructive" title="Delete">
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>
                <pre className="text-xs text-muted-foreground font-mono mt-1 whitespace-pre-wrap line-clamp-2">{s.content}</pre>
                {!s.projectId && <span className="text-xs text-blue-400 mt-0.5 block">global</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
