import { randomUUID } from 'crypto';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getDb } from './db';
import { getProjectById, getWorktreeById } from './project-store';
import { createWorktreeAgentTools } from './digest-tools';
import { createProjectLeadTools } from './project-lead-tools';
import { createChiefOfStaffTools } from './chief-of-staff-tools';
import { createMergeTools } from './merge-tools';
import { getOrBootstrapProjectMemory } from './project-memory-store';
import { getDaemonClient } from '../daemon/client';
import type {
  AgentServerMessage,
  AgentStatus,
  AgentMode,
  AgentTranscriptEvent,
  AgentModelOption,
  AgentSlashCommand,
  AgentSessionSummary,
  AgentShareMode,
  AgentShareStatus,
  AgentUsage,
  AgentSessionKind,
} from './types';
import type {
  CopilotClient as CopilotClientType,
  CopilotSession,
  SessionEvent,
  PermissionRequest,
  PermissionRequestResult,
  ExitPlanModeRequest,
  ExitPlanModeResult,
  Tool,
} from '@github/copilot-sdk';

const MAX_TRANSCRIPT_EVENTS = 5_000;
const SAVE_DEBOUNCE_MS = 1_500;
const TOOL_RECONCILE_MS = 5_000;
/** How often a busy session double-checks liveness against the runtime. */
const BUSY_WATCHDOG_MS = 15_000;
const DEFAULT_MODEL = 'auto';
const DEFAULT_MODE: AgentMode = 'interactive';
const MAX_DIFF_CHARS = 200_000;
// Per-entry byte caps keep a long session from growing transcript memory (and
// the persisted JSON blob / WS payloads) without bound. Tool output and args
// are the dominant hogs (file reads, big command output, large JSON args).
const MAX_TOOL_OUTPUT_CHARS = 50_000;
const MAX_TOOL_ARG_CHARS = 20_000;

