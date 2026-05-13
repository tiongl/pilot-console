/**
 * Server-side performance monitor — tracks event loop lag, WebSocket
 * round-trip latency, output batching stats, stall source attribution,
 * and V8 GC pauses so we can pinpoint the cause of freezes.
 */

import { PerformanceObserver, constants as perfConstants } from 'perf_hooks';

// ---------------------------------------------------------------------------
// Event loop lag
// ---------------------------------------------------------------------------

interface LagSample {
  ts: number;
  lagMs: number;
}

const LAG_HISTORY_SIZE = 120; // ~2 minutes at 1s interval
const lagHistory: LagSample[] = [];
let lagTimer: ReturnType<typeof setTimeout> | null = null;
let peakLagMs = 0;

function measureLag() {
  const expected = 1000; // 1s interval
  const start = performance.now();
  lagTimer = setTimeout(() => {
    const actual = performance.now() - start;
    const lag = Math.max(0, actual - expected);
    lagHistory.push({ ts: Date.now(), lagMs: Math.round(lag * 100) / 100 });
    if (lagHistory.length > LAG_HISTORY_SIZE) lagHistory.shift();
    if (lag > peakLagMs) peakLagMs = lag;
    measureLag();
  }, expected);
}

export function startLagMonitor() {
  if (lagTimer) return;
  measureLag();
  startGcMonitor();
}

export function stopLagMonitor() {
  if (lagTimer) { clearTimeout(lagTimer); lagTimer = null; }
}

// ---------------------------------------------------------------------------
// V8 Garbage Collection monitoring
// ---------------------------------------------------------------------------

interface GcEvent {
  ts: number;
  durationMs: number;
  kind: string;
}

const GC_HISTORY_SIZE = 60;
const gcHistory: GcEvent[] = [];
let gcPeakMs = 0;
let gcTotalMs = 0;
let gcCount = 0;

const GC_KIND_NAMES: Record<number, string> = {
  [perfConstants.NODE_PERFORMANCE_GC_MAJOR]: 'major',
  [perfConstants.NODE_PERFORMANCE_GC_MINOR]: 'minor',
  [perfConstants.NODE_PERFORMANCE_GC_INCREMENTAL]: 'incremental',
  [perfConstants.NODE_PERFORMANCE_GC_WEAKCB]: 'weakcb',
};

function startGcMonitor() {
  try {
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const dur = entry.duration;
        const kind = GC_KIND_NAMES[(entry as { detail?: { kind?: number } }).detail?.kind ?? -1] ?? 'unknown';
        gcHistory.push({ ts: Date.now(), durationMs: Math.round(dur * 100) / 100, kind });
        if (gcHistory.length > GC_HISTORY_SIZE) gcHistory.shift();
        if (dur > gcPeakMs) gcPeakMs = dur;
        gcTotalMs += dur;
        gcCount++;
      }
    });
    obs.observe({ type: 'gc', buffered: false });
  } catch {
    // GC observation not supported — silently skip
  }
}

// ---------------------------------------------------------------------------
// Stall source attribution — tracks time spent in key hot paths
// ---------------------------------------------------------------------------

interface StallBucket {
  /** Total time spent in this subsystem (ms) */
  totalMs: number;
  /** Number of calls */
  calls: number;
  /** Peak single-call duration (ms) */
  peakMs: number;
  /** Calls exceeding 50ms */
  slowCalls: number;
}

const stallBuckets = new Map<string, StallBucket>();

/** Start timing a hot-path section. Returns a stop function. */
export function traceStart(label: string): () => void {
  const start = performance.now();
  return () => {
    const dur = performance.now() - start;
    let bucket = stallBuckets.get(label);
    if (!bucket) {
      bucket = { totalMs: 0, calls: 0, peakMs: 0, slowCalls: 0 };
      stallBuckets.set(label, bucket);
    }
    bucket.totalMs += dur;
    bucket.calls++;
    if (dur > bucket.peakMs) bucket.peakMs = dur;
    if (dur > 50) bucket.slowCalls++;
  };
}

/** Record an API request duration for stall attribution */
export function recordApiCall(route: string, durationMs: number) {
  const label = 'api:' + route;
  let bucket = stallBuckets.get(label);
  if (!bucket) {
    bucket = { totalMs: 0, calls: 0, peakMs: 0, slowCalls: 0 };
    stallBuckets.set(label, bucket);
  }
  bucket.totalMs += durationMs;
  bucket.calls++;
  if (durationMs > bucket.peakMs) bucket.peakMs = durationMs;
  if (durationMs > 50) bucket.slowCalls++;
}

// ---------------------------------------------------------------------------
// Per-session WS round-trip latency
// ---------------------------------------------------------------------------

