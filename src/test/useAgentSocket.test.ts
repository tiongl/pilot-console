import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { StrictMode } from 'react';
import { useAgentSocket } from '@/hooks/useAgentSocket';

// Minimal WebSocket spy mirroring the useCliSocket test harness.
let wsInstances: SpyWebSocket[] = [];
const OriginalWebSocket = globalThis.WebSocket;

class SpyWebSocket extends EventTarget {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readonly OPEN = 1;
  readonly CLOSED = 3;

  readyState = 0;
  url: string;
  sentMessages: string[] = [];

  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;

  constructor(url: string | URL) {
    super();
    this.url = url.toString();
    wsInstances.push(this);
  }

  send(data: string) {
    this.sentMessages.push(data);
  }

  close() {
    this.readyState = SpyWebSocket.CLOSED;
  }

  simulateOpen() {
    this.readyState = SpyWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  simulateMessage(data: object) {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }));
  }

  simulateClose(code: number) {
    this.readyState = SpyWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close', { code }));
  }
}

function latest(): SpyWebSocket {
  return wsInstances[wsInstances.length - 1];
}

/** Drive the exponential-backoff reconnect timer to completion. */
function flushReconnect() {
  act(() => {
    vi.advanceTimersByTime(MAX_DELAY);
  });
}

const MAX_DELAY = 15_000;

describe('useAgentSocket session recovery', () => {
  beforeEach(() => {
    wsInstances = [];
    globalThis.WebSocket = SpyWebSocket as unknown as typeof WebSocket;
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.WebSocket = OriginalWebSocket;
    vi.useRealTimers();
  });

  it('retries the same session id after a transient "not found" instead of abandoning it', () => {
    renderHook(() => useAgentSocket({ sessionId: 'sess-1' }));
    // First connect targets the requested session.
    expect(latest().url).toContain('sessionId=sess-1');

    // Server can't find it (a resume raced / daemon busy). The hook should keep
    // trying the same id rather than dropping to a fresh session.
    act(() => latest().simulateClose(4003));
    flushReconnect();
    expect(latest().url).toContain('sessionId=sess-1');

    act(() => latest().simulateClose(4003));
    flushReconnect();
    expect(latest().url).toContain('sessionId=sess-1');
  });

  it('recovers the session when a retry finally succeeds', () => {
    const onReady = vi.fn();
    renderHook(() => useAgentSocket({ sessionId: 'sess-1', onReady }));

    act(() => latest().simulateClose(4003));
    flushReconnect();
    act(() => {
      latest().simulateOpen();
      latest().simulateMessage({ type: 'ready', sessionId: 'sess-1', model: 'auto', mode: 'interactive', status: 'idle' });
    });
    expect(onReady).toHaveBeenCalledWith('sess-1');
    expect(latest().url).toContain('sessionId=sess-1');
  });

  it('falls back to a fresh session only after exhausting the retry budget', () => {
    renderHook(() => useAgentSocket({ sessionId: 'sess-1' }));

    // 5 tolerated retries, all still targeting the same id.
    for (let i = 0; i < 5; i++) {
      act(() => latest().simulateClose(4003));
      flushReconnect();
      expect(latest().url).toContain('sessionId=sess-1');
    }

    // The 6th failure exhausts the budget: give up on the id and connect fresh.
    act(() => latest().simulateClose(4003));
    flushReconnect();
    expect(latest().url).not.toContain('sessionId=sess-1');
  });

  it('resets the retry budget after a successful connection', () => {
    renderHook(() => useAgentSocket({ sessionId: 'sess-1' }));

    // Burn 4 retries, then recover.
    for (let i = 0; i < 4; i++) {
      act(() => latest().simulateClose(4003));
      flushReconnect();
    }
    act(() => {
      latest().simulateOpen();
      latest().simulateMessage({ type: 'ready', sessionId: 'sess-1', model: 'auto', mode: 'interactive', status: 'idle' });
    });

    // A fresh streak of failures should again get the full allowance on the
    // now-known id, not immediately fall back.
    for (let i = 0; i < 5; i++) {
      act(() => latest().simulateClose(4003));
      flushReconnect();
      expect(latest().url).toContain('sessionId=sess-1');
    }
  });
});

/**
 * Streamed text arrives as deltas, which are appended rather than replaced. A
 * second live socket on the same session therefore makes the pane append every
 * fragment twice — the answer visibly repeats sub-phrases until the final full
 * message lands and replaces it.
 */
describe('useAgentSocket duplicate delivery', () => {
  beforeEach(() => {
    wsInstances = [];
    globalThis.WebSocket = SpyWebSocket as unknown as typeof WebSocket;
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.WebSocket = OriginalWebSocket;
    vi.useRealTimers();
  });

  function deltas(onMessage: ReturnType<typeof vi.fn>) {
    return onMessage.mock.calls
      .map(([m]) => m as { type: string; delta?: string })
      .filter((m) => m.type === 'assistant_delta')
      .map((m) => m.delta);
  }

  it('delivers each delta once when React mounts the effect twice', () => {
    const onMessage = vi.fn();
    renderHook(() => useAgentSocket({ sessionId: 'sess-1', onMessage }), { wrapper: StrictMode });

    // Every socket the double-mount created gets the same frame from the server.
    act(() => {
      for (const ws of wsInstances) {
        ws.simulateOpen();
        ws.simulateMessage({ type: 'assistant_delta', id: 'a1', delta: 'hello' });
      }
    });

    expect(deltas(onMessage)).toEqual(['hello']);
  });

  it('ignores frames from a socket that has been superseded', () => {
    const onMessage = vi.fn();
    const { result } = renderHook(() => useAgentSocket({ sessionId: 'sess-1', onMessage }));
    const first = latest();
    act(() => {
      first.simulateOpen();
      first.simulateMessage({ type: 'ready', sessionId: 'sess-1', model: 'auto', mode: 'interactive', status: 'idle' });
    });

    act(() => result.current.switchTo('sess-2'));
    // The old socket is still finishing its close and can flush buffered frames.
    act(() => first.simulateMessage({ type: 'assistant_delta', id: 'a1', delta: 'stale' }));
    act(() => {
      latest().simulateOpen();
      latest().simulateMessage({ type: 'assistant_delta', id: 'a1', delta: 'live' });
    });

    expect(deltas(onMessage)).toEqual(['live']);
  });
});