/** Clamp text to `max` chars, appending a one-line truncation marker if cut. */
function clampText(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n… [truncated ${text.length - max} chars]`;
}

/** Clamp large tool args to a bounded string; keep small args as-is. */
function clampArgs(args: unknown): unknown {
  if (args === undefined) return undefined;
  let s: string;
  try {
    s = typeof args === 'string' ? args : JSON.stringify(args);
  } catch {
    s = String(args);
  }
  return s.length <= MAX_TOOL_ARG_CHARS ? args : clampText(s, MAX_TOOL_ARG_CHARS);
}

const execFileAsync = promisify(execFile);

export type AgentSubscriber = (msg: AgentServerMessage) => void;

interface PendingPermission {
  resolve: (result: PermissionRequestResult) => void;
  message: Extract<AgentServerMessage, { type: 'permission_request' }>;
}

interface PendingPlan {
  resolve: (result: ExitPlanModeResult) => void;
  message: Extract<AgentServerMessage, { type: 'exit_plan_request' }>;
}

export interface AgentSession {
  sessionId: string;
  userId: string;
  projectId: string | null;
  worktreeId: string | null;
  kind: AgentSessionKind;
  cwd: string;
  model: string;
  mode: AgentMode;
  status: AgentStatus;
  alive: boolean;
  transcript: AgentTranscriptEvent[];
  subscribers: Set<AgentSubscriber>;
  pendingPermissions: Map<string, PendingPermission>;
  pendingPlans: Map<string, PendingPlan>;
  sdk: CopilotSession;
  unsubscribe: () => void;
  saveTimer: ReturnType<typeof setTimeout> | null;
  toolReconcileTimer: ReturnType<typeof setInterval> | null;
  toolReconcileInFlight: boolean;
  /** Liveness poll that runs for as long as the session reports `busy`. */
  busyWatchdogTimer: ReturnType<typeof setInterval> | null;
  busyWatchdogInFlight: boolean;
  /** Maps SDK messageId → transcript entry id for streaming assistant messages */
  assistantByMessageId: Map<string, string>;
  /** Maps SDK messageId → `message_start` time, used to derive reply duration. */
  assistantStartTs: Map<string, number>;
  /**
   * Wall-clock start of the in-flight turn: the moment the user's request was
   * submitted. Durations reported to the UI are measured from here through to
   * completion so they cover the whole round trip (queueing, thinking, tools),
   * not just token generation. Null whenever the session is idle.
   */
  turnStartTs: number | null;
  /** Maps SDK toolCallId → transcript entry id for tool activity */
  toolByCallId: Map<string, string>;
  /** Current GitHub session-sharing state (remote-control mode). */
  share: AgentShareStatus;
  /** Accumulated token/billing usage across every model call in the session. */
  usage: AgentUsage;
  /** When true, every permission request is auto-approved without prompting. */
  allowAllPermissions: boolean;
  /**
   * Follow-up prompts the user submitted while a turn was already in flight.
   * The SDK accepts one turn at a time, so instead of rejecting the input (or
   * forcing the user to wait for a long delegation to finish) we hold it here
   * and send it the moment the session goes idle. Optional so session objects
   * built before this field existed stay assignable.
   */
  queuedPrompts?: string[];
}

const agentSessions = new Map<string, AgentSession>();

/**
 * In-flight `resumeAgentSession` calls, keyed by the requested session id.
 *
 * Resuming is a slow, awaited round trip (`client.resumeSession`), and the
 * session is only registered in `agentSessions` once that resolves. Without
 * this guard, two overlapping connects for the same id — a reconnect storm, a
 * StrictMode double-mount, or two panes bound to the same Chief-of-Staff/Lead
 * session — each build a *separate* session object with its own SDK connection
 * and its own `pendingPermissions` map. Whichever registers last wins, so the
 * permission promise the runtime is actually blocked on can end up stranded in
 * an orphaned object that `setAllowAllPermissions` / `setAgentMode` /
 * `respondToPermission` (all keyed by `agentSessions.get`) can never resolve —
 * the "allow all / autopilot does nothing on a reloaded session" symptom.
 * Coalescing concurrent resumes onto one promise keeps a single canonical
 * session object per id.
 */
const resumeInFlight = new Map<string, Promise<AgentSession | undefined>>();
const persistentLeadInFlight = new Map<string, Promise<AgentSession>>();

// ---------------------------------------------------------------------------
// Shared Copilot SDK client (lazy singleton)
//
// The runtime process is hosted by the session daemon, so agent sessions keep
// running across UI-server restarts. We attach to it with
// `RuntimeConnection.forUri`, which explicitly does not spawn a process — and
// therefore `client.stop()` never terminates it. If the daemon is unavailable
// we fall back to spawning an in-process runtime so agent mode still works
// (at the cost of the old restart-kills-sessions behaviour).
// ---------------------------------------------------------------------------

let clientPromise: Promise<CopilotClientType> | null = null;
let modelsCache: AgentModelOption[] | null = null;
let modelsPromise: Promise<AgentModelOption[]> | null = null;
/** True when the current client spawned its own runtime (daemon unavailable). */
let clientOwnsRuntime = true;

export function isRuntimeHostedByDaemon(): boolean {
  return clientPromise !== null && !clientOwnsRuntime;
}

async function connectHostedRuntime(restart = false): Promise<CopilotClientType | null> {
  const { CopilotClient, RuntimeConnection } = await import('@github/copilot-sdk');
  let descriptor;
  try {
    descriptor = await getDaemonClient().runtimeInfo(restart);
  } catch (err) {
    console.error('[agent-bridge] daemon-hosted runtime unavailable:', err);
    return null;
  }
  const client = new CopilotClient({
    connection: RuntimeConnection.forUri(`${descriptor.host}:${descriptor.port}`, {
      connectionToken: descriptor.connectionToken,
    }),
  });
  try {
    await client.start();
  } catch (err) {
    console.error('[agent-bridge] failed to attach to the daemon-hosted runtime:', err);
    return null;
  }
  console.log(`[agent-bridge] Attached to daemon-hosted runtime at ${descriptor.host}:${descriptor.port}`);
  return client;
}

async function spawnLocalRuntime(): Promise<CopilotClientType> {
  // Imported lazily so environments without the SDK installed can still
  // load the rest of the server (terminal modes) without crashing.
  const { CopilotClient } = await import('@github/copilot-sdk');
  const client = new CopilotClient();
  await client.start();
  console.warn('[agent-bridge] Using an in-process runtime — sessions will not survive a server restart.');
  return client;
}

async function getClient(): Promise<CopilotClientType> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const hosted = await connectHostedRuntime();
      if (hosted) {
        clientOwnsRuntime = false;
        return hosted;
      }
      clientOwnsRuntime = true;
      return spawnLocalRuntime();
    })().catch((err) => {
      // Reset so a later attempt can retry after a transient failure.
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

/**
 * Drop the cached client and reattach, asking the daemon for a fresh runtime.
 * Used when the descriptor went stale (daemon restarted, runtime died).
 */
export async function reconnectAgentRuntime(): Promise<void> {
  const previous = clientPromise;
  clientPromise = null;
  modelsCache = null;
  modelsPromise = null;
  // Every in-memory handle points at the runtime we are about to replace.
  // Leaving them behind makes `findAgentSession` hand out sessions backed by
  // a dead connection, which is what kept a blank lead conversation pinned
  // in place even after the real one became resumable again. Flush their
  // state first so nothing is lost, then force the next connect to re-resolve
  // from the database.
  for (const session of agentSessions.values()) {
    if (session.saveTimer) {
      clearTimeout(session.saveTimer);
      session.saveTimer = null;
    }
    stopToolReconciliation(session);
    stopBusyWatchdog(session);
    try {
      session.unsubscribe();
    } catch {
      /* ignore */
    }
    persistTranscript(session, true);
    persistAgentState(session);
  }
  agentSessions.clear();
  if (previous) {
    try {
      const client = await previous;
      await client.stop();
    } catch {
      /* the old runtime is already gone */
    }
  }
  clientPromise = (async () => {
    const hosted = await connectHostedRuntime(true);
    if (hosted) {
      clientOwnsRuntime = false;
      return hosted;
    }
    clientOwnsRuntime = true;
    return spawnLocalRuntime();
  })().catch((err) => {
    clientPromise = null;
    throw err;
  });
  await clientPromise;
}

/**
 * List available models for the agent-mode model picker (cached).
 *
 * An empty result is treated as a failure rather than cached: it means the
 * runtime answered before it was ready, and caching it would leave every tab
 * stuck with only "Auto" until the server restarted. Concurrent callers share
 * one in-flight request so opening several tabs does not fan out.
 */
export async function listAgentModels(): Promise<AgentModelOption[]> {
  if (modelsCache) return modelsCache;
  if (modelsPromise) return modelsPromise;

  modelsPromise = (async () => {
    const client = await getClient();
    const models = await client.listModels();
    const options = models.map((m) => ({ id: m.id, name: m.name || m.id }));
    if (options.length === 0) throw new Error('runtime returned no models');
    // The SDK does not advertise the implicit default, but it is a valid
    // selection and is what a fresh session starts on.
    if (!options.some((m) => m.id === DEFAULT_MODEL)) {
      options.unshift({ id: DEFAULT_MODEL, name: 'Auto' });
    }
    modelsCache = options;
    return options;
  })();

  try {
    return await modelsPromise;
  } finally {
    modelsPromise = null;
  }
}

// ---------------------------------------------------------------------------
// cwd resolution (mirrors cli-bridge)
// ---------------------------------------------------------------------------

function resolveCwd(projectId: string | null, worktreeId: string | null): string {
  if (worktreeId) {
    const wt = getWorktreeById(worktreeId);
    if (wt?.worktreePath && safeExists(wt.worktreePath)) return wt.worktreePath;
  }
  if (projectId) {
    const project = getProjectById(projectId);
    if (project?.repoPath && safeExists(project.repoPath)) return project.repoPath;
  }
  return process.cwd();
}

function safeExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/** Strip trailing separators and normalize slashes/case for cwd comparison. */
function normalizeCwd(p: string): string {
  const slashed = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
}

/**
 * True when `sessionCwd` is `root` or lives underneath it.
 *
 * The runtime's own `session.list` filter compares `context.cwd` byte-for-byte,
 * which silently drops history whenever the recorded path differs only in
 * slash direction or drive-letter case, and always drops sessions started in a
 * subdirectory of the repo. Matching here instead keeps the /resume switcher in
 * step with the project session history panel, which has always used
 * prefix-with-boundary matching.
 */
export function cwdMatches(sessionCwd: string | undefined, root: string): boolean {
  if (!sessionCwd) return false;
  const a = normalizeCwd(sessionCwd);
  const b = normalizeCwd(root);
  return a === b || a.startsWith(`${b}/`);
}

/**
 * Every session recorded for `cwd` (or a subdirectory of it), newest first.
 *
 * Deliberately lists unfiltered and filters locally: the runtime's server-side
 * cwd filter is both stricter than we want and measurably slower than fetching
 * the whole list (~95ms unfiltered vs ~256ms filtered against a 1000-session
 * store), so there is nothing to gain by pushing the predicate down.
 */
async function listSessionMetasForCwd(
  client: CopilotClientType,
  cwd: string,
): Promise<Awaited<ReturnType<CopilotClientType['listSessions']>>> {
  const metas = await client.listSessions();
  return metas.filter((m) => cwdMatches(m.context?.workingDirectory, cwd));
}

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

export function getAgentSession(sessionId: string): AgentSession | undefined {
  return agentSessions.get(sessionId);
}

export function listLiveAgentSessions() {
  return [...agentSessions.values()]
    .filter((session) => session.alive)
    .map((session) => ({
      sessionId: session.sessionId,
      projectId: session.projectId,
      worktreeId: session.worktreeId,
      kind: session.kind,
      status: session.status,
      mode: session.mode,
      cwd: session.cwd,
    }));
}

export function findAgentSession(
  userId: string,
  projectId: string | null,
  worktreeId: string | null,
  kind: AgentSessionKind = 'agent',
): AgentSession | undefined {
  for (const s of agentSessions.values()) {
    if (
      s.userId === userId &&
      s.projectId === projectId &&
      (s.worktreeId ?? null) === (worktreeId ?? null) &&
      s.kind === kind &&
      s.alive
    ) {
      return s;
    }
  }
  return undefined;
}

/**
 * Close out empty lead/CoS rows once we have settled on the live conversation.
 *
 * Each failed resume used to leave a blank session behind, and those rows are
 * what made this "singleton" grow without bound. Only rows with no transcript
 * are retired, and never one that is still live in this process, so a real
 * conversation can never be discarded.
 */
function retireEmptyLeadSessions(
  userId: string,
  kind: Extract<AgentSessionKind, 'project_lead' | 'chief_of_staff'>,
  projectId: string | null,
  keepSessionId: string,
): void {
  try {
    const stale = getDb().prepare(`
      SELECT id
      FROM cli_sessions
      WHERE user_id = ?
        AND kind = ?
        AND project_id IS ?
        AND worktree_id IS NULL
        AND ended_at IS NULL
        AND id != ?
        AND (output_log IS NULL OR length(output_log) <= 2)
    `).all(userId, kind, projectId, keepSessionId) as Array<{ id: string }>;

    const retire = getDb().prepare(
      "UPDATE cli_sessions SET ended_at = datetime('now') WHERE id = ?",
    );
    for (const row of stale) {
      const live = agentSessions.get(row.id);
      if (live?.alive) continue;
      retire.run(row.id);
    }
  } catch {
    /* housekeeping only — never block opening the conversation */
  }
}

function persistentLeadKey(
  userId: string,
  kind: Extract<AgentSessionKind, 'project_lead' | 'chief_of_staff'>,
  projectId: string | null,
): string {
  return `${userId}:${kind}:${projectId ?? ''}`;
}

/**
 * Return the single durable lead conversation for this user and scope.
 *
 * A live session wins, except when it is still empty and a stored
 * conversation exists: failed resumes leave blank sessions behind, and
 * preferring one would pin an empty chat in place of the user's real history.
 * Concurrent mounts share one create/resume path.
 */
export async function getOrCreatePersistentLeadSession(
  userId: string,
  projectId: string | null,
  kind: Extract<AgentSessionKind, 'project_lead' | 'chief_of_staff'>,
  model?: string,
): Promise<AgentSession> {
  const live = findAgentSession(userId, projectId, null, kind);
  if (live && live.transcript.length > 0) return live;

  const key = persistentLeadKey(userId, kind, projectId);
  const pending = persistentLeadInFlight.get(key);
  if (pending) return pending;

  const run = (async () => {
    // Prefer the conversation that actually has history. Failed resumes used
    // to leave behind empty rows with a newer `started_at`, so ordering by
    // recency alone hands the user a blank session and buries the real one.
    // `length(output_log) > 2` skips both NULL and an empty JSON array.
    const rows = getDb().prepare(`
      SELECT id
      FROM cli_sessions
      WHERE user_id = ?
        AND kind = ?
        AND project_id IS ?
        AND worktree_id IS NULL
        AND ended_at IS NULL
      ORDER BY (output_log IS NOT NULL AND length(output_log) > 2) DESC,
               started_at DESC,
               rowid DESC
      LIMIT 20
    `).all(userId, kind, projectId) as Array<{ id: string }>;

    for (const row of rows) {
      // The blank live session is already attached; resuming it again would
      // clash with its own tool registrations.
      if (row.id === live?.sessionId) continue;
      const resumed = await resumeAgentSession(userId, row.id);
      if (resumed) {
        retireEmptyLeadSessions(userId, kind, projectId, resumed.sessionId);
        return resumed;
      }
    }

    // Nothing stored could be reopened — reuse the empty live session rather
    // than stacking up another one.
    if (live) return live;

    const created = await createAgentSession(userId, projectId, null, model, kind);
    retireEmptyLeadSessions(userId, kind, projectId, created.sessionId);
    return created;
  })().finally(() => {
    persistentLeadInFlight.delete(key);
  });

  persistentLeadInFlight.set(key, run);
  return run;
}

// ---------------------------------------------------------------------------
// Fan-out + transcript management
// ---------------------------------------------------------------------------

function emit(session: AgentSession, msg: AgentServerMessage): void {
  for (const sub of session.subscribers) {
    try {
      sub(msg);
    } catch {
      /* ignore subscriber errors */
    }
  }
}

/** Upsert a transcript entry (keyed by id) and broadcast it. */
function upsertEvent(session: AgentSession, event: AgentTranscriptEvent): void {
  const idx = session.transcript.findIndex((e) => e.id === event.id);
  if (idx >= 0) {
    session.transcript[idx] = event;
  } else {
    session.transcript.push(event);
    if (session.transcript.length > MAX_TRANSCRIPT_EVENTS) {
      session.transcript.splice(0, session.transcript.length - MAX_TRANSCRIPT_EVENTS);
    }
  }
  emit(session, { type: 'event', event });
  scheduleSave(session);
}

function setStatus(session: AgentSession, status: AgentStatus): void {
  if (session.status === status) return;
  session.status = status;
  // Anchor the turn clock the first time we go busy and clear it on completion,
  // so every duration the UI renders spans user-request → done.
  if (status === 'busy') {
    if (session.turnStartTs === null) session.turnStartTs = Date.now();
  } else {
    session.turnStartTs = null;
  }
  emit(session, { type: 'status', status, turnStartedAt: session.turnStartTs });
  if (status === 'busy') ensureBusyWatchdog(session);
  else {
    stopBusyWatchdog(session);
    // The turn that was blocking the user's follow-ups just ended — send the
    // next one. Deferred so this runs after the current event handler unwinds.
    if (session.queuedPrompts?.length) queueMicrotask(() => void flushQueuedPrompts(session));
  }
}

function emitQueued(session: AgentSession): void {
  emit(session, { type: 'queued', prompts: [...(session.queuedPrompts ?? [])] });
}

/** Send the oldest queued follow-up, if the session is idle and still alive. */
export async function flushQueuedPrompts(session: AgentSession): Promise<void> {
  if (!session.alive || session.status === 'busy') return;
  const next = session.queuedPrompts?.shift();
  if (next === undefined) return;
  emitQueued(session);
  await sendToSession(session, next);
}

/** Follow-ups waiting to be sent, oldest first. */
export function getQueuedPrompts(sessionId: string): string[] {
  return [...(agentSessions.get(sessionId)?.queuedPrompts ?? [])];
}

/** Drop a queued follow-up the user changed their mind about. */
export function dequeuePrompt(sessionId: string, index: number): void {
  const session = agentSessions.get(sessionId);
  if (!session?.queuedPrompts) return;
  if (index < 0 || index >= session.queuedPrompts.length) return;
  session.queuedPrompts.splice(index, 1);
  emitQueued(session);
}

// ---------------------------------------------------------------------------
// Busy watchdog
//
// `busy` is normally cleared by a `session.idle` / `assistant.idle` / `abort` /
// `session.error` event. If one of those is missed — the socket dropped, the
// turn finished while we were detached, or the runtime lost the session — the
// UI shows a spinner forever and the agent looks hung. While a session is busy
// we therefore poll the runtime's own event log and settle the status from it.
// ---------------------------------------------------------------------------

function stopBusyWatchdog(session: AgentSession): void {
  if (!session.busyWatchdogTimer) return;
  clearInterval(session.busyWatchdogTimer);
  session.busyWatchdogTimer = null;
}

function ensureBusyWatchdog(session: AgentSession): void {
  if (session.busyWatchdogTimer || !session.sdk || typeof session.sdk.getEvents !== 'function') return;
  session.busyWatchdogTimer = setInterval(() => {
    void checkBusyLiveness(session);
  }, BUSY_WATCHDOG_MS);
}

export async function checkBusyLiveness(session: AgentSession): Promise<void> {
  if (!session.alive || session.status !== 'busy' || session.busyWatchdogInFlight) return;
  session.busyWatchdogInFlight = true;
  try {
    const events = await session.sdk.getEvents();
    reconcileToolTranscript(session, events);
    if (deriveStatusFromEvents(events) === 'idle') {
      finalizeRunningTools(session, 'Tool ended without returning a completion result.');
      setStatus(session, 'idle');
      upsertEvent(session, {
        kind: 'notice',
        id: `notice:watchdog:${Date.now()}`,
        ts: Date.now(),
        message: 'The turn ended without a completion event; status recovered from the runtime.',
      });
    }
  } catch (err) {
    // The runtime no longer knows this session (it died, or the daemon
    // restarted). Leaving the user staring at a spinner is the worst outcome.
    console.error(`[agent-bridge] busy watchdog failed for ${session.sessionId}:`, err);
    finalizeRunningTools(session, 'Lost contact with the agent runtime.');
    setStatus(session, 'idle');
    upsertEvent(session, {
      kind: 'error',
      id: `error:watchdog:${Date.now()}`,
      ts: Date.now(),
      message: 'Lost contact with the agent runtime. Reconnect or start a new session to continue.',
    });
  } finally {
    session.busyWatchdogInFlight = false;
  }
}

function runningTools(session: AgentSession) {
  return session.transcript.filter(
    (event): event is Extract<AgentTranscriptEvent, { kind: 'tool' }> =>
      event.kind === 'tool' && event.status === 'running',
  );
}

/** Find a live worktree-agent session without requiring the lead to know its user id. */
export function findLiveWorktreeAgent(projectId: string, worktreeId: string): AgentSession | undefined {
  for (const session of agentSessions.values()) {
    if (
      session.alive &&
      session.kind === 'agent' &&
      session.projectId === projectId &&
      session.worktreeId === worktreeId
    ) {
      return session;
    }
  }
  return undefined;
}

function stopToolReconciliation(session: AgentSession): void {
  if (!session.toolReconcileTimer) return;
  clearInterval(session.toolReconcileTimer);
  session.toolReconcileTimer = null;
}

function ensureToolReconciliation(session: AgentSession): void {
  if (
    session.toolReconcileTimer ||
    runningTools(session).length === 0 ||
    !session.sdk ||
    typeof session.sdk.getEvents !== 'function'
  ) {
    return;
  }
  session.toolReconcileTimer = setInterval(() => {
    void reconcileAgentTools(session);
  }, TOOL_RECONCILE_MS);
}

async function reconcileAgentTools(session: AgentSession): Promise<void> {
  if (!session.alive || session.toolReconcileInFlight || runningTools(session).length === 0) {
    if (runningTools(session).length === 0) stopToolReconciliation(session);
    return;
  }
  session.toolReconcileInFlight = true;
  try {
    reconcileToolTranscript(session, await session.sdk.getEvents());
  } catch (err) {
    console.error(`[agent-bridge] tool reconciliation failed for ${session.sessionId}:`, err);
  } finally {
    session.toolReconcileInFlight = false;
    if (runningTools(session).length === 0) stopToolReconciliation(session);
  }
}

// ---------------------------------------------------------------------------
// SDK event normalization
// ---------------------------------------------------------------------------

/**
 * The wall-clock time an event actually happened, as recorded by the runtime.
 *
 * Every SDK event carries an ISO 8601 `timestamp`. Using it rather than
 * `Date.now()` matters for replay: rebuilding a week-old session from the
 * persisted log would otherwise stamp every bubble with the current time.
 */
export function eventTs(event: SessionEvent): number {
  const raw = (event as unknown as { timestamp?: string | number | Date }).timestamp;
  if (raw instanceof Date) {
    const t = raw.getTime();
    if (!Number.isNaN(t)) return t;
  } else if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw;
  } else if (typeof raw === 'string') {
    const t = Date.parse(raw);
    if (!Number.isNaN(t)) return t;
  }
  return Date.now();
}

/** A finite number, or 0 — usage fields are all optional in the SDK payloads. */
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** A zeroed usage accumulator for a fresh (or reset) session. */
export function emptyAgentUsage(): AgentUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    requests: 0,
    premiumRequests: 0,
    nanoAiu: 0,
  };
}

function emitUsage(session: AgentSession): void {
  emit(session, { type: 'usage', usage: { ...session.usage } });
}

/**
 * Normalize a raw SDK `SessionEvent` into transcript entries + subscriber
 * broadcasts. Exported for unit testing of the event-mapping logic.
 */
export function handleSdkEvent(session: AgentSession, event: SessionEvent): void {
  const ts = eventTs(event);
  switch (event.type) {
    case 'user.message': {
      const content = (event.data as { content?: string }).content ?? '';
      // The user's request is the origin of the turn clock: everything that
      // follows is reported as elapsed time from this moment.
      session.turnStartTs = ts;
      upsertEvent(session, { kind: 'user', id: event.id, ts, content });
      break;
    }
    case 'assistant.turn_start': {
      setStatus(session, 'busy');
      break;
    }
    case 'assistant.message_start': {
      // Only remember the id mapping. The transcript entry is created lazily by
      // the first delta (or the final message) so turns that produce no text
      // — tool-only turns, for example — never leave an empty bubble behind.
      const messageId = (event.data as { messageId: string }).messageId;
      session.assistantByMessageId.set(messageId, `assistant:${messageId}`);
      // Remember when generation began so the final message can report how long
      // it took, including time-to-first-token.
      session.assistantStartTs.set(messageId, ts);
      break;
    }
    case 'assistant.message_delta': {
      const data = event.data as { messageId: string; deltaContent: string };
      const entryId = session.assistantByMessageId.get(data.messageId) ?? `assistant:${data.messageId}`;
      session.assistantByMessageId.set(data.messageId, entryId);
      // Apply delta to the buffered entry so replay reflects streamed text.
      const entry = session.transcript.find((e) => e.id === entryId);
      if (entry && entry.kind === 'assistant') {
        entry.content += data.deltaContent;
        emit(session, { type: 'assistant_delta', id: entryId, delta: data.deltaContent });
      } else {
        const startTs = session.assistantStartTs.get(data.messageId) ?? ts;
        upsertEvent(session, { kind: 'assistant', id: entryId, ts: startTs, content: data.deltaContent });
      }
      break;
    }
    case 'assistant.message': {
      const data = event.data as { messageId?: string; content?: string };
      const messageId = data.messageId;
      const entryId = (messageId && session.assistantByMessageId.get(messageId)) || `assistant:${messageId ?? event.id}`;
      const content = data.content ?? '';
      // Never create an empty bubble, and never clobber streamed text with an
      // empty final payload.
      if (!content) break;
      const startTs = (messageId ? session.assistantStartTs.get(messageId) : undefined) ?? ts;
      if (messageId) session.assistantStartTs.delete(messageId);
      // Duration is measured from the user's request, not from the first token,
      // so it reflects the wait the user actually experienced.
      const originTs = session.turnStartTs ?? startTs;
      upsertEvent(session, {
        kind: 'assistant',
        id: entryId,
        ts: startTs,
        content,
        durationMs: Math.max(0, ts - originTs),
      });
      break;
    }
    case 'assistant.reasoning': {
      const content = (event.data as { content?: string }).content ?? '';
      if (content) upsertEvent(session, { kind: 'reasoning', id: `reasoning:${event.id}`, ts, content });
      break;
    }
    case 'system.message': {
      const content = (event.data as { content?: string }).content ?? '';
      if (content) upsertEvent(session, { kind: 'system', id: `system:${event.id}`, ts, content });
      break;
    }
    case 'tool.execution_start': {
      const data = event.data as { toolCallId: string; toolName: string; arguments?: unknown };
      const entryId = `tool:${data.toolCallId}`;
      session.toolByCallId.set(data.toolCallId, entryId);
      upsertEvent(session, {
        kind: 'tool',
        id: entryId,
        ts,
        toolCallId: data.toolCallId,
        toolName: data.toolName,
        args: clampArgs(data.arguments),
        status: 'running',
      });
      ensureToolReconciliation(session);
      break;
    }
    case 'tool.execution_partial_result': {
      const data = event.data as { toolCallId: string; partialOutput: string };
      const entryId = session.toolByCallId.get(data.toolCallId);
      if (entryId) {
        const entry = session.transcript.find((e) => e.id === entryId);
        if (entry && entry.kind === 'tool')
          entry.output = clampText((entry.output ?? '') + data.partialOutput, MAX_TOOL_OUTPUT_CHARS);
        emit(session, { type: 'tool_delta', id: entryId, delta: data.partialOutput });
      }
      break;
    }
    case 'tool.execution_progress': {
      const data = event.data as { toolCallId: string; progressMessage: string };
      const entryId = session.toolByCallId.get(data.toolCallId);
      if (entryId) {
        const entry = session.transcript.find((item) => item.id === entryId);
        if (entry && entry.kind === 'tool') {
          upsertEvent(session, { ...entry, progress: data.progressMessage });
        }
      }
      break;
    }
    case 'tool.execution_complete': {
      const data = event.data as {
        toolCallId: string;
        success: boolean;
        result?: { content?: string; detailedContent?: string } | string;
        error?: { message?: string };
      };
      const entryId = session.toolByCallId.get(data.toolCallId) ?? `tool:${data.toolCallId}`;
      const existing = session.transcript.find((e) => e.id === entryId);
      const prior = existing && existing.kind === 'tool' ? existing : undefined;
      const resultText =
        typeof data.result === 'string'
          ? data.result
          : (data.result?.detailedContent ?? data.result?.content ?? data.error?.message ?? prior?.output);
      upsertEvent(session, {
        kind: 'tool',
        id: entryId,
        ts: prior?.ts ?? ts,
        toolCallId: data.toolCallId,
        toolName: prior?.toolName ?? 'tool',
        args: prior?.args,
        status: data.success ? 'success' : 'error',
        output: resultText === undefined ? undefined : clampText(resultText, MAX_TOOL_OUTPUT_CHARS),
        durationMs: prior ? Math.max(0, ts - prior.ts) : undefined,
      });
      if (runningTools(session).length === 0) stopToolReconciliation(session);
      break;
    }
    case 'session.error': {
      const message = (event.data as { message?: string }).message ?? 'Unknown error';
      upsertEvent(session, { kind: 'error', id: `error:${event.id}`, ts, message });
      setStatus(session, 'idle');
      break;
    }
    case 'session.idle':
    case 'assistant.idle': {
      finalizeRunningTools(session, 'Tool ended without returning a completion result.');
      setStatus(session, 'idle');
      break;
    }
    case 'abort': {
      finalizeRunningTools(session, 'Tool execution was aborted.');
      setStatus(session, 'idle');
      break;
    }
    case 'assistant.usage': {
      const data = event.data as {
        inputTokens?: number;
        outputTokens?: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
        reasoningTokens?: number;
        cost?: number;
        copilotUsage?: { totalNanoAiu?: number };
      };
      const u = session.usage;
      u.requests += 1;
      u.inputTokens += num(data.inputTokens);
      u.outputTokens += num(data.outputTokens);
      u.cachedTokens += num(data.cacheReadTokens) + num(data.cacheWriteTokens);
      u.reasoningTokens += num(data.reasoningTokens);
      u.premiumRequests += num(data.cost);
      u.nanoAiu += num(data.copilotUsage?.totalNanoAiu);
      emitUsage(session);
      break;
    }
    case 'session.usage_checkpoint': {
      // Durable accounting written by the runtime so a resumed session can
      // recover its session-wide cost. It is absolute, not incremental.
      const total = num((event.data as { totalNanoAiu?: number }).totalNanoAiu);
      if (total > session.usage.nanoAiu) {
        session.usage.nanoAiu = total;
        emitUsage(session);
      }
      break;
    }
    case 'session.usage_info': {
      const data = event.data as { currentTokens?: number; tokenLimit?: number };
      session.usage.contextTokens = num(data.currentTokens);
      session.usage.contextLimit = num(data.tokenLimit);
      emitUsage(session);
      break;
    }
    case 'session.remote_steerable_changed': {
      const steerable = Boolean((event.data as { remoteSteerable?: boolean }).remoteSteerable);
      session.share.steerable = steerable;
      // Steering implies the session is at least exported; reflect that.
      if (steerable && session.share.mode === 'off') session.share.mode = 'on';
      emit(session, { type: 'share_status', status: { ...session.share } });
      break;
    }
    default:
      break;
  }
}

function finalizeRunningTools(session: AgentSession, message: string): void {
  for (const event of runningTools(session)) {
    upsertEvent(session, {
      ...event,
      status: 'error',
      output: event.output ? `${event.output}\n${message}` : message,
    });
  }
  stopToolReconciliation(session);
}

export function reconcileToolTranscript(session: AgentSession, events: SessionEvent[]): void {
  const snapshots = new Map<
    string,
    {
      partialOutput: string;
      progress?: string;
      complete?: SessionEvent;
      endedWithoutCompletion?: string;
    }
  >();
  const active = new Set<string>();

  for (const event of events) {
    if (event.type === 'tool.execution_start') {
      const { toolCallId } = event.data as { toolCallId: string };
      snapshots.set(toolCallId, { partialOutput: '' });
      active.add(toolCallId);
      continue;
    }
    if (event.type === 'tool.execution_partial_result') {
      const data = event.data as { toolCallId: string; partialOutput: string };
      const snapshot = snapshots.get(data.toolCallId);
      if (snapshot) snapshot.partialOutput += data.partialOutput;
      continue;
    }
    if (event.type === 'tool.execution_progress') {
      const data = event.data as { toolCallId: string; progressMessage: string };
      const snapshot = snapshots.get(data.toolCallId);
      if (snapshot) snapshot.progress = data.progressMessage;
      continue;
    }
    if (event.type === 'tool.execution_complete') {
      const { toolCallId } = event.data as { toolCallId: string };
      const snapshot = snapshots.get(toolCallId);
      if (snapshot) snapshot.complete = event;
      active.delete(toolCallId);
      continue;
    }
    if (event.type === 'session.idle' || event.type === 'assistant.idle' || event.type === 'abort') {
      const reason =
        event.type === 'abort'
          ? 'Tool execution was aborted.'
          : 'Tool ended without returning a completion result.';
      for (const toolCallId of active) {
        const snapshot = snapshots.get(toolCallId);
        if (snapshot) snapshot.endedWithoutCompletion = reason;
      }
      active.clear();
    }
  }

  for (const tool of runningTools(session)) {
    const snapshot = snapshots.get(tool.toolCallId);
    if (!snapshot) continue;
    if (snapshot.complete) {
      handleSdkEvent(session, snapshot.complete);
      continue;
    }
    if (snapshot.endedWithoutCompletion) {
      upsertEvent(session, {
        ...tool,
        status: 'error',
        progress: snapshot.progress,
        output: snapshot.partialOutput
          ? `${snapshot.partialOutput}\n${snapshot.endedWithoutCompletion}`
          : snapshot.endedWithoutCompletion,
      });
      continue;
    }
    if (tool.output !== snapshot.partialOutput || tool.progress !== snapshot.progress) {
      upsertEvent(session, {
        ...tool,
        progress: snapshot.progress,
        output: snapshot.partialOutput || undefined,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Permission handling
// ---------------------------------------------------------------------------

function describePermission(request: PermissionRequest): {
  title: string;
  detail: string;
  canSession: boolean;
} {
  const r = request as unknown as Record<string, unknown>;
  switch (request.kind) {
    case 'shell':
      return {
        title: 'Run shell command',
        detail: String(r.fullCommandText ?? r.intention ?? ''),
        canSession: Boolean(r.canOfferSessionApproval),
      };
    case 'write':
      return {
        title: 'Write file',
        detail: String(r.fileName ?? r.path ?? ''),
        canSession: Boolean(r.canOfferSessionApproval),
      };
    case 'read':
      return {
        title: 'Read file',
        detail: String(r.fileName ?? r.path ?? ''),
        canSession: Boolean(r.canOfferSessionApproval),
      };
    case 'mcp':
      return {
        title: `Run MCP tool ${String(r.toolName ?? '')}`.trim(),
        detail: safeJson(r.args),
        canSession: Boolean(r.canOfferSessionApproval),
      };
    case 'url':
      return { title: 'Access URL', detail: String(r.url ?? ''), canSession: Boolean(r.canOfferSessionApproval) };
    default:
      return {
        title: `Permission: ${request.kind}`,
        detail: safeJson(request),
        canSession: Boolean(r.canOfferSessionApproval),
      };
  }
}

function safeJson(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** How long a prompt waits for its session to finish registering. */
const SESSION_REGISTER_WAIT_MS = 10_000;
const SESSION_REGISTER_POLL_MS = 25;

/**
 * Resolve the session for a callback that may fire before the session object
 * has been assigned (the SDK can deliver events during `createSession` /
 * `resumeSession`). Returns undefined if it never shows up.
 */
async function waitForSession(
  getSession: () => AgentSession | undefined,
): Promise<AgentSession | undefined> {
  const deadline = Date.now() + SESSION_REGISTER_WAIT_MS;
  let session = getSession();
  while (!session && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, SESSION_REGISTER_POLL_MS));
    session = getSession();
  }
  return session;
}

function makePermissionHandler(
  getSession: () => AgentSession | undefined,
  fallback?: { allowAllPermissions?: boolean },
) {
  return async (request: PermissionRequest): Promise<PermissionRequestResult> => {
    // A resumed session can re-emit prompts that were pending while nobody was
    // attached, and those can land before the session object is registered.
    // Wait briefly rather than blanket-approving work the user never saw.
    const session = (await waitForSession(getSession)) ?? undefined;
    if (!session) {
      return fallback?.allowAllPermissions ? { kind: 'approve-once' } : { kind: 'reject' };
    }
    if (autoApprovesPermissions(session)) return { kind: 'approve-once' };

    const requestId = randomUUID();
    const { title, detail, canSession } = describePermission(request);
    return new Promise<PermissionRequestResult>((resolve) => {
      const message: Extract<AgentServerMessage, { type: 'permission_request' }> = {
        type: 'permission_request',
        requestId,
        title,
        detail,
        canSession,
      };
      session.pendingPermissions.set(requestId, { resolve, message });
      emit(session, message);
    });
  };
}

/**
 * Handles the agent's request to exit plan mode. Surfaces the plan + available
 * actions to the client and waits for the user's choice (mirrors the CLI's
 * exit-plan prompt).
 */
function makeExitPlanHandler(getSession: () => AgentSession | undefined) {
  return async (request: ExitPlanModeRequest): Promise<ExitPlanModeResult> => {
    const session = getSession();
    if (!session) return { approved: false };

    if (session.kind === 'agent' && session.projectId && session.worktreeId) {
      const projectId = session.projectId;
      const worktreeId = session.worktreeId;
      const planContent = request.planContent ?? request.summary;

      // Work the Project Lead delegated is reviewed by the lead itself: the
      // worker blocks here until the lead approves or asks for changes.
      const { getDelegationForWorktree } = await import('./delegation-store');
      if (getDelegationForWorktree(worktreeId)) {
        const { requestLeadPlanReview } = await import('./delegation-runtime');
        const decision = await requestLeadPlanReview({
          userId: session.userId,
          projectId,
          worktreeId,
          summary: request.summary,
          planContent,
        });
        if (decision) {
          emit(session, {
            type: 'event',
            event: {
              kind: 'notice',
              id: randomUUID(),
              ts: Date.now(),
              message: decision.approved
                ? `Project Lead approved the plan: ${decision.note}`
                : `Project Lead requested changes: ${decision.note}`,
            },
          });
          return decision.approved
            ? { approved: true, selectedAction: request.recommendedAction }
            : { approved: false };
        }
        // No answer in time — fall through and ask the user directly.
        emit(session, {
          type: 'event',
          event: {
            kind: 'notice',
            id: randomUUID(),
            ts: Date.now(),
            message: 'Project Lead did not respond to the plan review; escalating to you.',
          },
        });
      }

      const { reviewPlanForWorker } = await import('./project-lead-tools');
      const scope = request.summary.toLowerCase().includes('large') ? 'large'
        : request.summary.toLowerCase().includes('medium') ? 'medium' : 'small';
      const review = reviewPlanForWorker(projectId, worktreeId, planContent, scope);
      if (review.action === 'approve' || review.action === 'approve-with-note') {
        emit(session, {
          type: 'event',
          event: {
            kind: 'notice',
            id: randomUUID(),
            ts: Date.now(),
            message: `Project Lead ${review.action}: ${review.reason}`,
          },
        });
        return { approved: true, selectedAction: request.recommendedAction };
      }
      if (review.action === 'request-changes') {
        emit(session, {
          type: 'event',
          event: {
            kind: 'notice',
            id: randomUUID(),
            ts: Date.now(),
            message: `Project Lead requested plan changes: ${review.reason}`,
          },
        });
        return { approved: false };
      }
      const requestId = randomUUID();
      return new Promise<ExitPlanModeResult>((resolve) => {
        const message: Extract<AgentServerMessage, { type: 'exit_plan_request' }> = {
          type: 'exit_plan_request',
          requestId,
          summary: request.summary,
          planContent: request.planContent,
          actions: request.actions,
          recommended: request.recommendedAction,
          reviewNote: `Project Lead escalation: ${review.reason}`,
        };
        session.pendingPlans.set(requestId, { resolve, message });
        emit(session, message);
      });
    }

    const requestId = randomUUID();
    return new Promise<ExitPlanModeResult>((resolve) => {
      const message: Extract<AgentServerMessage, { type: 'exit_plan_request' }> = {
        type: 'exit_plan_request',
        requestId,
        summary: request.summary,
        planContent: request.planContent,
        actions: request.actions,
        recommended: request.recommendedAction,
      };
      session.pendingPlans.set(requestId, { resolve, message });
      emit(session, message);
    });
  };
}

export function respondToPermission(
  sessionId: string,
  requestId: string,
  decision: 'approve-once' | 'approve-for-session' | 'approve-all' | 'reject',
): void {
  const session = agentSessions.get(sessionId);
  if (!session) return;
  resolvePermission(session, requestId, decision);
}

/**
 * Whether a permission request should be approved without asking the user:
 * either the session is in "allow everything" mode (any agent mode) or the
 * agent is running auto-pilot.
 */
export function autoApprovesPermissions(session: AgentSession): boolean {
  return session.allowAllPermissions || session.mode === 'autopilot';
}

/** Session-level permission resolution. Exported for unit testing. */
export function resolvePermission(
  session: AgentSession,
  requestId: string,
  decision: 'approve-once' | 'approve-for-session' | 'approve-all' | 'reject',
): void {
  const pending = session.pendingPermissions.get(requestId);
  if (!pending) return;
  session.pendingPermissions.delete(requestId);

  if (decision === 'approve-all') {
    // Approve this request, then stop prompting for the rest of the session
    // (which also drains anything else already queued).
    pending.resolve({ kind: 'approve-once' });
    emit(session, { type: 'permission_resolved', requestId });
    applyAllowAll(session, true);
    return;
  }

  const result: PermissionRequestResult =
    decision === 'reject' ? { kind: 'reject' } : { kind: decision };
  pending.resolve(result);
  emit(session, { type: 'permission_resolved', requestId });
}

/** Whether the session auto-approves every permission request. */
export function isAllowAllPermissions(sessionId: string): boolean {
  return agentSessions.get(sessionId)?.allowAllPermissions ?? false;
}

/**
 * Toggle "allow everything" for a session. Enabling it also auto-approves any
 * prompts that are already waiting so the run isn't left blocked.
 */
export function setAllowAllPermissions(sessionId: string, enabled: boolean): void {
  const session = agentSessions.get(sessionId);
  if (!session) return;
  applyAllowAll(session, enabled);
}

/** Session-level "allow everything" toggle. Exported for unit testing. */
export function applyAllowAll(session: AgentSession, enabled: boolean): void {
  session.allowAllPermissions = enabled;
  if (enabled) {
    for (const [id, waiting] of [...session.pendingPermissions]) {
      session.pendingPermissions.delete(id);
      waiting.resolve({ kind: 'approve-once' });
      emit(session, { type: 'permission_resolved', requestId: id });
    }
  }
  emit(session, { type: 'allow_all', enabled });
  persistAgentState(session);
}

/** Maps an exit-plan action to the mode the session should continue in. */
function modeForExitAction(action: string): AgentMode | null {
  if (action === 'interactive' || action === 'exit_only') return 'interactive';
  if (action === 'autopilot' || action === 'autopilot_fleet') return 'autopilot';
  return null;
}

export function respondToExitPlan(sessionId: string, requestId: string, action: string): void {
  const session = agentSessions.get(sessionId);
  if (!session) return;
  const pending = session.pendingPlans.get(requestId);
  if (!pending) return;
  session.pendingPlans.delete(requestId);

  // 'reject'/'keep' means the user wants to stay in plan mode.
  const approved = action !== 'reject' && action !== 'keep';
  pending.resolve(approved ? { approved: true, selectedAction: action } : { approved: false });
  emit(session, { type: 'exit_plan_resolved', requestId });

  if (approved) {
    const nextMode = modeForExitAction(action);
    if (nextMode) setMode(session, nextMode);
  }
}

function setMode(session: AgentSession, mode: AgentMode): void {
  if (session.mode === mode) return;
  session.mode = mode;
  emit(session, { type: 'mode', mode });
  persistAgentState(session);
  // Entering autopilot clears any outstanding permission prompts.
  if (mode === 'autopilot') {
    for (const [requestId, pending] of session.pendingPermissions) {
      session.pendingPermissions.delete(requestId);
      pending.resolve({ kind: 'approve-once' });
      emit(session, { type: 'permission_resolved', requestId });
    }
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function scheduleSave(session: AgentSession): void {
  if (session.saveTimer) return;
  session.saveTimer = setTimeout(() => {
    session.saveTimer = null;
    persistTranscript(session);
  }, SAVE_DEBOUNCE_MS);
}

function persistTranscript(session: AgentSession, ended = false): void {
  try {
    const json = JSON.stringify(session.transcript);
    if (ended) {
      getDb()
        .prepare("UPDATE cli_sessions SET output_log = ?, ended_at = datetime('now') WHERE id = ?")
        .run(json, session.sessionId);
    } else {
      getDb().prepare('UPDATE cli_sessions SET output_log = ? WHERE id = ?').run(json, session.sessionId);
    }
  } catch (err) {
    console.error(`[agent-bridge] Failed to persist transcript for ${session.sessionId}:`, err);
  }
}

/**
 * State a resumed session needs but the SDK does not carry for us. Persisted on
 * every change so a session picked back up after a server restart keeps its
 * model, mode, workspace and auto-approval setting.
 */
export interface PersistedAgentState {
  model?: string;
  mode?: AgentMode;
  projectId?: string | null;
  worktreeId?: string | null;
  allowAllPermissions?: boolean;
  cwd?: string;
}

function createPendingAgentSession(
  userId: string,
  projectId: string | null,
  worktreeId: string | null,
  kind: AgentSessionKind,
  cwd: string,
  model: string,
  mode: AgentMode,
  allowAllPermissions: boolean,
): AgentSession {
  return {
    // Replaced with the runtime session id as soon as create/resume resolves.
    sessionId: `pending:${randomUUID()}`,
    userId,
    projectId,
    worktreeId,
    kind,
    cwd,
    model,
    mode,
    status: 'idle',
    alive: true,
    transcript: [],
    subscribers: new Set(),
    pendingPermissions: new Map(),
    pendingPlans: new Map(),
    sdk: undefined as unknown as CopilotSession,
    unsubscribe: () => {},
    saveTimer: null,
    toolReconcileTimer: null,
    toolReconcileInFlight: false,
    busyWatchdogTimer: null,
    busyWatchdogInFlight: false,
    assistantByMessageId: new Map(),
    assistantStartTs: new Map(),
    turnStartTs: null,
    toolByCallId: new Map(),
    share: { mode: 'off', steerable: false },
    usage: emptyAgentUsage(),
    allowAllPermissions,
    queuedPrompts: [],
  };
}

export function persistAgentState(session: AgentSession): void {
  const state: PersistedAgentState = {
    model: session.model,
    mode: session.mode,
    projectId: session.projectId,
    worktreeId: session.worktreeId,
    allowAllPermissions: session.allowAllPermissions,
    cwd: session.cwd,
  };
  try {
    getDb()
      .prepare('UPDATE cli_sessions SET agent_state = ? WHERE id = ?')
      .run(JSON.stringify(state), session.sessionId);
  } catch (err) {
    console.error(`[agent-bridge] Failed to persist agent state for ${session.sessionId}:`, err);
  }
}

export function loadAgentState(sessionId: string): PersistedAgentState {
  try {
    const row = getDb().prepare('SELECT agent_state FROM cli_sessions WHERE id = ?').get(sessionId) as
      | { agent_state?: string }
      | undefined;
    if (!row?.agent_state) return {};
    const parsed = JSON.parse(row.agent_state) as PersistedAgentState;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/**
 * Work out whether a resumed session is mid-turn. The SDK event log is ordered,
 * so the last turn-boundary event wins: anything that starts work implies busy,
 * anything that ends a turn implies idle. An empty/unavailable log is treated as
 * idle, matching the previous behaviour.
 *
 * Note this reads the *persisted* log from `getEvents()`, which is not the same
 * as the live event stream: it ends at `assistant.turn_end` and never contains
 * the `session.idle` / `assistant.idle` markers that the stream emits. Treating
 * only the streamed markers as terminal would report every completed session as
 * busy forever.
 */
/** Event types that mean "no work in flight". */
const TURN_END_EVENTS = new Set([
  'session.idle',
  'assistant.idle',
  'assistant.turn_end',
  'session.error',
  'session.abort',
  'abort',
  // Emitted by the runtime when it tears a session down (for example after its
  // owning client disconnects). Not in the SDK's typed union, hence the strings.
  'session.shutdown',
]);

/** Event types that mean "work has started". */
const TURN_START_EVENTS = new Set([
  'user.message',
  'assistant.turn_start',
  'assistant.message_start',
  'tool.execution_start',
]);

const AGENT_RENDERING_INSTRUCTIONS = `
Format responses for the web Agent tab using Markdown. Use headings, lists, tables, and task lists when they improve clarity.
Put source code, commands, logs, stack traces, JSON, YAML, XML, and diffs in fenced code blocks with an accurate language tag.
Use fenced mermaid blocks for flowcharts, sequence diagrams, state machines, ER diagrams, and other visual explanations.
Use LaTeX delimiters ($...$ or $$...$$) for mathematical notation.
Use Markdown links for URLs and GitHub issues, pull requests, and commits. Do not emit raw HTML.
Keep code blocks and tool output focused; avoid excessively large unstructured dumps.
`;

const WORKTREE_DIGEST_INSTRUCTIONS = `
When working in a worktree, keep the portfolio dashboard current by calling update_digest
at meaningful milestones and before becoming idle. Use concise, factual summaries; include
the files you changed or intend to change in touched_files, and report blocked status rather
than guessing when you need input.
`;

const CHIEF_OF_STAFF_INSTRUCTIONS = `
You are the user's Chief of Staff. Work only from compact project and worktree status
rollups exposed by your tools. Do not request or reconstruct raw project transcripts.
Prioritize portfolio sequencing, surface blockers, and hand technical questions to a
Project Lead through a decision thread. Project Leads send you briefings (via
list_project_briefings) after significant conversations or decisions; check these to stay
aware of what is happening in each project without reading its full chat history.
`;

const PROJECT_LEAD_BASE_INSTRUCTIONS = `
You are the Project Lead for this project. Review project status, coordinate worktrees, and
ask for clarification before delegating ambiguous work. At the start of a conversation, call
get_project_memory to load (and, if needed, bootstrap) your persistent understanding of this
project's README, recent history, worktrees, and open decisions.

Delegation is asynchronous. Use delegate_to_worker to start a background worker on a task:
it creates or reuses a worktree, opens its own Copilot session, and hands over the work. The
worker plans first and comes back to you through decide_worker_plan before it changes any
files, and it can reach you with ask_project_lead when it hits a blocker — answer with
nudge_worker. Once you have delegated, say what you delegated and end your turn. Never idle,
poll, sleep, or re-read digests in a loop waiting for a worker to finish — that blocks the
conversation and the user cannot ask you about anything else while your turn is open. Check
progress with list_delegations/get_digest only when the user asks or at the start of a later
turn, and report what changed then.

After reaching a decision or
completing a significant review, call brief_chief_of_staff with a headline-style summary of
one or two sentences (280 characters or less) so the Chief of Staff stays aware of this
project's conversation without reading the full transcript. Briefings are a digest, not a
recap: state what was decided and what it unblocks, and leave the detail in the transcript.
`;

export function deriveStatusFromEvents(events: SessionEvent[] | undefined): AgentStatus {
  if (!Array.isArray(events)) return 'idle';
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const type = events[i]?.type as string | undefined;
    if (!type) continue;
    if (TURN_END_EVENTS.has(type)) return 'idle';
    if (TURN_START_EVENTS.has(type)) return 'busy';
  }
  return 'idle';
}

/**
 * The tool set a session is entitled to for its kind/scope. Shared by
 * `createAgentSession` and `resumeAgentSession` so a session resumed after a
 * server restart gets back the same tools it was created with — the SDK
 * negotiates tool availability per-connection, so omitting this on resume
 * silently strips a session's tools, which is why unresumed sessions can look
 * "dead" (any turn that needs a tool call stalls or errors).
 */
export function buildToolsForKind(
  kind: AgentSessionKind,
  projectId: string | null,
  worktreeId: string | null,
  userId?: string,
): Tool<any>[] | undefined {
  if (kind === 'chief_of_staff') return createChiefOfStaffTools();
  if (kind === 'project_lead') return projectId ? createProjectLeadTools(projectId, userId) : undefined;
  if (worktreeId) return [...createWorktreeAgentTools(worktreeId, projectId, userId), ...createMergeTools(worktreeId)];
  return undefined;
}

export async function createAgentSession(
  userId: string,
  projectId: string | null,
  worktreeId: string | null,
  model = DEFAULT_MODEL,
  kind: AgentSessionKind = 'agent',
  mode: AgentMode = DEFAULT_MODE,
): Promise<AgentSession> {
  const client = await getClient();
  const cwd = resolveCwd(projectId, worktreeId);

  // Created up front so permission/plan callbacks fired during
  // `createSession` can queue prompts instead of timing out and rejecting.
  const session = createPendingAgentSession(
    userId,
    projectId ?? null,
    worktreeId ?? null,
    kind,
    cwd,
    model,
    mode,
    false,
  );
  let sessionRef: AgentSession | undefined = session;

  // Project Leads bootstrap (or reuse) a persistent project-memory summary so a fresh
  // conversation is immediately grounded in the project's README, history, and open work.
  let projectMemorySummary = '';
  if (kind === 'project_lead' && projectId) {
    try {
      const memory = getOrBootstrapProjectMemory(projectId);
      projectMemorySummary = `\n\n## Project memory (bootstrapped)\n${memory.summary}`;
    } catch (err) {
      console.warn(`[agent-bridge] Failed to bootstrap project memory for ${projectId}:`, err);
    }
  }

  const sdk = await client.createSession({
    model,
    streaming: true,
    workingDirectory: cwd,
    systemMessage: {
      mode: 'append',
      content: `${AGENT_RENDERING_INSTRUCTIONS}${worktreeId ? WORKTREE_DIGEST_INSTRUCTIONS : ''}${kind === 'project_lead' ? `\n${PROJECT_LEAD_BASE_INSTRUCTIONS}${projectMemorySummary}` : ''}${kind === 'chief_of_staff' ? CHIEF_OF_STAFF_INSTRUCTIONS : ''}`,
    },
    tools: buildToolsForKind(kind, projectId, worktreeId, userId),
    onPermissionRequest: makePermissionHandler(() => sessionRef),
    onExitPlanModeRequest: makeExitPlanHandler(() => sessionRef),
  });

  session.sessionId = sdk.sessionId;
  session.sdk = sdk;

  session.unsubscribe = sdk.on((event) => handleSdkEvent(session, event));
  agentSessions.set(session.sessionId, session);

  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO users (id, github_id, role) VALUES (?, ?, ?)').run(userId, userId, 'user');
  db.prepare(
    'INSERT INTO cli_sessions (id, user_id, project_id, worktree_id, copilot_session_id, kind) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(session.sessionId, userId, projectId ?? null, worktreeId ?? null, session.sessionId, kind);
  persistAgentState(session);

  console.log(`[agent-bridge] Created agent session ${session.sessionId}, cwd=${cwd}, model=${model}`);
  return session;
}

