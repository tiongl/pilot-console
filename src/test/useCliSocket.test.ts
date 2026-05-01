import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCliSocket } from '@/hooks/useCliSocket';

// Capture WebSocket instances created during tests
let wsInstances: WebSocket[] = [];
const OriginalWebSocket = globalThis.WebSocket;

class SpyWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readyState = SpyWebSocket.CONNECTING;
  url: string;
  protocol = '';
  extensions = '';
  bufferedAmount = 0;
  binaryType: BinaryType = 'blob';
  sentMessages: string[] = [];
  wasClosed = false;

  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;

  constructor(url: string | URL, _protocols?: string | string[]) {
    super();
    this.url = url.toString();
    wsInstances.push(this as unknown as WebSocket);
  }

  send(data: string) {
    this.sentMessages.push(data);
  }

  close(_code?: number, _reason?: string) {
    this.wasClosed = true;
    this.readyState = SpyWebSocket.CLOSED;
  }

  // Test helpers
  simulateOpen() {
    this.readyState = SpyWebSocket.OPEN;
    const evt = new Event('open');
    this.onopen?.(evt);
    this.dispatchEvent(evt);
  }

  simulateMessage(data: object) {
    const evt = new MessageEvent('message', { data: JSON.stringify(data) });
    this.onmessage?.(evt);
    this.dispatchEvent(evt);
  }

  simulateClose(code = 4001) {
    this.readyState = SpyWebSocket.CLOSED;
    const evt = new CloseEvent('close', { code });
    this.onclose?.(evt);
    this.dispatchEvent(evt);
  }

  simulateError() {
    const evt = new Event('error');
    this.onerror?.(evt);
    this.dispatchEvent(evt);
  }
}

