import { randomUUID } from 'crypto';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getDb } from './db';
import { getProjectById, getWorktreeById } from './project-store';
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
} from './types';
import type {
  CopilotClient as CopilotClientType,
  CopilotSession,
  SessionEvent,
  PermissionRequest,
  PermissionRequestResult,
  ExitPlanModeRequest,
  ExitPlanModeResult,
} from '@github/copilot-sdk';

const MAX_TRANSCRIPT_EVENTS = 5_000;
const SAVE_DEBOUNCE_MS = 1_500;
const DEFAULT_MODEL = 'auto';
const DEFAULT_MODE: AgentMode = 'interactive';
const MAX_DIFF_CHARS = 200_000;

const execFileAsync = promisify(execFile);

export type AgentSubscriber = (msg: AgentServerMessage) => void;

interface PendingPermission {
  resolve: (result: PermissionRequestResult) => void;
}

interface PendingPlan {
  resolve: (result: ExitPlanModeResult) => void;
}

export interface AgentSession {
  sessionId: string;
  userId: string;
  projectId: string | null;
  worktreeId: string | null;
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
  /** Maps SDK messageId → transcript entry id for streaming assistant messages */
  assistantByMessageId: Map<string, string>;
  /** Maps SDK toolCallId → transcript entry id for tool activity */
  toolByCallId: Map<string, string>;
  /** Current GitHub session-sharing state (remote-control mode). */
  share: AgentShareStatus;
}

const agentSessions = new Map<string, AgentSession>();

// ---------------------------------------------------------------------------
// Shared Copilot SDK client (lazy singleton)
// ---------------------------------------------------------------------------

let clientPromise: Promise<CopilotClientType> | null = null;
let modelsCache: AgentModelOption[] | null = null;