export async function sendAgentMessage(sessionId: string, prompt: string): Promise<void> {
  const session = agentSessions.get(sessionId);
  if (!session || !session.alive) return;
  await sendToSession(session, prompt);
}

/**
 * Deliver a prompt to a live session, queueing it when a turn is already in
 * flight. Exported for tests; callers should prefer `sendAgentMessage`.
 */
export async function sendToSession(session: AgentSession, prompt: string): Promise<void> {
  if (!session.alive) return;
  // The SDK runs one turn at a time. Rather than dropping input typed during a
  // long turn (a Project Lead waiting on a worker can stay busy for minutes),
  // hold it and replay it when the session next goes idle.
  if (session.status === 'busy') {
    (session.queuedPrompts ??= []).push(prompt);
    emitQueued(session);
    return;
  }
  // The turn clock starts when the user hands us the prompt, before the SDK
  // round trip, so queueing and connection time are included in the total.
  session.turnStartTs = Date.now();
  setStatus(session, 'busy');
  try {
    await session.sdk.send({ prompt, agentMode: session.mode });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    upsertEvent(session, { kind: 'error', id: `error:${randomUUID()}`, ts: Date.now(), message });
    setStatus(session, 'idle');
  }
}

export async function cancelAgent(sessionId: string): Promise<void> {
  const session = agentSessions.get(sessionId);
  if (!session || !session.alive) return;

  // Stopping the turn also abandons anything queued behind it; otherwise the
  // queue would immediately start a new turn the user just asked to stop.
  if (session.queuedPrompts?.length) {
    session.queuedPrompts.length = 0;
    emitQueued(session);
  }

  for (const [requestId, pending] of session.pendingPermissions) {
    session.pendingPermissions.delete(requestId);
    pending.resolve({ kind: 'reject' });
    emit(session, { type: 'permission_resolved', requestId });
  }
  for (const [requestId, pending] of session.pendingPlans) {
    session.pendingPlans.delete(requestId);
    pending.resolve({ approved: false });
    emit(session, { type: 'exit_plan_resolved', requestId });
  }
  for (const event of session.transcript) {
    if (event.kind === 'tool' && event.status === 'running') {
      upsertEvent(session, {
        ...event,
        status: 'error',
        output: event.output ? `${event.output}\nCancelled by user.` : 'Cancelled by user.',
      });
    }
  }
  setStatus(session, 'idle');

  try {
    await session.sdk.abort();
  } catch (err) {
    console.error(`[agent-bridge] abort failed for ${sessionId}:`, err);
  }
}

