'use client';

import { useEffect, useState, useCallback } from 'react';
import { GitBranch, FileCode, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

interface GitFile {
  status: string;
  path: string;
}

interface Props {
  projectId: string;
}

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  'M': { label: 'Modified', color: 'text-yellow-500' },
  'A': { label: 'Added', color: 'text-green-500' },
  'D': { label: 'Deleted', color: 'text-red-500' },
  '??': { label: 'Untracked', color: 'text-blue-500' },
  'R': { label: 'Renamed', color: 'text-purple-500' },
  'C': { label: 'Copied', color: 'text-cyan-500' },
  'U': { label: 'Unmerged', color: 'text-orange-500' },
};

export default function GitPanel({ projectId }: Props) {
  const [branch, setBranch] = useState('');
  const [files, setFiles] = useState<GitFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch(`/api/projects/${projectId}/git-status`);
      if (res.ok) {
        const data = await res.json();
        setBranch(data.branch);
        setFiles(data.files);
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to fetch git status');
      }
    } catch {
      setError('Failed to connect');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 10000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const viewDiff = async (filePath: string) => {
    if (expandedFile === filePath) {
      setExpandedFile(null);
      setDiff(null);
      return;
    }
    setExpandedFile(filePath);
    setDiffLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/git-diff?file=${encodeURIComponent(filePath)}`);
      if (res.ok) {
        const data = await res.json();
        setDiff(data.diff);
      }
    } catch {
      setDiff('Failed to load diff');
    } finally {
      setDiffLoading(false);
    }
  };

  const getStatusInfo = (status: string) => STATUS_LABELS[status] || { label: status, color: 'text-muted-foreground' };

  if (loading) return <div className="p-4 text-xs text-muted-foreground">Loading git status…</div>;

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b flex items-center gap-2">
        <GitBranch className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Git</h3>
        <Badge variant="outline" className="text-xs ml-1">{branch}</Badge>
        <Button variant="ghost" size="icon" className="h-6 w-6 ml-auto" onClick={fetchStatus} title="Refresh">
          <RefreshCw className="h-3 w-3" />
        </Button>
      </div>

      {error ? (
        <div className="p-3 text-xs text-destructive">{error}</div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {files.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4">Working tree clean</p>
          ) : (
            <div className="divide-y">
              {files.map(f => {
                const info = getStatusInfo(f.status);
                const isExpanded = expandedFile === f.path;
                return (
                  <div key={f.path}>
                    <div
                      className="px-3 py-1.5 hover:bg-accent/50 cursor-pointer flex items-center gap-2"
                      onClick={() => viewDiff(f.path)}
                    >
                      {isExpanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                      <FileCode className={`h-3.5 w-3.5 shrink-0 ${info.color}`} />
                      <span className="text-xs truncate flex-1 font-mono">{f.path}</span>
                      <span className={`text-xs shrink-0 ${info.color}`}>{info.label}</span>
                    </div>
                    {isExpanded && (
                      <div className="bg-muted/30 border-t">
                        {diffLoading ? (
                          <p className="px-4 py-2 text-xs text-muted-foreground">Loading diff…</p>
                        ) : (
                          <pre className="px-4 py-2 text-xs font-mono overflow-x-auto whitespace-pre max-h-64 overflow-y-auto">
                            {diff?.split('\n').map((line, i) => {
                              let color = '';
                              if (line.startsWith('+') && !line.startsWith('+++')) color = 'text-green-500';
                              else if (line.startsWith('-') && !line.startsWith('---')) color = 'text-red-500';
                              else if (line.startsWith('@@')) color = 'text-blue-400';
                              return <div key={i} className={color}>{line}</div>;
                            })}
                          </pre>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <div className="px-3 py-2 border-t">
            <p className="text-xs text-muted-foreground">{files.length} changed file{files.length !== 1 ? 's' : ''}</p>
          </div>
        </div>
      )}
    </div>
  );
}
