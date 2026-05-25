import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('perf-monitor', () => {
  let perfMonitor: typeof import('../server/perf-monitor');

  beforeEach(async () => {
    vi.resetModules();
    perfMonitor = await import('../server/perf-monitor');
  });

  afterEach(() => {
    perfMonitor.stopLagMonitor();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('traceStart records timing into stall buckets reflected in getPerfSnapshot', () => {
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(175)
      .mockReturnValue(250);

    const stop = perfMonitor.traceStart('render:frame');
    stop();

    const snapshot = perfMonitor.getPerfSnapshot();
    expect(snapshot.stallSources['render:frame']).toMatchObject({
      totalMs: 75,
      calls: 1,
      peakMs: 75,
      slowCalls: 1,
      avgMs: 75,
    });
  });

  it('recordApiCall creates api:route entries in stall buckets', () => {
    perfMonitor.recordApiCall('/api/reports', 60);
    perfMonitor.recordApiCall('/api/reports', 20);

    const snapshot = perfMonitor.getPerfSnapshot();
    expect(snapshot.stallSources['api:/api/reports']).toMatchObject({
      totalMs: 80,
      calls: 2,
      peakMs: 60,
      slowCalls: 1,
      avgMs: 40,
    });
  });

  it('getOrCreateSessionPerf creates once and returns the same session perf on subsequent calls', () => {
    const first = perfMonitor.getOrCreateSessionPerf('session-1');
    const second = perfMonitor.getOrCreateSessionPerf('session-1');

    expect(second).toBe(first);
    expect(first).toMatchObject({
      sessionId: 'session-1',
      pendingPingTs: null,
      batchCount: 0,
      batchTotalBytes: 0,
      batchMaxBytes: 0,
      flushCount: 0,
    });
    expect(first.latencyHistory).toEqual([]);
  });

  it('markPerfPingSent and recordPerfPong record latency', () => {
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(145)
      .mockReturnValue(200);

    perfMonitor.markPerfPingSent('session-1');
    perfMonitor.recordPerfPong('session-1');

    const snapshot = perfMonitor.getPerfSnapshot();
    expect(snapshot.sessions['session-1']).toMatchObject({
      latencyMs: {
        recent: 45,
        avg: 45,
        max: 45,
      },
    });
    expect(perfMonitor.getOrCreateSessionPerf('session-1').pendingPingTs).toBeNull();
  });

  it('recordOutputBatch tracks batch statistics', () => {
    perfMonitor.recordOutputBatch('session-1', 128);
    perfMonitor.recordOutputBatch('session-1', 512);

    const snapshot = perfMonitor.getPerfSnapshot();
    expect(snapshot.sessions['session-1'].output).toEqual({
      batchCount: 2,
      totalBytes: 640,
      maxBatchBytes: 512,
      flushCount: 0,
    });
  });

  it('recordFlush increments the flush count', () => {
    perfMonitor.recordFlush('session-1');
    perfMonitor.recordFlush('session-1');

    expect(perfMonitor.getPerfSnapshot().sessions['session-1'].output.flushCount).toBe(2);
  });

  it('removeSessionPerf removes session data', () => {
    perfMonitor.recordOutputBatch('session-1', 64);
    expect(perfMonitor.getPerfSnapshot().sessions['session-1']).toBeDefined();

    perfMonitor.removeSessionPerf('session-1');

    expect(perfMonitor.getPerfSnapshot().sessions['session-1']).toBeUndefined();
  });

  it('getPerfSnapshot returns the expected top-level shape', () => {
    const snapshot = perfMonitor.getPerfSnapshot();

    expect(snapshot).toEqual(
      expect.objectContaining({
        eventLoop: expect.objectContaining({
          currentLagMs: expect.any(Number),
          peakLagMs: expect.any(Number),
          history: expect.any(Array),
        }),
        gc: expect.objectContaining({
          count: expect.any(Number),
          totalMs: expect.any(Number),
          peakMs: expect.any(Number),
          recent: expect.any(Array),
        }),
        stallSources: expect.any(Object),
        sessions: expect.any(Object),
        uptimeMs: expect.any(Number),
      }),
    );
  });
});