export async function setAgentModel(sessionId: string, model: string): Promise<void> {
  const session = agentSessions.get(sessionId);
  if (!session || !session.alive) return;
  try {
    await session.sdk.setModel(model);
    session.model = model;
    emit(session, { type: 'model', model });
    persistAgentState(session);
  } catch (err) {
    console.error(`[agent-bridge] setModel failed for ${sessionId}:`, err);
  }
}

export function setAgentMode(sessionId: string, mode: AgentMode): void {
  const session = agentSessions.get(sessionId);
  if (!session) return;
  setMode(session, mode);
}

// ---------------------------------------------------------------------------
// Slash commands (dynamic, plugin-aware)
//
// The SDK exposes the *actual* slash-command catalog for a session via
// `rpc.commands.list` (runtime built-ins + enabled skills + client commands),
// and executes them via `rpc.commands.invoke`. Because the catalog is resolved
// from the live session it automatically reflects whatever plugins / skills the
// user currently has installed — no hard-coded list required.
// ---------------------------------------------------------------------------

interface SdkSlashCommand {
  name: string;
  aliases?: string[];
  description: string;
  kind: 'builtin' | 'skill' | 'client';
  input?: {
    hint?: string;
    required?: boolean;
    choices?: { name: string; description: string }[];
  };
  allowDuringAgentExecution?: boolean;
}

