/**
 * Server-side performance monitor — tracks event loop lag, WebSocket
 * round-trip latency, and output batching stats so we can distinguish
 * backend stalls from client-side freezes.
 */

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
}

export function stopLagMonitor() {
  if (lagTimer) { clearTimeout(lagTimer); lagTimer = null; }
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

  return {
    eventLoop: {
      currentLagMs: Math.round(avgLag * 100) / 100,
      peakLagMs: Math.round(peakLagMs * 100) / 100,
      history: lagHistory.slice(-30),
    },
    sessions,
    uptimeMs: Math.round(performance.now()),
  };
}
