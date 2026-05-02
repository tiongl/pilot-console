import { useEffect } from 'react';
import { useAuth } from '../lib/auth-context';
import { useAutomation } from '../lib/automation-context';
import { toast } from 'sonner';

/**
 * Hook that listens for report-ready WebSocket notifications
 * and displays a toast. Also increments the automation badge count.
 */
export function useReportNotifications() {
  const { user } = useAuth();
  const { incrementBadge } = useAutomation();

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
  }, [user, incrementBadge]);
}