function mapSdkCommand(c: SdkSlashCommand): AgentSlashCommand {
  return {
    name: c.name,
    aliases: c.aliases,
    description: c.description,
    kind: c.kind,
    argHint: c.input?.hint,
    argChoices: c.input?.choices,
    argRequired: c.input?.required,
    allowDuringExecution: c.allowDuringAgentExecution,
  };
}

/** Discover the live slash-command catalog for a session. */
export async function listAgentCommands(sessionId: string): Promise<AgentSlashCommand[]> {
  const session = agentSessions.get(sessionId);
  if (!session || !session.alive) return [];
  try {
    const rpc = (session.sdk as unknown as { rpc: { commands?: { list?: (p: unknown) => Promise<{ commands: SdkSlashCommand[] }> } } }).rpc;
    if (!rpc?.commands?.list) return [];
    const result = await rpc.commands.list({
      includeBuiltins: true,
      includeSkills: true,
      includeClientCommands: true,
    });
    return (result.commands ?? []).map(mapSdkCommand);
  } catch (err) {
    console.error(`[agent-bridge] listAgentCommands failed for ${sessionId}:`, err);
    return [];
  }
}

/** Broadcast the current command catalog to subscribers. */
export async function broadcastAgentCommands(sessionId: string): Promise<void> {
  const session = agentSessions.get(sessionId);
  if (!session) return;
  const commands = await listAgentCommands(sessionId);
  emit(session, { type: 'commands', commands });
}

