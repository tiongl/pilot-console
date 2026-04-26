'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { WsClientMessage, WsServerMessage } from '@/types';

export type ConnectionState = 'connecting' | 'open' | 'closed' | 'error';

interface UseCliSocketOptions {
  projectId?: string;
  onOutput?: (data: string) => void;
  onError?: (data: string) => void;
  onExit?: (code: number) => void;
  onReady?: (sessionId: string) => void;
}

export function useCliSocket(options: UseCliSocketOptions = {}) {
  const [state, setState] = useState<ConnectionState>('closed');
  const wsRef = useRef<WebSocket | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempts = useRef(0);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    // Cookies are sent automatically by the browser on same-origin WS connections
    const params = optionsRef.current.projectId ? `?projectId=${encodeURIComponent(optionsRef.current.projectId)}` : '';
    const url = `${protocol}//${window.location.host}/ws${params}`;

    setState('connecting');
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setState('open');
      reconnectAttempts.current = 0;
    };

    ws.onmessage = (event) => {
      let msg: WsServerMessage;
      try { msg = JSON.parse(event.data as string) as WsServerMessage; } catch { return; }
      const opts = optionsRef.current;
      if (msg.type === 'output') opts.onOutput?.(msg.data);
      else if (msg.type === 'error') opts.onError?.(msg.data);
      else if (msg.type === 'exit') opts.onExit?.(msg.code);
      else if (msg.type === 'ready') opts.onReady?.(msg.sessionId);
    };

    ws.onerror = () => setState('error');

    ws.onclose = (evt) => {
      setState('closed');
      wsRef.current = null;
      if (evt.code !== 4001 && reconnectAttempts.current < 5) {
        const delay = Math.min(1000 * 2 ** reconnectAttempts.current, 30_000);
        reconnectAttempts.current += 1;
        reconnectTimer.current = setTimeout(connect, delay);
      }
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      reconnectTimer.current && clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const send = useCallback((msg: WsClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  return { state, send };
}
