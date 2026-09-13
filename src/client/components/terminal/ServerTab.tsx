'use client';

import { useEffect, useRef, useState } from 'react';
import { Square, Play, RotateCcw, Trash2, Copy, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ServerTabProps {
  serverId: string;
  name: string;
  sessionId: string;
  status: 'pending' | 'starting' | 'running' | 'stopped' | 'failed';
  command: string;
  onStop?: () => void;
  onRestart?: () => void;
  onDelete?: () => void;
  fontFamily?: string;
  fontSize?: number;
}

export default function ServerTab({
  serverId,
  name,
  sessionId,
  status,
  command,
  onStop,
  onRestart,
  onDelete,
  fontFamily = 'monospace',
  fontSize = 13,
}: ServerTabProps) {
  const [output, setOutput] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const [uptime, setUptime] = useState<string>('');
  const outputRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const startTimeRef = useRef<number>(Date.now());

  // Update uptime for running servers
  useEffect(() => {
    if (status !== 'running') return;
    const timer = setInterval(() => {
      const elapsed = Date.now() - startTimeRef.current;
      const seconds = Math.floor(elapsed / 1000);
      const minutes = Math.floor(seconds / 60);
      const hours = Math.floor(minutes / 60);

      if (hours > 0) {
        setUptime(`${hours}h ${minutes % 60}m`);
      } else if (minutes > 0) {
        setUptime(`${minutes}m ${seconds % 60}s`);
      } else {
        setUptime(`${seconds}s`);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [status]);

  // Connect WebSocket for live output
  useEffect(() => {
    const ws = new WebSocket(`${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/`);

    const handleOpen = () => {
      ws.send(JSON.stringify({ type: 'attach_cli', sessionId }));
    };

    const handleMessage = (event: MessageEvent) => {
      const msg = JSON.parse(event.data) as Record<string, unknown>;
      if (msg.type === 'output') {
        const newOutput = msg.data as string;
        setOutput((prev) => prev + newOutput);

        // Auto-scroll to bottom
        setTimeout(() => {
          if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
          }
        }, 0);
      }
    };

    const handleClose = () => {
      console.log('[ServerTab] WebSocket closed');
    };

    const handleError = (error: Event) => {
      console.error('[ServerTab] WebSocket error:', error);
    };

    ws.addEventListener('open', handleOpen);
    ws.addEventListener('message', handleMessage);
    ws.addEventListener('close', handleClose);
    ws.addEventListener('error', handleError);

    return () => {
      ws.removeEventListener('open', handleOpen);
      ws.removeEventListener('message', handleMessage);
      ws.removeEventListener('close', handleClose);
      ws.removeEventListener('error', handleError);
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    };
  }, [sessionId]);

  const copyOutput = () => {
    if (!navigator.clipboard) return;
    void navigator.clipboard.writeText(output).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

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

  return (
    <div className="flex flex-col h-full bg-[#1e1e1e]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-3 py-2 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex flex-col gap-0.5 min-w-0">
            <div className="text-sm font-semibold truncate">{name}</div>
            <div className={`text-xs font-mono truncate ${statusColor}`}>{command}</div>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Status and uptime */}
          <div
            className={`px-2 py-1 rounded text-xs font-medium flex items-center gap-1 ${statusBg} ${statusColor}`}
          >
            <div className={`h-2 w-2 rounded-full ${statusColor}`} />
            <span className="capitalize">{status}</span>
            {uptime && <span className="text-muted-foreground">({uptime})</span>}
          </div>

          {/* Controls */}
          <Button
            size="sm"
            variant="ghost"
            onClick={copyOutput}
            title="Copy output"
            className="h-7 w-7 p-0"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
          </Button>

          {status === 'running' && (
            <>
              <Button size="sm" variant="ghost" onClick={onStop} title="Stop server" className="h-7 w-7 p-0">
                <Square className="h-3.5 w-3.5" />
              </Button>
              <Button size="sm" variant="ghost" onClick={onRestart} title="Restart server" className="h-7 w-7 p-0">
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
            </>
          )}

          {(status === 'stopped' || status === 'failed') && (
            <Button size="sm" variant="ghost" onClick={onRestart} title="Restart server" className="h-7 w-7 p-0">
              <Play className="h-3.5 w-3.5" />
            </Button>
          )}

          <Button size="sm" variant="ghost" onClick={onDelete} title="Remove server tab" className="h-7 w-7 p-0">
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </Button>
        </div>
      </div>

      {/* Output area */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto font-mono text-sm bg-[#1e1e1e] text-gray-200 p-3 whitespace-pre-wrap break-words"
        style={{ fontFamily, fontSize }}
      >
        <div ref={outputRef}>{output || <span className="text-muted-foreground">Starting server…</span>}</div>
      </div>
    </div>
  );
}