async function getClient(): Promise<CopilotClientType> {
  if (!clientPromise) {
    clientPromise = (async () => {
      // Imported lazily so environments without the SDK installed can still
      // load the rest of the server (terminal modes) without crashing.
      const { CopilotClient } = await import('@github/copilot-sdk');
      const client = new CopilotClient();
      await client.start();
      return client;
    })().catch((err) => {
      // Reset so a later attempt can retry after a transient failure.
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

/** List available models for the agent-mode model picker (cached). */
export async function listAgentModels(): Promise<AgentModelOption[]> {
  if (modelsCache) return modelsCache;
  const client = await getClient();
  const models = await client.listModels();
  modelsCache = models.map((m) => ({ id: m.id, name: m.name || m.id }));
  return modelsCache;
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

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

export function getAgentSession(sessionId: string): AgentSession | undefined {
  return agentSessions.get(sessionId);
}

export function findAgentSession(
  userId: string,
  projectId: string | null,
  worktreeId: string | null,
): AgentSession | undefined {
  for (const s of agentSessions.values()) {
    if (
      s.userId === userId &&
      s.projectId === projectId &&
      (s.worktreeId ?? null) === (worktreeId ?? null) &&
      s.alive
    ) {
      return s;
    }
  }
  return undefined;
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
  emit(session, { type: 'status', status });
}

// ---------------------------------------------------------------------------
// SDK event normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a raw SDK `SessionEvent` into transcript entries + subscriber
 * broadcasts. Exported for unit testing of the event-mapping logic.
 */
export function handleSdkEvent(session: AgentSession, event: SessionEvent): void {
  switch (event.type) {
    case 'user.message': {
      const content = (event.data as { content?: string }).content ?? '';
      upsertEvent(session, { kind: 'user', id: event.id, ts: Date.now(), content });
      break;
    }
    case 'assistant.turn_start': {
      setStatus(session, 'busy');
      break;
    }
    case 'assistant.message_start': {
      const messageId = (event.data as { messageId: string }).messageId;
      const entryId = `assistant:${messageId}`;
      session.assistantByMessageId.set(messageId, entryId);
      upsertEvent(session, { kind: 'assistant', id: entryId, ts: Date.now(), content: '' });
      break;
    }
    case 'assistant.message_delta': {
      const data = event.data as { messageId: string; deltaContent: string };
      const entryId = session.assistantByMessageId.get(data.messageId) ?? `assistant:${data.messageId}`;
      if (!session.assistantByMessageId.has(data.messageId)) {
        session.assistantByMessageId.set(data.messageId, entryId);
        upsertEvent(session, { kind: 'assistant', id: entryId, ts: Date.now(), content: '' });
      }
      // Apply delta to the buffered entry so replay reflects streamed text.
      const entry = session.transcript.find((e) => e.id === entryId);
      if (entry && entry.kind === 'assistant') entry.content += data.deltaContent;
      emit(session, { type: 'assistant_delta', id: entryId, delta: data.deltaContent });
      break;
    }
    case 'assistant.message': {
      const data = event.data as { messageId?: string; content?: string };
      const messageId = data.messageId;
      const entryId = (messageId && session.assistantByMessageId.get(messageId)) || `assistant:${messageId ?? event.id}`;
      upsertEvent(session, { kind: 'assistant', id: entryId, ts: Date.now(), content: data.content ?? '' });
      break;
    }
    case 'assistant.reasoning': {
      const content = (event.data as { content?: string }).content ?? '';
      if (content) upsertEvent(session, { kind: 'reasoning', id: `reasoning:${event.id}`, ts: Date.now(), content });
      break;
    }
    case 'system.message': {
      const content = (event.data as { content?: string }).content ?? '';
      if (content) upsertEvent(session, { kind: 'system', id: `system:${event.id}`, ts: Date.now(), content });
      break;
    }
    case 'tool.execution_start': {
      const data = event.data as { toolCallId: string; toolName: string; arguments?: unknown };
      const entryId = `tool:${data.toolCallId}`;
      session.toolByCallId.set(data.toolCallId, entryId);
      upsertEvent(session, {
        kind: 'tool',
        id: entryId,
        ts: Date.now(),
        toolCallId: data.toolCallId,
        toolName: data.toolName,
        args: data.arguments,
        status: 'running',
      });
      break;
    }
    case 'tool.execution_partial_result': {
      const data = event.data as { toolCallId: string; partialOutput: string };
      const entryId = session.toolByCallId.get(data.toolCallId);
      if (entryId) {
        const entry = session.transcript.find((e) => e.id === entryId);
        if (entry && entry.kind === 'tool') entry.output = (entry.output ?? '') + data.partialOutput;
        emit(session, { type: 'tool_delta', id: entryId, delta: data.partialOutput });
      }
      break;
    }
    case 'tool.execution_complete': {
      const data = event.data as {
        toolCallId: string;
        success: boolean;
        result?: { content?: string } | string;
        error?: { message?: string };
      };
      const entryId = session.toolByCallId.get(data.toolCallId) ?? `tool:${data.toolCallId}`;
      const existing = session.transcript.find((e) => e.id === entryId);
      const prior = existing && existing.kind === 'tool' ? existing : undefined;
      const resultText =
        typeof data.result === 'string'
          ? data.result
          : (data.result?.content ?? data.error?.message ?? prior?.output);
      upsertEvent(session, {
        kind: 'tool',
        id: entryId,
        ts: Date.now(),
        toolCallId: data.toolCallId,
        toolName: prior?.toolName ?? 'tool',
        args: prior?.args,
        status: data.success ? 'success' : 'error',
        output: resultText,
      });
      break;
    }
    case 'session.error': {
      const message = (event.data as { message?: string }).message ?? 'Unknown error';
      upsertEvent(session, { kind: 'error', id: `error:${event.id}`, ts: Date.now(), message });
      setStatus(session, 'idle');
      break;
    }
    case 'session.idle':
    case 'assistant.idle': {
      setStatus(session, 'idle');
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

function makePermissionHandler(getSession: () => AgentSession | undefined) {
  return async (request: PermissionRequest): Promise<PermissionRequestResult> => {
    const session = getSession();
    if (!session) return { kind: 'approve-once' };
    if (session.mode === 'autopilot') return { kind: 'approve-once' };

    const requestId = randomUUID();
    const { title, detail, canSession } = describePermission(request);
    return new Promise<PermissionRequestResult>((resolve) => {
      session.pendingPermissions.set(requestId, { resolve });
      emit(session, { type: 'permission_request', requestId, title, detail, canSession });
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

    const requestId = randomUUID();
    return new Promise<ExitPlanModeResult>((resolve) => {
      session.pendingPlans.set(requestId, { resolve });
      emit(session, {
        type: 'exit_plan_request',
        requestId,
        summary: request.summary,
        planContent: request.planContent,
        actions: request.actions,
        recommended: request.recommendedAction,
      });
    });
  };
}

export function respondToPermission(
  sessionId: string,
  requestId: string,
  decision: 'approve-once' | 'approve-for-session' | 'reject',
): void {
  const session = agentSessions.get(sessionId);
  if (!session) return;
  const pending = session.pendingPermissions.get(requestId);
  if (!pending) return;
  session.pendingPermissions.delete(requestId);
  const result: PermissionRequestResult =
    decision === 'reject' ? { kind: 'reject' } : { kind: decision };
  pending.resolve(result);
  emit(session, { type: 'permission_resolved', requestId });
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

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export async function createAgentSession(
  userId: string,
  projectId: string | null,
  worktreeId: string | null,
  model = DEFAULT_MODEL,
): Promise<AgentSession> {
  const client = await getClient();
  const cwd = resolveCwd(projectId, worktreeId);

  // Placeholder holder so the permission handler can reach the session even
  // though it's created before the SDK session resolves.
  let sessionRef: AgentSession | undefined;

  const sdk = await client.createSession({
    model,
    streaming: true,
    workingDirectory: cwd,
    onPermissionRequest: makePermissionHandler(() => sessionRef),
    onExitPlanModeRequest: makeExitPlanHandler(() => sessionRef),
  });

  const session: AgentSession = {
    sessionId: sdk.sessionId,
    userId,
    projectId: projectId ?? null,
    worktreeId: worktreeId ?? null,
    cwd,
    model,
    mode: DEFAULT_MODE,
    status: 'idle',
    alive: true,
    transcript: [],
    subscribers: new Set(),
    pendingPermissions: new Map(),
    pendingPlans: new Map(),
    sdk,
    unsubscribe: () => {},
    saveTimer: null,
    assistantByMessageId: new Map(),
    toolByCallId: new Map(),
    share: { mode: 'off', steerable: false },
  };
  sessionRef = session;

  session.unsubscribe = sdk.on((event) => handleSdkEvent(session, event));
  agentSessions.set(session.sessionId, session);

  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO users (id, github_id, role) VALUES (?, ?, ?)').run(userId, userId, 'user');
  db.prepare(
    'INSERT INTO cli_sessions (id, user_id, project_id, worktree_id, copilot_session_id, kind) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(session.sessionId, userId, projectId ?? null, worktreeId ?? null, session.sessionId, 'agent');

  console.log(`[agent-bridge] Created agent session ${session.sessionId}, cwd=${cwd}, model=${model}`);
  return session;
}

export async function sendAgentMessage(sessionId: string, prompt: string): Promise<void> {
  const session = agentSessions.get(sessionId);
  if (!session || !session.alive) return;
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
  try {
    await session.sdk.abort();
  } catch (err) {
    console.error(`[agent-bridge] abort failed for ${sessionId}:`, err);
  }
  setStatus(session, 'idle');
}

export async function setAgentModel(sessionId: string, model: string): Promise<void> {
  const session = agentSessions.get(sessionId);
  if (!session || !session.alive) return;
  try {
    await session.sdk.setModel(model);
    session.model = model;
    emit(session, { type: 'model', model });
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
    const metas = await client.listSessions({ workingDirectory: session.cwd });
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
 * Resume an existing (persisted) agent session, reattaching handlers and
 * restoring the normalized transcript from the DB. Returns the live session, or
 * undefined if it can't be resumed.
 */
export async function resumeAgentSession(userId: string, sessionId: string): Promise<AgentSession | undefined> {
  const existing = agentSessions.get(sessionId);
  if (existing && existing.alive) return existing;

  const client = await getClient();
  let sessionRef: AgentSession | undefined;

  let sdk;
  try {
    sdk = await client.resumeSession(sessionId, {
      streaming: true,
      onPermissionRequest: makePermissionHandler(() => sessionRef),
      onExitPlanModeRequest: makeExitPlanHandler(() => sessionRef),
    });
  } catch (err) {
    console.error(`[agent-bridge] resumeSession failed for ${sessionId}:`, err);
    return undefined;
  }

  // Restore the persisted transcript so the UI shows prior history.
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

  const session: AgentSession = {
    sessionId: sdk.sessionId,
    userId,
    projectId: null,
    worktreeId: null,
    cwd: sdk.workspacePath ?? process.cwd(),
    model: DEFAULT_MODEL,
    mode: DEFAULT_MODE,
    status: 'idle',
    alive: true,
    transcript,
    subscribers: new Set(),
    pendingPermissions: new Map(),
    pendingPlans: new Map(),
    sdk,
    unsubscribe: () => {},
    saveTimer: null,
    assistantByMessageId: new Map(),
    toolByCallId: new Map(),
    share: { mode: 'off', steerable: false },
  };
  sessionRef = session;

  // Sessions created outside this console (e.g. the CLI) have no transcript in
  // our DB. Rebuild it from the SDK's own event log so the UI shows history.
  if (transcript.length === 0) {
    try {
      const past = await (sdk as unknown as { getEvents?: () => Promise<SessionEvent[]> }).getEvents?.();
      if (Array.isArray(past)) {
        for (const event of past) handleSdkEvent(session, event);
      }
    } catch (err) {
      console.error(`[agent-bridge] getEvents replay failed for ${sessionId}:`, err);
    }
    setStatus(session, 'idle');
  }

  session.unsubscribe = sdk.on((event) => handleSdkEvent(session, event));
  agentSessions.set(session.sessionId, session);

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

export async function endAgentSession(sessionId: string): Promise<void> {
  const session = agentSessions.get(sessionId);
  if (!session) return;
  session.alive = false;
  if (session.saveTimer) {
    clearTimeout(session.saveTimer);
    session.saveTimer = null;
  }
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