describe('useCliSocket', () => {
  beforeEach(() => {
    wsInstances = [];
    globalThis.WebSocket = SpyWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = OriginalWebSocket;
  });

  function getLatestWs(): SpyWebSocket {
    return wsInstances[wsInstances.length - 1] as unknown as SpyWebSocket;
  }

  it('starts in connecting state after mount', () => {
    const { result } = renderHook(() => useCliSocket());
    expect(result.current.state).toBe('connecting');
  });

  it('transitions to open when WebSocket connects', () => {
    const { result } = renderHook(() => useCliSocket());
    act(() => getLatestWs().simulateOpen());
    expect(result.current.state).toBe('open');
  });

  it('constructs URL with projectId', () => {
    renderHook(() => useCliSocket({ projectId: 'test-project' }));
    expect(getLatestWs().url).toContain('projectId=test-project');
  });

  it('constructs URL with forceNew', () => {
    renderHook(() => useCliSocket({ forceNew: true }));
    expect(getLatestWs().url).toContain('new=true');
  });

  it('calls onOutput on output message', () => {
    const onOutput = vi.fn();
    renderHook(() => useCliSocket({ onOutput }));
    act(() => {
      getLatestWs().simulateOpen();
      getLatestWs().simulateMessage({ type: 'output', data: 'hello' });
    });
    expect(onOutput).toHaveBeenCalledWith('hello');
  });

  it('calls onReady with sessionId', () => {
    const onReady = vi.fn();
    renderHook(() => useCliSocket({ onReady }));
    act(() => {
      getLatestWs().simulateOpen();
      getLatestWs().simulateMessage({ type: 'ready', sessionId: 'sess-1' });
    });
    expect(onReady).toHaveBeenCalledWith('sess-1');
  });

  it('calls onExit on exit message', () => {
    const onExit = vi.fn();
    renderHook(() => useCliSocket({ onExit }));
    act(() => {
      getLatestWs().simulateOpen();
      getLatestWs().simulateMessage({ type: 'exit', code: 0 });
    });
    expect(onExit).toHaveBeenCalledWith(0);
  });

  it('calls onError on error message', () => {
    const onError = vi.fn();
    renderHook(() => useCliSocket({ onError }));
    act(() => {
      getLatestWs().simulateOpen();
      getLatestWs().simulateMessage({ type: 'error', data: 'oops' });
    });
    expect(onError).toHaveBeenCalledWith('oops');
  });

  it('sends messages when open', () => {
    const { result } = renderHook(() => useCliSocket());
    act(() => getLatestWs().simulateOpen());
    act(() => result.current.send({ type: 'input', data: 'hi' }));
    expect(JSON.parse(getLatestWs().sentMessages[0])).toEqual({ type: 'input', data: 'hi' });
  });

  it('silently drops messages when not open', () => {
    const { result } = renderHook(() => useCliSocket());
    // Don't open the WS
    act(() => result.current.send({ type: 'input', data: 'hi' }));
    expect(getLatestWs().sentMessages).toHaveLength(0);
  });

  it('transitions to error on WS error', () => {
    const { result } = renderHook(() => useCliSocket());
    act(() => getLatestWs().simulateError());
    expect(result.current.state).toBe('error');
  });

  it('closes WebSocket on unmount', () => {
    const { unmount } = renderHook(() => useCliSocket());
    const ws = getLatestWs();
    unmount();
    expect(ws.wasClosed).toBe(true);
  });

  it('does not reconnect on unmount close', () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useCliSocket());
    const ws = getLatestWs();
    act(() => ws.simulateOpen());
    unmount();
    // Simulate close event after unmount
    act(() => ws.simulateClose(1006));
    vi.advanceTimersByTime(5000);
    // Should not have created a new WS connection
    expect(wsInstances).toHaveLength(1);
    vi.useRealTimers();
  });

  it('does not reconnect on 4005 (not your session)', () => {
    vi.useFakeTimers();
    renderHook(() => useCliSocket({ sessionId: 'foreign-sess' }));
    const ws = getLatestWs();
    act(() => ws.simulateOpen());
    act(() => ws.simulateClose(4005));
    vi.advanceTimersByTime(5000);
    expect(wsInstances).toHaveLength(1);
    vi.useRealTimers();
  });

  it('clears stale sessionId on 4003 and reconnects without it', () => {
    vi.useFakeTimers();
    renderHook(() => useCliSocket({ sessionId: 'dead-sess' }));
    const ws1 = getLatestWs();
    expect(ws1.url).toContain('sessionId=dead-sess');
    act(() => ws1.simulateOpen());
    act(() => ws1.simulateClose(4003));
    // Should schedule a reconnect
    act(() => { vi.advanceTimersByTime(1100); });
    expect(wsInstances).toHaveLength(2);
    const ws2 = getLatestWs();
    // Second connection should NOT include the stale sessionId
    expect(ws2.url).not.toContain('sessionId=dead-sess');
    vi.useRealTimers();
  });

  it('reconnects without sessionId on 4010 (daemon lost)', () => {
    vi.useFakeTimers();
    renderHook(() => useCliSocket({ sessionId: 'old-sess' }));
    const ws1 = getLatestWs();
    act(() => {
      ws1.simulateOpen();
      ws1.simulateMessage({ type: 'ready', sessionId: 'old-sess' });
    });
    // Daemon lost — server closes with 4010
    act(() => ws1.simulateClose(4010));
    act(() => { vi.advanceTimersByTime(1100); });
    expect(wsInstances).toHaveLength(2);
    const ws2 = getLatestWs();
    expect(ws2.url).not.toContain('sessionId=old-sess');
    vi.useRealTimers();
  });

  it('stops reconnecting after 5 failed attempts (no reset on onopen)', () => {
    vi.useFakeTimers();
    renderHook(() => useCliSocket({ sessionId: 'bad-sess' }));
    // Simulate 5 open-then-immediately-close cycles (e.g., server rejects)
    for (let i = 0; i < 5; i++) {
      const ws = getLatestWs();
      act(() => ws.simulateOpen()); // onopen fires but reconnectAttempts NOT reset
      act(() => ws.simulateClose(4003));
      act(() => { vi.advanceTimersByTime(60_000); }); // advance past any backoff
    }
    // Should have created exactly 6 WS instances (1 initial + 5 retries)
    expect(wsInstances).toHaveLength(6);
    // The 6th attempt: open + close should NOT schedule a 7th
    const ws6 = getLatestWs();
    act(() => ws6.simulateOpen());
    act(() => ws6.simulateClose(4003));
    act(() => { vi.advanceTimersByTime(60_000); });
    // Still only 6 — no more reconnects
    expect(wsInstances).toHaveLength(6);
    vi.useRealTimers();
  });

  it('resets reconnect attempts after successful ready', () => {
    vi.useFakeTimers();
    renderHook(() => useCliSocket());
    // First: fail twice with abnormal close (not a specific error code)
    for (let i = 0; i < 2; i++) {
      const ws = getLatestWs();
      act(() => ws.simulateOpen());
      act(() => ws.simulateClose(1006)); // abnormal closure
      act(() => { vi.advanceTimersByTime(60_000); });
    }
    const countAfterFailures = wsInstances.length;
    // Third attempt succeeds — ready event resets counter
    const ws3 = getLatestWs();
    act(() => {
      ws3.simulateOpen();
      ws3.simulateMessage({ type: 'ready', sessionId: 'new-sess' });
    });
    // Now disconnect again — should be able to reconnect (counter was reset)
    act(() => ws3.simulateClose(1006));
    act(() => { vi.advanceTimersByTime(1100); });
    expect(wsInstances.length).toBeGreaterThan(countAfterFailures);
    vi.useRealTimers();
  });

  it('flushes buffered input on ready (not on open)', () => {
    const { result } = renderHook(() => useCliSocket());
    // Buffer input while connecting
    act(() => result.current.send({ type: 'input', data: 'buffered' }));
    const ws = getLatestWs();
    act(() => ws.simulateOpen());
    // Input should NOT be flushed yet (no ready event)
    expect(ws.sentMessages).toHaveLength(0);
    // Ready event triggers flush
    act(() => ws.simulateMessage({ type: 'ready', sessionId: 'sess-1' }));
    expect(ws.sentMessages).toHaveLength(1);
    expect(JSON.parse(ws.sentMessages[0])).toEqual({ type: 'input', data: 'buffered' });
  });
});
