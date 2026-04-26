'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { FolderOpen, ChevronRight, ArrowUp, GitBranch, Check } from 'lucide-react';

interface BrowseResult {
  path: string;
  dirs: string[];
  isGitRepo: boolean;
  parent: string;
}

interface Props {
  value: string;
  onChange: (path: string) => void;
}

export default function FolderPicker({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<BrowseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const browse = useCallback(async (dir?: string) => {
    setLoading(true);
    setError('');
    try {
      const params = dir ? `?dir=${encodeURIComponent(dir)}` : '';
      const res = await fetch(`/api/browse${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setCurrent(data as BrowseResult);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open && !current) {
      browse(value || undefined);
    }
  }, [open, current, browse, value]);

  const handleSelect = () => {
    if (current) {
      onChange(current.path);
      setOpen(false);
    }
  };

  const handleNavigate = (subdir: string) => {
    if (current) {
      const newPath = current.path + (current.path.endsWith('\\') || current.path.endsWith('/') ? '' : '\\') + subdir;
      browse(newPath);
    }
  };

  if (!open) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        className="shrink-0"
      >
        <FolderOpen className="h-4 w-4 mr-1" />
        Browse
      </Button>
    );
  }

  return (
    <div className="border rounded-lg bg-background shadow-md">
      {/* Header */}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => current && browse(current.parent)}
          disabled={loading || !current || current.path === current.parent}
          className="h-7 w-7 p-0"
          title="Go up"
        >
          <ArrowUp className="h-4 w-4" />
        </Button>
        <code className="text-xs truncate flex-1">{current?.path ?? '...'}</code>
        {current?.isGitRepo && (
          <span className="flex items-center gap-1 text-xs text-green-600" title="Git repository">
            <GitBranch className="h-3 w-3" /> git
          </span>
        )}
      </div>

      {/* Directory list */}
      <div className="max-h-60 overflow-y-auto">
        {loading && <p className="px-3 py-4 text-xs text-muted-foreground text-center">Loading…</p>}
        {error && <p className="px-3 py-4 text-xs text-destructive text-center">{error}</p>}
        {current && !loading && current.dirs.length === 0 && (
          <p className="px-3 py-4 text-xs text-muted-foreground text-center">No subdirectories</p>
        )}
        {current && !loading && current.dirs.map((dir) => (
          <button
            key={dir}
            type="button"
            onClick={() => handleNavigate(dir)}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-sm hover:bg-accent text-left transition-colors"
          >
            <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{dir}</span>
            <ChevronRight className="h-3 w-3 ml-auto shrink-0 text-muted-foreground" />
          </button>
        ))}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-end gap-2 border-t px-3 py-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button type="button" size="sm" onClick={handleSelect} disabled={!current}>
          <Check className="h-4 w-4 mr-1" />
          Select This Folder
        </Button>
      </div>
    </div>
  );
}