type SdkInvokeResult =
  | { kind: 'text'; text: string; markdown?: boolean }
  | { kind: 'agent-prompt'; prompt: string; displayPrompt?: string; mode?: AgentMode; runtimeSettingsChanged?: boolean }
  | { kind: 'completed'; message?: string; runtimeSettingsChanged?: boolean }
  | {
      kind: 'select-subcommand';
      command: string;
      title: string;
      options: { name: string; description: string; group?: string }[];
    };

/**
 * Invoke a slash command by name. Handles every result shape the SDK can
 * return; anything that can't be rendered in the web console degrades to a
 * transcript notice rather than throwing.
 */
export async function runAgentCommand(sessionId: string, name: string, input?: string): Promise<void> {
  const session = agentSessions.get(sessionId);
  if (!session || !session.alive) return;

  const notice = (message: string) =>
    upsertEvent(session, { kind: 'notice', id: `notice:${randomUUID()}`, ts: Date.now(), message });

  const rpc = (session.sdk as unknown as {
    rpc: { commands?: { invoke?: (p: { name: string; input?: string }) => Promise<SdkInvokeResult> } };
  }).rpc;
  if (!rpc?.commands?.invoke) {
    notice(`/${name} is not available in this session.`);
    return;
  }

  let result: SdkInvokeResult;
  try {
    result = await rpc.commands.invoke({ name, input: input && input.length ? input : undefined });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    notice(`/${name} isn't supported in the web console: ${message}`);
    return;
  }

  switch (result.kind) {
    case 'text':
      if (result.text) notice(result.text);
      break;
    case 'completed':
      if (result.message) notice(result.message);
      if (result.runtimeSettingsChanged) await broadcastAgentCommands(sessionId);
      break;
    case 'select-subcommand':
      emit(session, {
        type: 'command_subcommands',
        command: result.command,
        title: result.title,
        options: result.options ?? [],
      });
      break;
    case 'agent-prompt': {
      if (result.mode) setMode(session, result.mode);
      setStatus(session, 'busy');
      try {
        await session.sdk.send({ prompt: result.prompt, agentMode: result.mode ?? session.mode });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        upsertEvent(session, { kind: 'error', id: `error:${randomUUID()}`, ts: Date.now(), message });
        setStatus(session, 'idle');
      }
      if (result.runtimeSettingsChanged) await broadcastAgentCommands(sessionId);
      break;
    }
    default:
      notice(`/${name} returned an unsupported result.`);
  }
}

