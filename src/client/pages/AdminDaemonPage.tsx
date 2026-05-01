import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../lib/auth-context';
import { Button } from '../components/ui/button';
import { RefreshCw, Trash2, Server, Activity, AlertTriangle, Play } from 'lucide-react';

interface DaemonSession {
  sessionId: string;
  alive: boolean;
  exitCode: number | null;
  exitedAt: number | null;
  lastOutputAt: number;
  bufferLength: number;
  userId: string | null;
  projectId: string | null;
}

interface DaemonStatus {
  connected: boolean;
  sessions: DaemonSession[];
}

export default function AdminDaemonPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [restarting, setRestarting] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/daemon/status');
      if (res.ok) {
        setStatus(await res.json());
        setError(null);
      } else {
        setError('Failed to fetch daemon status');
      }
    } catch {
      setError('Cannot reach server');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 5_000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const handleRestart = async () => {
    setRestarting(true);
    setError(null);
    try {
      const res = await fetch('/api/daemon/restart', { method: 'POST' });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error ?? 'Restart failed');
      }
      await fetchStatus();
    } catch {
      setError('Failed to restart daemon');
    } finally {
      setRestarting(false);
    }
  };

  const handleStart = async () => {
    setStarting(true);
    setError(null);
    try {
      const res = await fetch('/api/daemon/start', { method: 'POST' });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error ?? 'Start failed');
      }
      await fetchStatus();
    } catch {
      setError('Failed to start daemon');
    } finally {
      setStarting(false);
    }
  };

  const handleKillSession = async (sessionId: string) => {
    try {
      await fetch(`/api/daemon/sessions/${sessionId}`, { method: 'DELETE' });
      await fetchStatus();
    } catch {
      setError('Failed to kill session');
    }
  };

  const aliveSessions = status?.sessions.filter(s => s.alive) ?? [];
  const exitedSessions = status?.sessions.filter(s => !s.alive) ?? [];

  return (
    <div className="flex flex-col gap-6 p-8 max-w-4xl overflow-y-auto h-full">
      <div>
        <h2 className="text-2xl font-bold">Daemon Management</h2>
        <p className="text-muted-foreground mt-1">
          The session daemon owns PTY processes so they survive server restarts
        </p>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Connection status card */}
      <div className="rounded-lg border bg-card p-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Server className="h-5 w-5 text-muted-foreground" />
            <div>
              <h3 className="font-semibold">Daemon Status</h3>
              <div className="flex items-center gap-2 mt-1">
                <span
                  className={`h-2.5 w-2.5 rounded-full ${
                    status?.connected ? 'bg-green-500' : 'bg-red-500 animate-pulse'
                  }`}
                />
                <span className="text-sm text-muted-foreground">
                  {loading ? 'Checking...' : status?.connected ? 'Connected' : 'Disconnected'}
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!loading && !status?.connected && (
              <Button
                variant="default"
                size="sm"
                onClick={handleStart}
                disabled={starting}
              >
                <Play className={`h-4 w-4 mr-2 ${starting ? 'animate-pulse' : ''}`} />
                {starting ? 'Starting...' : 'Start Daemon'}
              </Button>
            )}
            {isAdmin && status?.connected && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleRestart}
                disabled={restarting}
              >
                <RefreshCw className={`h-4 w-4 mr-2 ${restarting ? 'animate-spin' : ''}`} />
                {restarting ? 'Restarting...' : 'Restart Daemon'}
              </Button>
            )}
          </div>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-4 text-center">
          <div className="rounded-md bg-muted/50 px-3 py-2">
            <div className="text-2xl font-bold">{aliveSessions.length}</div>
            <div className="text-xs text-muted-foreground">Active Sessions</div>
          </div>
          <div className="rounded-md bg-muted/50 px-3 py-2">
            <div className="text-2xl font-bold">{exitedSessions.length}</div>
            <div className="text-xs text-muted-foreground">Exited (Retained)</div>
          </div>
          <div className="rounded-md bg-muted/50 px-3 py-2">
            <div className="text-2xl font-bold">
              {Math.round((status?.sessions ?? []).reduce((sum, s) => sum + s.bufferLength, 0) / 1024)}K
            </div>
            <div className="text-xs text-muted-foreground">Buffer Size</div>
          </div>
        </div>
      </div>

      {/* Active sessions */}
      {aliveSessions.length > 0 && (
        <div className="rounded-lg border bg-card">
          <div className="flex items-center gap-2 px-6 py-4 border-b">
            <Activity className="h-4 w-4 text-green-500" />
            <h3 className="font-semibold">Active Sessions</h3>
          </div>
          <div className="divide-y">
            {aliveSessions.map(session => (
              <div key={session.sessionId} className="flex items-center gap-4 px-6 py-3">
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-sm truncate">{session.sessionId}</div>
                  <div className="text-xs text-muted-foreground flex gap-3 mt-0.5">
                    <span>User: {session.userId ?? 'unknown'}</span>
                    <span>Project: {session.projectId ?? 'none'}</span>
                    <span>Buffer: {Math.round(session.bufferLength / 1024)}KB</span>
                    {session.lastOutputAt > 0 && (
                      <span>Last output: {formatRelativeTime(session.lastOutputAt)}</span>
                    )}
                  </div>
                </div>
                {isAdmin && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive hover:bg-destructive/10 shrink-0"
                    onClick={() => handleKillSession(session.sessionId)}
                  >
                    <Trash2 className="h-4 w-4 mr-1" />
                    Kill
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Exited sessions */}
      {exitedSessions.length > 0 && (
        <div className="rounded-lg border bg-card">
          <div className="flex items-center gap-2 px-6 py-4 border-b">
            <Activity className="h-4 w-4 text-muted-foreground" />
            <h3 className="font-semibold text-muted-foreground">Recently Exited</h3>
          </div>
          <div className="divide-y">
            {exitedSessions.map(session => (
              <div key={session.sessionId} className="flex items-center gap-4 px-6 py-3 opacity-60">
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-sm truncate">{session.sessionId}</div>
                  <div className="text-xs text-muted-foreground flex gap-3 mt-0.5">
                    <span>Exit code: {session.exitCode ?? '?'}</span>
                    {session.exitedAt && (
                      <span>Exited: {formatRelativeTime(session.exitedAt)}</span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {!loading && status?.connected && aliveSessions.length === 0 && exitedSessions.length === 0 && (
        <div className="text-center py-8 text-muted-foreground">
          <Server className="h-8 w-8 mx-auto mb-2 opacity-40" />
          <p>No sessions in daemon. Sessions will appear when a terminal is opened.</p>
        </div>
      )}
    </div>
  );
}

function formatRelativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}