interface LatencySample {
  ts: number;
  rttMs: number;
}

interface SessionPerf {
  sessionId: string;
  /** Pending perf-ping awaiting pong */
  pendingPingTs: number | null;
  latencyHistory: LatencySample[];
  /** Output batch stats */
  batchCount: number;
  batchTotalBytes: number;
  batchMaxBytes: number;
  flushCount: number;
}

const sessionPerfs = new Map<string, SessionPerf>();
const LATENCY_HISTORY_SIZE = 60;

export function getOrCreateSessionPerf(sessionId: string): SessionPerf {
  let sp = sessionPerfs.get(sessionId);
  if (!sp) {
    sp = {
      sessionId,
      pendingPingTs: null,
      latencyHistory: [],
      batchCount: 0,
      batchTotalBytes: 0,
      batchMaxBytes: 0,
      flushCount: 0,
    };
    sessionPerfs.set(sessionId, sp);
  }
  return sp;
}

export function recordPerfPong(sessionId: string) {
  const sp = sessionPerfs.get(sessionId);
  if (!sp || sp.pendingPingTs === null) return;
  const rtt = performance.now() - sp.pendingPingTs;
  sp.latencyHistory.push({ ts: Date.now(), rttMs: Math.round(rtt * 100) / 100 });
  if (sp.latencyHistory.length > LATENCY_HISTORY_SIZE) sp.latencyHistory.shift();
  sp.pendingPingTs = null;
}

export function markPerfPingSent(sessionId: string) {
  const sp = getOrCreateSessionPerf(sessionId);
  sp.pendingPingTs = performance.now();
}

export function recordOutputBatch(sessionId: string, bytes: number) {
  const sp = getOrCreateSessionPerf(sessionId);
  sp.batchCount++;
  sp.batchTotalBytes += bytes;
  if (bytes > sp.batchMaxBytes) sp.batchMaxBytes = bytes;
}

export function recordFlush(sessionId: string) {
  const sp = getOrCreateSessionPerf(sessionId);
  sp.flushCount++;
}

export function removeSessionPerf(sessionId: string) {
  sessionPerfs.delete(sessionId);
}

// ---------------------------------------------------------------------------
// Snapshot for /api/perf
// ---------------------------------------------------------------------------

export function getPerfSnapshot() {
  const recentLag = lagHistory.slice(-10);
  const avgLag = recentLag.length
    ? recentLag.reduce((s, l) => s + l.lagMs, 0) / recentLag.length
    : 0;

  const sessions: Record<string, {
    latencyMs: { recent: number | null; avg: number | null; max: number | null };
    output: { batchCount: number; totalBytes: number; maxBatchBytes: number; flushCount: number };
  }> = {};

  for (const [id, sp] of sessionPerfs) {
    const recent = sp.latencyHistory.slice(-10);
    const avg = recent.length
      ? recent.reduce((s, l) => s + l.rttMs, 0) / recent.length
      : null;
    const max = recent.length
      ? Math.max(...recent.map((l) => l.rttMs))
      : null;
    const last = recent.length ? recent[recent.length - 1].rttMs : null;

    sessions[id] = {
      latencyMs: {
        recent: last !== null ? Math.round(last * 100) / 100 : null,
        avg: avg !== null ? Math.round(avg * 100) / 100 : null,
        max: max !== null ? Math.round(max * 100) / 100 : null,
      },
      output: {
        batchCount: sp.batchCount,
        totalBytes: sp.batchTotalBytes,
        maxBatchBytes: sp.batchMaxBytes,
        flushCount: sp.flushCount,
      },
    };
  }

  // Stall source attribution
  const stallSources: Record<string, {
    totalMs: number; calls: number; peakMs: number; slowCalls: number; avgMs: number;
  }> = {};
  for (const [label, bucket] of stallBuckets) {
    stallSources[label] = {
      totalMs: Math.round(bucket.totalMs * 100) / 100,
      calls: bucket.calls,
      peakMs: Math.round(bucket.peakMs * 100) / 100,
      slowCalls: bucket.slowCalls,
      avgMs: bucket.calls ? Math.round((bucket.totalMs / bucket.calls) * 100) / 100 : 0,
    };
  }

  return {
    eventLoop: {
      currentLagMs: Math.round(avgLag * 100) / 100,
      peakLagMs: Math.round(peakLagMs * 100) / 100,
      history: lagHistory.slice(-30),
    },
    gc: {
      count: gcCount,
      totalMs: Math.round(gcTotalMs * 100) / 100,
      peakMs: Math.round(gcPeakMs * 100) / 100,
      recent: gcHistory.slice(-20),
    },
    stallSources,
    sessions,
    uptimeMs: Math.round(performance.now()),
  };
}
