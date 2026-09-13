'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export type ServerConnectionState = 'connecting' | 'open' | 'closed' | 'error';

export type ServerSocketServerMessage =
  | { type: 'ready'; serverId: string; status: string; exitCode: number | null }
  | { type: 'output'; data: string }
  | { type: 'status'; status: string; exitCode: number | null };

/** Upper bound for reconnect backoff; retries continue indefinitely. */
const MAX_RECONNECT_DELAY_MS = 15_000;

interface UseServerSocketOptions {
  serverId?: string;
  onReady?: (msg: Extract<ServerSocketServerMessage, { type: 'ready' }>) => void;
  onOutput?: (data: string) => void;
  onStatus?: (status: string, exitCode: number | null) => void;
}

/**
 * WebSocket hook for the live server console (`/ws/server`). Mirrors the
 * patterns of useAgentSocket (auto-reconnect with capped backoff, backlog
 * replay on connect) but speaks the lightweight server-stream protocol instead
 * of the agent SDK protocol.
 */
export function useServerSocket(options: UseServerSocketOptions = {}) {
  const [state, setState] = useState<ServerConnectionState>('closed');
  const wsRef = useRef<WebSocket | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempts = useRef(0);
  const closedIntentionally = useRef(false);
  const connectRef = useRef<() => void>(() => {});

  const discardSocket = useCallback((ws: WebSocket | null) => {
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    const base = Math.min(1000 * 2 ** reconnectAttempts.current, MAX_RECONNECT_DELAY_MS);
    const delay = base / 2 + Math.random() * (base / 2);
    reconnectAttempts.current += 1;
    reconnectTimer.current = setTimeout(() => connectRef.current(), delay);
  }, []);

  const connect = useCallback(() => {
    const serverId = optionsRef.current.serverId;
    if (!serverId) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    discardSocket(wsRef.current);
    wsRef.current = null;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/ws/server?serverId=${encodeURIComponent(serverId)}`;

    setState('connecting');
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => setState('open');

    ws.onmessage = (event) => {
      let msg: ServerSocketServerMessage;
      try {
        msg = JSON.parse(event.data as string) as ServerSocketServerMessage;
      } catch {
        return;
      }
      const opts = optionsRef.current;
      if (msg.type === 'ready') {
        reconnectAttempts.current = 0;
        opts.onReady?.(msg);
      } else if (msg.type === 'output') {
        opts.onOutput?.(msg.data);
      } else if (msg.type === 'status') {
        opts.onStatus?.(msg.status, msg.exitCode);
      }
    };

    ws.onerror = () => setState('error');

    ws.onclose = (evt) => {
      setState('closed');
      wsRef.current = null;
      if (closedIntentionally.current) return;
      // Auth failure / missing / not-found — fatal, do not hammer the server.
      if (evt.code === 4001 || evt.code === 4002 || evt.code === 4003) return;
      if (evt.code === 1000) return;
      scheduleReconnect();
    };
  }, [discardSocket, scheduleReconnect]);
  connectRef.current = connect;

  const reconnect = useCallback(() => {
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    reconnectAttempts.current = 0;
    closedIntentionally.current = false;
    const ws = wsRef.current;
    if (ws && ws.readyState !== WebSocket.OPEN) {
      wsRef.current = null;
      discardSocket(ws);
    }
    connect();
  }, [connect, discardSocket]);

  useEffect(() => {
    closedIntentionally.current = false;
    connect();
    return () => {
      closedIntentionally.current = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      const ws = wsRef.current;
      wsRef.current = null;
      discardSocket(ws);
    };
  }, [connect, discardSocket]);

  return { state, reconnect };
}