// ---------------------------------------------------------------------------
// Session switcher (/resume) + working-tree diff (/diff)
// ---------------------------------------------------------------------------

/** List resumable sessions in the same working directory as `sessionId`. */
export async function listAgentSessionSummaries(sessionId: string): Promise<AgentSessionSummary[]> {
  const session = agentSessions.get(sessionId);
  if (!session) return [];
  try {
    const client = await getClient();
    const metas = await listSessionMetasForCwd(client, session.cwd);
    return metas
      .map((m) => ({
        id: m.sessionId,
        summary: m.summary ?? null,
        startTime: (m.startTime instanceof Date ? m.startTime : new Date(m.startTime)).toISOString(),
        modifiedTime: (m.modifiedTime instanceof Date ? m.modifiedTime : new Date(m.modifiedTime)).toISOString(),
        isRemote: Boolean(m.isRemote),
        current: m.sessionId === sessionId,
      }))
      .sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime));
  } catch (err) {
    console.error(`[agent-bridge] listAgentSessionSummaries failed for ${sessionId}:`, err);
    return [];
  }
}

/**
 * Resume the most relevant agent session for a workspace.
 * Prefers remote/shared sessions when available, then falls back to the newest
 * session in the same working directory.
 */
export async function resumeBestAgentSessionForWorkspace(
  userId: string,
  projectId: string | null,
  worktreeId: string | null,
): Promise<AgentSession | undefined> {
  const cwd = resolveCwd(projectId, worktreeId);
  try {
    const client = await getClient();
    const metas = await listSessionMetasForCwd(client, cwd);
    const ordered = [...metas].sort((a, b) => {
      const aRemote = Boolean(a.isRemote);
      const bRemote = Boolean(b.isRemote);
      if (aRemote !== bRemote) return aRemote ? -1 : 1;
      const aModified = new Date(a.modifiedTime instanceof Date ? a.modifiedTime : new Date(a.modifiedTime)).getTime();
      const bModified = new Date(b.modifiedTime instanceof Date ? b.modifiedTime : new Date(b.modifiedTime)).getTime();
      return bModified - aModified;
    });

    for (const meta of ordered) {
      if (!meta.sessionId) continue;
      const session = await resumeAgentSession(userId, meta.sessionId);
      if (!session) continue;
      session.projectId = projectId ?? null;
      session.worktreeId = worktreeId ?? null;
      session.cwd = cwd;
      return session;
    }
  } catch (err) {
    console.error(`[agent-bridge] resumeBestAgentSessionForWorkspace failed for cwd=${cwd}:`, err);
  }
  return undefined;
}
export async function resumeAgentSession(userId: string, sessionId: string): Promise<AgentSession | undefined> {
  const existing = agentSessions.get(sessionId);
  if (existing && existing.alive) return existing;

  // Coalesce concurrent resumes of the same id onto one promise so overlapping
  // connects can never build competing session objects (see `resumeInFlight`).
  const pending = resumeInFlight.get(sessionId);
  if (pending) return pending;

  const run = resumeAgentSessionUncached(userId, sessionId).finally(() => {
    resumeInFlight.delete(sessionId);
  });
  resumeInFlight.set(sessionId, run);
  return run;
}

/**
 * True when the runtime reports a session id it does not know about, as
 * opposed to a transient transport failure. Only these are safe to tombstone.
 */
function isSessionGoneError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return /session not found/i.test(message);
}

/**
 * True when the runtime refuses a resume because another connection still owns
 * this session's external tools. The conversation is fine; the registration is
 * stale, and restarting the runtime clears it.
 */
function isToolClashError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return /tool name clash/i.test(message);
}

async function resumeAgentSessionUncached(
  userId: string,
  sessionId: string,
): Promise<AgentSession | undefined> {
  // A resume may have completed while we were queued behind another caller.
  const existing = agentSessions.get(sessionId);
  if (existing && existing.alive) return existing;
  // A dead-but-still-attached handle keeps this session's external tools
  // registered, which would make our own resume fail with a tool name clash.
  if (existing) {
    agentSessions.delete(sessionId);
    try {
      await existing.sdk?.disconnect?.();
    } catch {
      /* already gone */
    }
  }

  const client = await getClient();

  // Load persisted state first: a resumed session may re-emit permission
  // prompts immediately, and the handler needs to know whether this session
  // had "allow all" enabled before it was detached.
  const persisted = loadAgentState(sessionId);
  // The runtime negotiates tool availability per-connection: resuming without
  // re-declaring the tools a session was created with leaves it with none,
  // so any turn that needs to call a tool silently stalls or errors — this is
  // the "dead after a server restart" symptom. Recover the original kind from
  // `cli_sessions` (not persisted in `PersistedAgentState`) so we can rebuild
  // the same tool set `createAgentSession` registered.
  const kindRow = getDb().prepare('SELECT kind FROM cli_sessions WHERE id = ?').get(sessionId) as
    | { kind?: AgentSessionKind }
    | undefined;
  const kind: AgentSessionKind = kindRow?.kind ?? 'agent';
  const projectId = persisted.projectId ?? null;
  const worktreeId = persisted.worktreeId ?? null;

  const session = createPendingAgentSession(
    userId,
    projectId,
    worktreeId,
    kind,
    persisted.cwd ?? process.cwd(),
    persisted.model ?? DEFAULT_MODEL,
    persisted.mode ?? DEFAULT_MODE,
    persisted.allowAllPermissions ?? false,
  );
  // Keep the requested id while resume is in flight so diagnostics stay clear.
  session.sessionId = sessionId;
  let sessionRef: AgentSession | undefined = session;

  const tools = buildToolsForKind(kind, projectId, worktreeId, userId);

  let sdk;
  try {
    sdk = await client.resumeSession(sessionId, {
      streaming: true,
      continuePendingWork: true,
      tools,
      onPermissionRequest: makePermissionHandler(() => sessionRef, {
        allowAllPermissions: persisted.allowAllPermissions,
      }),
      onExitPlanModeRequest: makeExitPlanHandler(() => sessionRef),
    });
  } catch (err) {
    console.error(`[agent-bridge] resumeSession failed for ${sessionId}:`, err);
    if (isToolClashError(err)) {
      // The conversation is intact but a leaked connection still owns its
      // tools. Creating a fresh session here would silently hide the user's
      // history, so report it instead — `POST /api/agent/reconnect` restarts
      // the runtime and clears the stale registration.
      console.error(
        `[agent-bridge] session ${sessionId} is held by a stale runtime connection. ` +
          'Call POST /api/agent/reconnect to release it.',
      );
      return undefined;
    }
    // A session the runtime has never heard of can never come back: the
    // runtime was restarted or the session was pruned. Tombstone the row so
    // we stop retrying it on every lead/CoS open. Transient faults (runtime
    // down, socket errors) are left alone so they retry once it recovers.
    //
    // Only ever retire *empty* rows. A restarted runtime can report a real
    // session as missing before it has re-indexed its on-disk state, and
    // tombstoning a transcript we still have would hide the user's
    // conversation permanently.
    if (isSessionGoneError(err)) {
      try {
        getDb()
          .prepare(`
            UPDATE cli_sessions
            SET ended_at = datetime('now')
            WHERE id = ?
              AND ended_at IS NULL
              AND (output_log IS NULL OR length(output_log) <= 2)
          `)
          .run(sessionId);
      } catch {
        /* best effort — a failed tombstone only costs a future retry */
      }
    }
    return undefined;
  }
  session.sessionId = sdk.sessionId;
  session.cwd = sdk.workspacePath ?? session.cwd;
  session.sdk = sdk;

  // Stored transcript, used as a fallback when the runtime cannot replay.
  let transcript: AgentTranscriptEvent[] = [];
  const row = getDb().prepare('SELECT output_log FROM cli_sessions WHERE id = ?').get(sessionId) as
    | { output_log?: string }
    | undefined;
  if (row?.output_log) {
    try {
      const parsed = JSON.parse(row.output_log);
      if (Array.isArray(parsed)) transcript = parsed as AgentTranscriptEvent[];
    } catch {
      /* ignore corrupt logs */
    }
  }
  session.transcript = transcript;

  // The runtime's own event log is the source of truth: while we were detached
  // it kept recording (finishing a turn, or shutting the session down), so our
  // stored transcript is at best stale. Rebuild from the log whenever we can
  // get it, and fall back to the stored copy only if the runtime cannot tell us
  // (e.g. a session that never completed a turn and so was never written to the
  // SDK's session store).
  let replayed: SessionEvent[] | undefined;
  try {
    replayed = await (sdk as unknown as { getEvents?: () => Promise<SessionEvent[]> }).getEvents?.();
  } catch (err) {
    console.error(`[agent-bridge] getEvents replay failed for ${sessionId}:`, err);
  }

  if (Array.isArray(replayed) && replayed.length > 0) {
    session.transcript = [];
    session.assistantByMessageId.clear();
    session.assistantStartTs.clear();
    session.turnStartTs = null;
    session.toolByCallId.clear();
    // Rebuilt from the log below. Token counts cannot be recovered (the SDK
    // marks `assistant.usage` ephemeral) but the durable usage checkpoints do
    // restore the session-wide cost.
    session.usage = emptyAgentUsage();
    for (const event of replayed) handleSdkEvent(session, event);
  }
  setStatus(session, deriveStatusFromEvents(replayed));

  session.unsubscribe = sdk.on((event) => handleSdkEvent(session, event));
  agentSessions.set(session.sessionId, session);
  ensureToolReconciliation(session);

  // Ensure a DB row exists (older/remote sessions may not have one locally).
  getDb()
    .prepare('INSERT OR IGNORE INTO cli_sessions (id, user_id, copilot_session_id, kind) VALUES (?, ?, ?, ?)')
    .run(session.sessionId, userId, session.sessionId, 'agent');

  console.log(`[agent-bridge] Resumed agent session ${session.sessionId}`);
  return session;
}

