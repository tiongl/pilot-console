'use client';

import { useCallback, useEffect, useState } from 'react';
import { GitCommit, ChevronDown, ChevronRight, FileCode, Copy, Check, Loader2 } from 'lucide-react';
import DiffViewer from './DiffViewer';

interface Commit {
  hash: string;
  shortHash: string;
  author: string;
  authorEmail: string;
  date: string;
  message: string;
}

interface CommitFile {
  status: string;
  path: string;
}

interface CommitDetail {
  hash: string;
  shortHash: string;
  author: string;
  authorEmail: string;
  date: string;
  message: string;
  files: CommitFile[];
}

interface Props {
  projectId: string;
}

const FILE_STATUS_LABELS: Record<string, { label: string; color: string }> = {
  M: { label: 'Modified', color: 'text-yellow-500' },
  A: { label: 'Added', color: 'text-green-500' },
  D: { label: 'Deleted', color: 'text-red-500' },
  R: { label: 'Renamed', color: 'text-purple-500' },
  C: { label: 'Copied', color: 'text-cyan-500' },
};

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export default function GitLogTab({ projectId }: Props) {
  const [commits, setCommits] = useState<Commit[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Expanded commit state
  const [expandedHash, setExpandedHash] = useState<string | null>(null);
  const [commitDetail, setCommitDetail] = useState<CommitDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // File diff state
  const [diffFile, setDiffFile] = useState<string | null>(null);
  const [diffContent, setDiffContent] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

  // Copy hash feedback
  const [copiedHash, setCopiedHash] = useState<string | null>(null);

  const fetchLog = useCallback(async (pageNum: number, append: boolean) => {
    if (append) setLoadingMore(true); else setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/git-log?page=${pageNum}&limit=30`);
      if (res.ok) {
        const data = await res.json();
        setCommits(prev => append ? [...prev, ...data.commits] : data.commits);
        setHasMore(data.hasMore);
        setPage(pageNum);
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to load git log');
      }
    } catch {
      setError('Failed to connect');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [projectId]);

  useEffect(() => { fetchLog(1, false); }, [fetchLog]);

  const toggleCommit = async (hash: string) => {
    if (expandedHash === hash) {
      setExpandedHash(null);
      setCommitDetail(null);
      setDiffFile(null);
      setDiffContent(null);
      return;
    }
    setExpandedHash(hash);
    setDiffFile(null);
    setDiffContent(null);
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/git-commit/${hash}`);
      if (res.ok) {
        setCommitDetail(await res.json());
      }
    } catch {
      setCommitDetail(null);
    } finally {
      setDetailLoading(false);
    }
  };

  const viewFileDiff = async (hash: string, filePath: string) => {
    if (diffFile === filePath) {
      setDiffFile(null);
      setDiffContent(null);
      return;
    }
    setDiffFile(filePath);
    setDiffLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/git-commit/${hash}/diff?file=${encodeURIComponent(filePath)}`);
      if (res.ok) {
        const data = await res.json();
        setDiffContent(data.diff);
      }
    } catch {
      setDiffContent(null);
    } finally {
      setDiffLoading(false);
    }
  };

  const copyHash = async (hash: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(hash);
      setCopiedHash(hash);
      setTimeout(() => setCopiedHash(null), 2000);
    } catch {}
  };

  const getFileStatus = (status: string) => FILE_STATUS_LABELS[status] || { label: status, color: 'text-muted-foreground' };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-sm">Loading git history…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-destructive">{error}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {commits.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">No commits found</p>
      ) : (
        <div className="divide-y">
          {commits.map(commit => {
            const isExpanded = expandedHash === commit.hash;
            return (
              <div key={commit.hash}>
                {/* Commit row */}
                <div
                  className="px-4 py-2.5 hover:bg-accent/50 cursor-pointer flex items-start gap-3"
                  onClick={() => toggleCommit(commit.hash)}
                >
                  {isExpanded
                    ? <ChevronDown className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
                    : <ChevronRight className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />}
                  <GitCommit className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm truncate">{commit.message}</p>
                    <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
                      <span>{commit.author}</span>
                      <span>·</span>
                      <span title={new Date(commit.date).toLocaleString()}>{relativeTime(commit.date)}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <code className="text-xs font-mono text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                      {commit.shortHash}
                    </code>
                    <button
                      onClick={(e) => copyHash(commit.hash, e)}
                      className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                      title="Copy full hash"
                    >
                      {copiedHash === commit.hash
                        ? <Check className="h-3 w-3 text-green-500" />
                        : <Copy className="h-3 w-3" />}
                    </button>
                  </div>
                </div>

                {/* Expanded commit detail */}
                {isExpanded && (
                  <div className="bg-muted/20 border-t px-4 py-3">
                    {detailLoading ? (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Loading commit details…
                      </div>
                    ) : commitDetail ? (
                      <div className="space-y-3">
                        {/* Full commit message */}
                        {commitDetail.message.includes('\n') && (
                          <pre className="text-xs whitespace-pre-wrap text-muted-foreground bg-muted/30 rounded p-2">
                            {commitDetail.message}
                          </pre>
                        )}

                        {/* Changed files */}
                        <div>
                          <p className="text-xs font-medium text-muted-foreground mb-1">
                            {commitDetail.files.length} file{commitDetail.files.length !== 1 ? 's' : ''} changed
                          </p>
                          <div className="divide-y border rounded">
                            {commitDetail.files.map(f => {
                              const info = getFileStatus(f.status);
                              const isFileDiffOpen = diffFile === f.path;
                              return (
                                <div key={f.path}>
                                  <div
                                    className="px-3 py-1.5 hover:bg-accent/30 cursor-pointer flex items-center gap-2"
                                    onClick={() => viewFileDiff(commit.hash, f.path)}
                                  >
                                    {isFileDiffOpen
                                      ? <ChevronDown className="h-3 w-3 shrink-0" />
                                      : <ChevronRight className="h-3 w-3 shrink-0" />}
                                    <FileCode className={`h-3.5 w-3.5 shrink-0 ${info.color}`} />
                                    <span className="text-xs font-mono truncate flex-1">{f.path}</span>
                                    <span className={`text-xs shrink-0 ${info.color}`}>{info.label}</span>
                                  </div>
                                  {isFileDiffOpen && (
                                    <div className="border-t bg-background max-h-96 overflow-y-auto">
                                      {diffLoading ? (
                                        <div className="flex items-center gap-2 px-4 py-2 text-xs text-muted-foreground">
                                          <Loader2 className="h-3 w-3 animate-spin" />
                                          Loading diff…
                                        </div>
                                      ) : (
                                        <DiffViewer diff={diffContent || ''} />
                                      )}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">Failed to load commit details</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Load more */}
      {hasMore && (
        <div className="px-4 py-3 border-t">
          <button
            onClick={() => fetchLog(page + 1, true)}
            disabled={loadingMore}
            className="w-full text-center text-sm text-muted-foreground hover:text-foreground py-2 rounded hover:bg-accent/50 transition-colors disabled:opacity-50"
          >
            {loadingMore ? (
              <span className="flex items-center justify-center gap-2">
                <Loader2 className="h-3 w-3 animate-spin" />
                Loading…
              </span>
            ) : (
              'Load more commits'
            )}
          </button>
        </div>
      )}
    </div>
  );
}
