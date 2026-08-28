'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentClientMessage, AgentServerMessage } from '@/types';

export type AgentConnectionState = 'connecting' | 'open' | 'closed' | 'error';

/** Upper bound for reconnect backoff; retries continue indefinitely. */
const MAX_RECONNECT_DELAY_MS = 15_000;

interface UseAgentSocketOptions {
  projectId?: string;
  worktreeId?: string;
  sessionId?: string;
  model?: string;
  forceNew?: boolean;
  onMessage?: (msg: AgentServerMessage) => void;
  onReady?: (sessionId: string) => void;
}

/**
 * WebSocket hook for the SDK-based "agent" mode. Mirrors useCliSocket but
 * speaks the structured agent protocol (JSON events) instead of raw PTY bytes.
 * Auto-reconnects and relies on the server replaying the transcript on connect.
 */
export function useAgentSocket(options: UseAgentSocketOptions = {}) {
  const [state, setState] = useState<AgentConnectionState>('closed');
  const wsRef = useRef<WebSocket | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempts = useRef(0);
  const knownSessionId = useRef<string | null>(null);
  const staleSessionId = useRef<string | null>(null);
  const forceNewRef = useRef(false);
  const closedIntentionally = useRef(false);
  const pending = useRef<AgentClientMessage[]>([]);
  const connectRef = useRef<() => void>(() => {});

  /**
   * Retry forever with exponential backoff (capped) plus jitter. The server can
   * be down for a while — a dev reload, a restart, a laptop waking up — and the
   * daemon keeps the agent session alive throughout, so giving up after a fixed
   * number of attempts would strand a session that is still running.
   */
  const scheduleReconnect = useCallback(() => {
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    const base = Math.min(1000 * 2 ** reconnectAttempts.current, MAX_RECONNECT_DELAY_MS);
    const delay = base / 2 + Math.random() * (base / 2);
    reconnectAttempts.current += 1;
    reconnectTimer.current = setTimeout(() => connectRef.current(), delay);
  }, []);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const params = new URLSearchParams();
    const opts = optionsRef.current;
    if (opts.projectId) params.set('projectId', opts.projectId);
    if (opts.worktreeId) params.set('worktreeId', opts.worktreeId);
    if (opts.model) params.set('model', opts.model);

    if (forceNewRef.current) {
      forceNewRef.current = false;
      params.set('new', 'true');
    } else if (knownSessionId.current) {
      params.set('sessionId', knownSessionId.current);
    } else if (opts.sessionId && opts.sessionId !== staleSessionId.current) {
      params.set('sessionId', opts.sessionId);
    } else if (opts.forceNew) {
      params.set('new', 'true');
    }

    const qs = params.toString();
    const url = `${protocol}//${window.location.host}/ws/agent${qs ? '?' + qs : ''}`;

    setState('connecting');
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => setState('open');

    ws.onmessage = (event) => {
      let msg: AgentServerMessage;
      try {
        msg = JSON.parse(event.data as string) as AgentServerMessage;
      } catch {
        return;
      }
      if (msg.type === 'ready') {
        knownSessionId.current = msg.sessionId;
        reconnectAttempts.current = 0;
        // Flush queued messages sent while disconnected.
        for (const m of pending.current) ws.send(JSON.stringify(m));
        pending.current = [];
        optionsRef.current.onReady?.(msg.sessionId);
      }
      optionsRef.current.onMessage?.(msg);
    };

    ws.onerror = () => setState('error');

    ws.onclose = (evt) => {
      setState('closed');
      wsRef.current = null;
      if (closedIntentionally.current) return;

      // Not your session — fatal.
      if (evt.code === 4005 || evt.code === 4001) return;
      // Session not found (server restarted / stale) — drop id and reconnect fresh.
      if (evt.code === 4003 || evt.code === 4002) {
        staleSessionId.current = knownSessionId.current ?? optionsRef.current.sessionId ?? null;
        knownSessionId.current = null;
      }
      if (evt.code === 1000) return;

      scheduleReconnect();
    };
  }, [scheduleReconnect]);
  connectRef.current = connect;

  /** Retry the connection immediately (user-initiated). */
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
      ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    connect();
  }, [connect]);

  useEffect(() => {
    closedIntentionally.current = false;
    connect();
    return () => {
      closedIntentionally.current = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const send = useCallback((msg: AgentClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    } else {
      pending.current.push(msg);
    }
  }, []);

  /** Abandon the current session and connect to a brand-new one. */
  const reset = useCallback(() => {
    forceNewRef.current = true;
    knownSessionId.current = null;
    staleSessionId.current = optionsRef.current.sessionId ?? null;
    pending.current = [];
    reconnectAttempts.current = 0;
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) {
      // Detach the auto-reconnect handler so closing doesn't race with connect().
      ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    connect();
  }, [connect]);

  /** Switch to an existing session by id (resumes/reconnects to it). */
  const switchTo = useCallback(
    (targetSessionId: string) => {
      if (!targetSessionId || targetSessionId === knownSessionId.current) return;
      forceNewRef.current = false;
      knownSessionId.current = targetSessionId;
      staleSessionId.current = null;
      pending.current = [];
      reconnectAttempts.current = 0;
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        ws.onclose = null;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
      connect();
    },
    [connect],
  );

  return { state, send, reset, switchTo, reconnect };
}