/** Compute the working-tree diff (staged + unstaged + untracked) for a session. */
export async function getAgentDiff(sessionId: string): Promise<{ content: string; truncated: boolean }> {
  const session = agentSessions.get(sessionId);
  if (!session) return { content: '', truncated: false };
  const cwd = session.cwd;
  const parts: string[] = [];
  try {
    const status = await execFileAsync('git', ['-C', cwd, 'status', '--short', '--branch'], {
      maxBuffer: MAX_DIFF_CHARS,
    });
    if (status.stdout.trim()) parts.push(status.stdout.trimEnd());
  } catch {
    return { content: 'Not a git repository (or git is unavailable).', truncated: false };
  }
  try {
    const diff = await execFileAsync('git', ['-C', cwd, 'diff', 'HEAD'], { maxBuffer: MAX_DIFF_CHARS });
    if (diff.stdout.trim()) parts.push(diff.stdout.trimEnd());
  } catch {
    // `git diff HEAD` fails on a repo with no commits — fall back to plain diff.
    try {
      const diff = await execFileAsync('git', ['-C', cwd, 'diff'], { maxBuffer: MAX_DIFF_CHARS });
      if (diff.stdout.trim()) parts.push(diff.stdout.trimEnd());
    } catch {
      /* ignore */
    }
  }
  let content = parts.join('\n\n');
  if (!content.trim()) content = 'No changes in the working tree.';
  const truncated = content.length > MAX_DIFF_CHARS;
  if (truncated) content = content.slice(0, MAX_DIFF_CHARS) + '\n… (truncated)';
  return { content, truncated };
}

// ---------------------------------------------------------------------------
// GitHub session sharing (remote-control)
//
// Mirrors the CLI's `/share` and `/remote` behaviour. The SDK exposes a
// session-level `rpc.remote` namespace: `enable({ mode })` publishes the
// session to GitHub (returning the frontend URL) and `disable()` unshares it.
// The runtime also emits `session.remote_steerable_changed` when steering is
// toggled, which we track in `session.share` and push to subscribers.
// ---------------------------------------------------------------------------

interface SdkRemoteRpc {
  enable?: (params: { mode?: AgentShareMode }) => Promise<{ url?: string; remoteSteerable: boolean }>;
  disable?: () => Promise<void>;
}

function getRemoteRpc(session: AgentSession): SdkRemoteRpc | undefined {
  return (session.sdk as unknown as { rpc?: { remote?: SdkRemoteRpc } }).rpc?.remote;
}

/** Current GitHub share status for a session. */
export function getAgentShareStatus(sessionId: string): AgentShareStatus {
  const session = agentSessions.get(sessionId);
  return session ? { ...session.share } : { mode: 'off', steerable: false };
}

/** Broadcast the current share status to subscribers. */
export function broadcastAgentShareStatus(sessionId: string): void {
  const session = agentSessions.get(sessionId);
  if (session) emit(session, { type: 'share_status', status: { ...session.share } });
}

/** Accumulated token/billing usage for a session. */
export function getAgentUsage(sessionId: string): AgentUsage {
  const session = agentSessions.get(sessionId);
  return session ? { ...session.usage } : emptyAgentUsage();
}

/**
 * Share (or unshare) a session with GitHub.
 * - `export` → publish events read-only (appears in the GitHub agents tab).
 * - `on`     → publish *and* allow GitHub to steer the session.
 * - `off`    → stop sharing.
 * Returns the resulting status; on failure the status carries an `error`.
 */
export async function shareAgentSession(sessionId: string, mode: AgentShareMode): Promise<AgentShareStatus> {
  const session = agentSessions.get(sessionId);
  if (!session || !session.alive) return { mode: 'off', steerable: false };

  const remote = getRemoteRpc(session);
  if (!remote?.enable || !remote?.disable) {
    session.share = { mode: 'off', steerable: false, error: 'Session sharing is not available in this session.' };
    broadcastAgentShareStatus(sessionId);
    return { ...session.share };
  }

  try {
    if (mode === 'off') {
      await remote.disable();
      session.share = { mode: 'off', steerable: false };
    } else {
      const result = await remote.enable({ mode });
      session.share = {
        mode,
        url: result.url ?? session.share.url,
        steerable: mode === 'on' ? true : Boolean(result.remoteSteerable),
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    session.share = { ...session.share, error: message };
    upsertEvent(session, {
      kind: 'error',
      id: `error:${randomUUID()}`,
      ts: Date.now(),
      message: `Failed to ${mode === 'off' ? 'unshare' : 'share'} session: ${message}`,
    });
  }

  broadcastAgentShareStatus(sessionId);
  return { ...session.share };
}

export function subscribe(sessionId: string, subscriber: AgentSubscriber): () => void {
  const session = agentSessions.get(sessionId);
  if (!session) return () => {};
  session.subscribers.add(subscriber);
  return () => {
    session.subscribers.delete(subscriber);
  };
}

export function getReplay(sessionId: string): AgentTranscriptEvent[] {
  return agentSessions.get(sessionId)?.transcript ?? [];
}

export async function reconcileAgentSession(sessionId: string): Promise<void> {
  const session = agentSessions.get(sessionId);
  if (session) await reconcileAgentTools(session);
}

export function getPendingAgentMessages(sessionId: string): AgentServerMessage[] {
  const session = agentSessions.get(sessionId);
  if (!session) return [];
  return pendingMessagesForSession(session);
}

export function pendingMessagesForSession(session: AgentSession): AgentServerMessage[] {
  return [
    ...[...session.pendingPermissions.values()].map((pending) => pending.message),
    ...[...session.pendingPlans.values()].map((pending) => pending.message),
  ];
}

export async function endAgentSession(sessionId: string): Promise<void> {
  const session = agentSessions.get(sessionId);
  if (!session) return;
  session.alive = false;
  if (session.saveTimer) {
    clearTimeout(session.saveTimer);
    session.saveTimer = null;
  }
  stopToolReconciliation(session);
  stopBusyWatchdog(session);
  // Fail any outstanding permission prompts so the SDK doesn't hang.
  for (const [requestId, pending] of session.pendingPermissions) {
    session.pendingPermissions.delete(requestId);
    pending.resolve({ kind: 'reject' });
  }
  // Fail any outstanding exit-plan prompts as well.
  for (const [requestId, pending] of session.pendingPlans) {
    session.pendingPlans.delete(requestId);
    pending.resolve({ approved: false });
  }
  try {
    session.unsubscribe();
  } catch {
    /* ignore */
  }
  persistTranscript(session, true);
  agentSessions.delete(sessionId);
  try {
    await session.sdk.disconnect();
  } catch (err) {
    console.error(`[agent-bridge] disconnect failed for ${sessionId}:`, err);
  }
}

/** Graceful shutdown — persist and disconnect all agent sessions. */
export async function shutdownAgentBridge(): Promise<void> {
  const ids = [...agentSessions.keys()];
  await Promise.all(ids.map((id) => endAgentSession(id)));
  if (clientPromise) {
    try {
      const client = await clientPromise;
      await client.stop();
    } catch {
      /* ignore */
    }
    clientPromise = null;
  }
}

/**
 * Release this process's hold on agent sessions without ending them.
 *
 * When the runtime lives in the daemon the sessions keep running after we go
 * away, so a UI-server restart (including `tsx --watch` reloads) must not
 * destroy them: we only flush transcripts, stop our timers and drop our
 * in-memory state. Outstanding permission prompts are deliberately left
 * unanswered — the runtime keeps them pending and `resumeAgentSession` re-emits
 * them via `continuePendingWork`.
 *
 * If we own the runtime (daemon unavailable) there is nothing to preserve, so
 * fall back to the full shutdown rather than orphaning a child process.
 */
export async function detachAgentBridge(): Promise<void> {
  if (!isRuntimeHostedByDaemon()) {
    await shutdownAgentBridge();
    return;
  }

  for (const session of agentSessions.values()) {
    if (session.saveTimer) {
      clearTimeout(session.saveTimer);
      session.saveTimer = null;
    }
    stopToolReconciliation(session);
    stopBusyWatchdog(session);
    try {
      session.unsubscribe();
    } catch {
      /* ignore */
    }
    persistTranscript(session, true);
    persistAgentState(session);
    // Release this connection's hold on the session. Unlike `client.stop()`
    // (which destroys the session) `disconnect` only frees in-memory
    // resources, and crucially it releases the session's external tool
    // registrations. Skipping it leaks them into the daemon-hosted runtime,
    // and every later resume fails with "External tool name clash ...
    // already registered by another connection" — a lead or CoS conversation
    // that can never be reopened.
    void Promise.resolve(session.sdk?.disconnect?.()).catch(() => {
      /* the connection is already gone */
    });
  }
  agentSessions.clear();

  // Note: we never call `client.stop()` here. It would send `session.destroy`
  // for every attached session, which is exactly what we are trying to avoid.
  // The socket to the daemon-hosted runtime closes when this process exits.
  clientPromise = null;
  modelsCache = null;
  modelsPromise = null;
  console.log('[agent-bridge] Detached from the daemon-hosted runtime; sessions left running.');
}
