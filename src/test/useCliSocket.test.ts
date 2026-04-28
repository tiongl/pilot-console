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
});
