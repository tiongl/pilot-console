'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { RotateCcw, ExternalLink, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

export type ArtifactStatus = 'starting' | 'ready' | 'failed' | 'stopped';

interface ArtifactTabProps {
  artifactId: string;
  name: string;
  sessionKey?: string | null;
  initialStatus?: ArtifactStatus;
  active?: boolean;
  /** Called after the artifact (and its tab) has been deleted. */
  onDeleted?: () => void;
}

/**
 * Live Lavish artifact tab. Embeds the SAME-ORIGIN reverse-proxy path
 * `/api/lavish/:artifactId/session/<key>` in an iframe. The proxy strips the
 * frame-blocking headers Lavish sends, sets an accepted Host toward the Lavish
 * daemon, forwards the live-reload WebSocket, and prefixes the SDK's
 * root-absolute requests — so the injected Lavish SDK (annotations, whiteboard,
 * feedback loop) works exactly as if served directly.
 */
export default function ArtifactTab({
  artifactId,
  name,
  sessionKey,
  initialStatus = 'starting',
  onDeleted,
}: ArtifactTabProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<ArtifactStatus>(initialStatus);
  const [key, setKey] = useState<string | null>(sessionKey ?? null);
  const [busy, setBusy] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);

  // Readiness (status + session key) is driven by the parent's poll of
  // `/api/projects/:id/lavish`, passed down as props. Sync local state when it
  // changes so the iframe appears as soon as the Lavish session is live.
  useEffect(() => {
    setStatus(initialStatus);
  }, [initialStatus]);
  useEffect(() => {
    if (sessionKey) setKey(sessionKey);
  }, [sessionKey]);

  const proxyUrl = key ? `/api/lavish/${artifactId}/session/${key}` : null;

  const remove = useCallback(async () => {
    setBusy(true);
    try {
      await fetch(`/api/lavish-artifacts/${artifactId}`, { method: 'DELETE' });
      onDeleted?.();
    } catch {
      setBusy(false);
    }
  }, [artifactId, onDeleted]);

  const statusColor =
    status === 'ready'
      ? 'text-emerald-500'
      : status === 'failed'
        ? 'text-destructive'
        : status === 'stopped'
          ? 'text-muted-foreground'
          : 'text-amber-500';
  const statusBg =
    status === 'ready'
      ? 'bg-emerald-500/10'
      : status === 'failed'
        ? 'bg-destructive/10'
        : status === 'stopped'
          ? 'bg-muted/50'
          : 'bg-amber-500/10';

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 shrink-0">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="truncate text-sm font-semibold">{name}</div>
          <div className="truncate font-mono text-xs text-muted-foreground">Lavish artifact</div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <div
            data-testid="artifact-status-badge"
            className={`flex items-center gap-1 rounded px-2 py-1 text-xs font-medium ${statusBg} ${statusColor}`}
          >
            <span
              className={`h-2 w-2 rounded-full ${
                status === 'ready'
                  ? 'bg-emerald-500'
                  : status === 'failed'
                    ? 'bg-destructive'
                    : status === 'stopped'
                      ? 'bg-muted-foreground'
                      : 'bg-amber-500'
              }`}
            />
            <span className="capitalize">{status}</span>
          </div>

          <Button
            size="sm"
            variant="ghost"
            onClick={() => setReloadNonce((n) => n + 1)}
            disabled={!proxyUrl}
            title="Reload artifact"
            data-testid="artifact-reload"
            className="h-7 w-7 p-0"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>

          {proxyUrl && (
            <a
              href={proxyUrl}
              target="_blank"
              rel="noreferrer"
              title="Open in new tab"
              data-testid="artifact-external"
              className="inline-flex h-7 w-7 items-center justify-center rounded hover:bg-muted"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}

          <Button
            size="sm"
            variant="ghost"
            onClick={() => void remove()}
            disabled={busy}
            title="Remove artifact tab"
            data-testid="artifact-remove"
            className="h-7 w-7 p-0"
          >
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </Button>
        </div>
      </div>

      {/* Embedded live Lavish session */}
      <div className="min-h-0 flex-1">
        {proxyUrl ? (
          <iframe
            key={reloadNonce}
            ref={iframeRef}
            src={proxyUrl}
            title={name}
            className="h-full w-full border-0"
            data-testid="artifact-iframe"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {status === 'failed'
              ? 'Failed to open the Lavish session.'
              : 'Starting Lavish session…'}
          </div>
        )}
      </div>
    </div>
  );
}
