'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Square, Play, RotateCcw, Trash2, Eraser } from 'lucide-react';
import { getThemeByName } from '@/lib/terminal-themes';
import { Button } from '@/components/ui/button';
import { useServerSocket } from '@/hooks/useServerSocket';

export type ServerStatus = 'pending' | 'starting' | 'running' | 'stopped' | 'failed';

interface ServerTabProps {
  serverId: string;
  name: string;
  command: string;
  initialStatus?: ServerStatus;
  active?: boolean;
  fontFamily?: string;
  fontSize?: number;
  themeName?: string;
  /** Called after the server (and its tab) has been deleted. */
  onDeleted?: () => void;
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/**
 * Live console tab for a Project-Lead-managed server. Streams stdout/stderr over
 * the dedicated `/ws/server` socket into an xterm terminal (following the
 * TerminalPane patterns) and exposes Stop / Restart / Clear / Remove controls.
 */
export default function ServerTab({
  serverId,
  name,
  command,
  initialStatus = 'starting',
  active = true,
  fontFamily,
  fontSize = 13,
  themeName,
  onDeleted,
}: ServerTabProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const writeRef = useRef<(data: string) => void>(() => {});

  const [status, setStatus] = useState<ServerStatus>(initialStatus);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [uptime, setUptime] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const runningSinceRef = useRef<number | null>(null);

  // --- xterm setup (read-only console) ---
  useEffect(() => {
    if (!containerRef.current || termRef.current) return;

    const term = new Terminal({
      fontFamily: fontFamily || 'Menlo, Monaco, "Courier New", monospace',
      fontSize,
      theme: getThemeByName(themeName ?? 'Catppuccin').theme,
      cursorBlink: false,
      disableStdin: true,
      convertEol: true,
      scrollback: 10_000,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);

    // Batched writer: coalesce rapid WS messages into one render per frame.
    const batched = (() => {
      const MAX_BATCH_CHARS = 16_384;
      let buf: string[] = [];
      let raf = 0;
      const flush = () => {
        const chunk = buf.join('');
        buf = [];
        raf = 0;
        if (chunk.length <= MAX_BATCH_CHARS) {
          term.write(chunk);
        } else {
          term.write(chunk.slice(0, MAX_BATCH_CHARS));
          buf.push(chunk.slice(MAX_BATCH_CHARS));
          raf = requestAnimationFrame(flush);
        }
      };
      return (data: string) => {
        buf.push(data);
        if (!raf) raf = requestAnimationFrame(flush);
      };
    })();

    termRef.current = term;
    fitRef.current = fit;
    writeRef.current = batched;

    const rafId = requestAnimationFrame(() => fit.fit());
    const safetyRefit = setTimeout(() => fit.fit(), 150);

    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimeout) clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => fit.fit(), 100);
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      cancelAnimationFrame(rafId);
      clearTimeout(safetyRefit);
      if (resizeTimeout) clearTimeout(resizeTimeout);
      resizeObserver.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      writeRef.current = () => {};
    };
  }, []);

  // Apply theme / font changes.
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = getThemeByName(themeName ?? 'Catppuccin').theme;
  }, [themeName]);
  useEffect(() => {
    if (!termRef.current || !fitRef.current) return;
    termRef.current.options.fontSize = fontSize;
    requestAnimationFrame(() => fitRef.current?.fit());
  }, [fontSize]);
  useEffect(() => {
    if (!termRef.current || !fitRef.current) return;
    termRef.current.options.fontFamily = fontFamily || 'Menlo, Monaco, "Courier New", monospace';
    requestAnimationFrame(() => fitRef.current?.fit());
  }, [fontFamily]);

  // Refit when this tab becomes visible.
  useEffect(() => {
    if (!active || !fitRef.current) return;
    const fit = fitRef.current;
    const raf = requestAnimationFrame(() => fit.fit());
    const safety = setTimeout(() => fit.fit(), 150);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(safety);
    };
  }, [active]);

  const applyStatus = useCallback((next: ServerStatus, code: number | null) => {
    setStatus(next);
    setExitCode(code);
    if (next === 'running') {
      if (runningSinceRef.current === null) runningSinceRef.current = Date.now();
    } else {
      runningSinceRef.current = null;
      if (next !== 'starting' && next !== 'pending') setUptime('');
    }
  }, []);

  // --- live stream ---
  useServerSocket({
    serverId,
    onReady: (msg) => {
      // Reset before the backlog replay so a reconnect doesn't duplicate output.
      termRef.current?.reset();
      applyStatus(msg.status as ServerStatus, msg.exitCode);
    },
    onOutput: (data) => writeRef.current(data),
    onStatus: (next, code) => applyStatus(next as ServerStatus, code),
  });

  // Uptime ticker while running.
  useEffect(() => {
    if (status !== 'running') return;
    const tick = () => {
      if (runningSinceRef.current !== null) setUptime(formatUptime(Date.now() - runningSinceRef.current));
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [status]);

  const post = useCallback(
    async (action: 'stop' | 'restart') => {
      setBusy(true);
      try {
        await fetch(`/api/servers/${serverId}/${action}`, { method: 'POST' });
      } catch {
        /* status will reflect the real state over the socket */
      } finally {
        setBusy(false);
      }
    },
    [serverId],
  );

  const remove = useCallback(async () => {
    setBusy(true);
    try {
      await fetch(`/api/servers/${serverId}`, { method: 'DELETE' });
      onDeleted?.();
    } catch {
      setBusy(false);
    }
  }, [serverId, onDeleted]);

  const isRunning = status === 'running' || status === 'starting';
  const isStopped = status === 'stopped' || status === 'failed';

  const statusColor =
    status === 'running'
      ? 'text-emerald-500'
      : status === 'failed'
        ? 'text-destructive'
        : status === 'stopped'
          ? 'text-muted-foreground'
          : 'text-amber-500';
  const statusBg =
    status === 'running'
      ? 'bg-emerald-500/10'
      : status === 'failed'
        ? 'bg-destructive/10'
        : status === 'stopped'
          ? 'bg-muted/50'
          : 'bg-amber-500/10';

  const theme = getThemeByName(themeName ?? 'Catppuccin');

  return (
    <div className="flex h-full flex-col" style={{ backgroundColor: theme.theme.background }}>
      {/* Header */}
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 shrink-0">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="truncate text-sm font-semibold" style={{ color: theme.theme.foreground }}>
            {name}
          </div>
          <div className={`truncate font-mono text-xs ${statusColor}`}>{command}</div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <div
            data-testid="server-status-badge"
            className={`flex items-center gap-1 rounded px-2 py-1 text-xs font-medium ${statusBg} ${statusColor}`}
          >
            <span className={`h-2 w-2 rounded-full ${status === 'running' ? 'bg-emerald-500' : status === 'failed' ? 'bg-destructive' : status === 'stopped' ? 'bg-muted-foreground' : 'bg-amber-500'}`} />
            <span className="capitalize">{status}</span>
            {status === 'running' && uptime ? <span className="opacity-70">· {uptime}</span> : null}
            {isStopped && exitCode !== null ? <span className="opacity-70">· exit {exitCode}</span> : null}
          </div>

          {isRunning && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void post('stop')}
              disabled={busy}
              title="Stop server"
              data-testid="server-stop"
              className="h-7 w-7 p-0"
            >
              <Square className="h-3.5 w-3.5" />
            </Button>
          )}

          <Button
            size="sm"
            variant="ghost"
            onClick={() => void post('restart')}
            disabled={busy}
            title="Restart server"
            data-testid="server-restart"
            className="h-7 w-7 p-0"
          >
            {isStopped ? <Play className="h-3.5 w-3.5" /> : <RotateCcw className="h-3.5 w-3.5" />}
          </Button>

          <Button
            size="sm"
            variant="ghost"
            onClick={() => termRef.current?.clear()}
            title="Clear console"
            data-testid="server-clear"
            className="h-7 w-7 p-0"
          >
            <Eraser className="h-3.5 w-3.5" />
          </Button>

          <Button
            size="sm"
            variant="ghost"
            onClick={() => void remove()}
            disabled={busy}
            title="Remove server tab"
            data-testid="server-remove"
            className="h-7 w-7 p-0"
          >
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </Button>
        </div>
      </div>

      {/* Console */}
      <div ref={containerRef} className="min-h-0 flex-1 px-2 pb-2 pt-1" />
    </div>
  );
}
