'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { WsClientMessage, WsServerMessage } from '@/types';

export type ConnectionState = 'connecting' | 'open' | 'closed' | 'error';

interface UseCliSocketOptions {
  projectId?: string;
  sessionId?: string;
  forceNew?: boolean;
  mode?: 'cli' | 'shell' | 'powershell';
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
  const knownSessionId = useRef<string | null>(null);
  const pendingInput = useRef<WsClientMessage[]>([]);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const urlParams = new URLSearchParams();
    if (optionsRef.current.projectId) urlParams.set('projectId', optionsRef.current.projectId);
    if (optionsRef.current.mode && optionsRef.current.mode !== 'cli') urlParams.set('mode', optionsRef.current.mode);

    if (knownSessionId.current) {
      // Reconnect to existing session
      urlParams.set('sessionId', knownSessionId.current);
    } else if (optionsRef.current.sessionId) {
      urlParams.set('sessionId', optionsRef.current.sessionId);
    } else if (optionsRef.current.forceNew) {
      urlParams.set('new', 'true');
    }

    const queryString = urlParams.toString();
    const url = `${protocol}//${window.location.host}/ws${queryString ? '?' + queryString : ''}`;

    setState('connecting');
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('[useCliSocket] WS opened');
      setState('open');
      reconnectAttempts.current = 0;
      // Flush any input that was buffered while disconnected
      if (pendingInput.current.length > 0) {
        console.log(`[useCliSocket] flushing ${pendingInput.current.length} buffered messages`);
        for (const msg of pendingInput.current) {
          ws.send(JSON.stringify(msg));
        }
        pendingInput.current = [];
      }
    };

    ws.onmessage = (event) => {
      let msg: WsServerMessage;
      try { msg = JSON.parse(event.data as string) as WsServerMessage; } catch { return; }
      const opts = optionsRef.current;
      if (msg.type === 'output') opts.onOutput?.(msg.data);
      else if (msg.type === 'error') opts.onError?.(msg.data);
      else if (msg.type === 'exit') {
        console.log(`[useCliSocket] exit: code=${msg.code}`);
        opts.onExit?.(msg.code);
        knownSessionId.current = null; // Session ended, create new on reconnect
      }
      else if (msg.type === 'ready') {
        console.log(`[useCliSocket] ready: sessionId=${msg.sessionId}`);
        knownSessionId.current = msg.sessionId;
        opts.onReady?.(msg.sessionId);
      }
    };

    ws.onerror = () => {
      console.error('[useCliSocket] WS error');
      setState('error');
    };

    ws.onclose = (evt) => {
      console.log(`[useCliSocket] WS closed: code=${evt.code}, reason=${evt.reason}`);
      setState('closed');
      wsRef.current = null;
      // Notify about daemon/session creation failures
      if (evt.code === 4002) {
        optionsRef.current.onError?.(`Failed to create terminal session — the daemon may not be running. Check Admin → Daemon.`);
        return; // Don't reconnect on daemon failure
      }
      // Session not found — clear cached ID so next connect creates fresh
      if (evt.code === 4003) {
        knownSessionId.current = null;
      }
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
    } else if (msg.type === 'input') {
      // Buffer input during disconnection so keystrokes aren't lost
      pendingInput.current.push(msg);
      console.log(`[useCliSocket] buffered input (readyState=${wsRef.current?.readyState})`);
    } else {
      console.warn(`[useCliSocket] send dropped (readyState=${wsRef.current?.readyState}):`, msg.type);
    }
  }, []);

  return { state, send };
}
