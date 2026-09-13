import { useEffect } from 'react';
import { useAuth } from '../lib/auth-context';
import { useAutomation } from '../lib/automation-context';
import { toast } from 'sonner';

export interface ScheduleChangedDetail {
  action: 'created' | 'updated' | 'deleted' | 'imported';
  scheduleId?: string;
}

export interface GitChangedDetail {
  projectId: string;
  worktreeId: string | null;
}

export interface WorktreesChangedDetail {
  projectId: string;
}

/**
 * Hook that listens for automation WebSocket notifications.
 */
export function useReportNotifications() {
  const { user } = useAuth();
  const { incrementBadge, refreshSchedules } = useAutomation();

  useEffect(() => {
    if (!user) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws?notify=true`;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      ws = new WebSocket(wsUrl);

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'report-ready') {
            incrementBadge();
            const statusEmoji = msg.status === 'completed' ? '✅' : msg.status === 'failed' ? '❌' : '⏱️';
            toast(`${statusEmoji} Automation: ${msg.scheduleName}`, {
              description: `Status: ${msg.status}`,
              action: msg.status === 'completed' ? {
                label: 'View',
                onClick: () => {
                  window.location.href = `/automation?run=${msg.runId}`;
                },
              } : undefined,
              duration: 10000,
            });
          } else if (msg.type === 'schedule-changed') {
            refreshSchedules();
            window.dispatchEvent(new CustomEvent<ScheduleChangedDetail>('schedule-changed', {
              detail: { action: msg.action, scheduleId: msg.scheduleId },
            }));
          } else if (msg.type === 'git-changed') {
            window.dispatchEvent(new CustomEvent<GitChangedDetail>('git-changed', {
              detail: { projectId: msg.projectId, worktreeId: msg.worktreeId ?? null },
            }));
          } else if (msg.type === 'worktrees-changed') {
            window.dispatchEvent(new CustomEvent<WorktreesChangedDetail>('worktrees-changed', {
              detail: { projectId: msg.projectId },
            }));
          }
        } catch {}
      };

      ws.onclose = () => {
        reconnectTimer = setTimeout(connect, 10_000);
      };

      ws.onerror = () => {
        ws?.close();
      };
    }

    connect();

    return () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [user, incrementBadge, refreshSchedules]);
}
