import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SessionEvent } from '@github/copilot-sdk';
import {
  handleSdkEvent,
  pendingMessagesForSession,
  reconcileToolTranscript,
  applyAllowAll,
  resolvePermission,
  autoApprovesPermissions,
  deriveStatusFromEvents,
  checkBusyLiveness,
  eventTs,
  emptyAgentUsage,
  cwdMatches,
  buildToolsForKind,
  type AgentSession,
  type AgentSubscriber,
} from '../shared/agent-bridge';
import type { AgentServerMessage } from '../shared/types';

function makeSession(): { session: AgentSession; messages: AgentServerMessage[] } {
  const messages: AgentServerMessage[] = [];
  const sub: AgentSubscriber = (m) => messages.push(m);
  const session = {
    sessionId: 'test-session',
    userId: 'u1',
    projectId: 'p1',
    worktreeId: null,
    cwd: '/tmp',
    model: 'auto',
    mode: 'interactive',
    status: 'idle',
    alive: true,
    transcript: [],
    subscribers: new Set<AgentSubscriber>([sub]),
    pendingPermissions: new Map(),
    pendingPlans: new Map(),
    saveTimer: null,
    toolReconcileTimer: null,
    toolReconcileInFlight: false,
    assistantByMessageId: new Map<string, string>(),
    assistantStartTs: new Map<string, number>(),
    turnStartTs: null,
    toolByCallId: new Map<string, string>(),
    share: { mode: 'off', steerable: false },
    usage: emptyAgentUsage(),
    allowAllPermissions: false,
  } as unknown as AgentSession;
  return { session, messages };
}

function ev(type: string, id: string, data: unknown, timestamp?: string): SessionEvent {
  return {
    type,
    id,
    parentId: null,
    timestamp: timestamp ?? new Date().toISOString(),
    data,
  } as unknown as SessionEvent;
}

describe('agent-bridge handleSdkEvent', () => {
  afterEach(() => {
    // handleSdkEvent may schedule a debounced DB save; kill it in tests.
    vi.clearAllTimers();
  });

  function drive(session: AgentSession, event: SessionEvent) {
    handleSdkEvent(session, event);
    if (session.saveTimer) {
      clearTimeout(session.saveTimer);
      session.saveTimer = null;
    }
  }

  it('appends a user message to the transcript', () => {
    const { session } = makeSession();
    drive(session, ev('user.message', 'u1', { content: 'hi' }));
    expect(session.transcript).toHaveLength(1);
    expect(session.transcript[0]).toMatchObject({ kind: 'user', content: 'hi' });
  });

  it('accumulates streamed assistant deltas into one entry', () => {
    const { session, messages } = makeSession();
    drive(session, ev('assistant.message_start', 's1', { messageId: 'm1' }));
    drive(session, ev('assistant.message_delta', 'd1', { messageId: 'm1', deltaContent: 'Hel' }));
    drive(session, ev('assistant.message_delta', 'd2', { messageId: 'm1', deltaContent: 'lo' }));

    const assistant = session.transcript.filter((e) => e.kind === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0]).toMatchObject({ content: 'Hello' });
    expect(messages.some((m) => m.type === 'assistant_delta')).toBe(true);
  });

  it('does not create an assistant entry for a turn that never produces text', () => {
    const { session } = makeSession();
    drive(session, ev('assistant.message_start', 's1', { messageId: 'm1' }));
    drive(session, ev('tool.execution_start', 't1', { toolCallId: 'c1', toolName: 'bash' }));

    expect(session.transcript.filter((e) => e.kind === 'assistant')).toHaveLength(0);
  });

  it('ignores an empty final assistant message instead of leaving a blank bubble', () => {
    const { session } = makeSession();
    drive(session, ev('assistant.message_start', 's1', { messageId: 'm1' }));
    drive(session, ev('assistant.message', 'a1', { messageId: 'm1', content: '' }));

    expect(session.transcript.filter((e) => e.kind === 'assistant')).toHaveLength(0);
  });

  it('keeps streamed text when the final assistant message carries no message id', () => {
    const { session } = makeSession();
    drive(session, ev('assistant.message_start', 's1', { messageId: 'm1' }));
    drive(session, ev('assistant.message_delta', 'd1', { messageId: 'm1', deltaContent: 'Hello' }));
    drive(session, ev('assistant.message', 'a1', { content: '' }));

    const assistant = session.transcript.filter((e) => e.kind === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0]).toMatchObject({ content: 'Hello' });
  });

  it('maps tool start/complete to a single tool entry that transitions to success', () => {    const { session } = makeSession();
    drive(session, ev('tool.execution_start', 't1', { toolCallId: 'c1', toolName: 'bash', arguments: { cmd: 'ls' } }));
    let tool = session.transcript.find((e) => e.kind === 'tool');
    expect(tool).toMatchObject({ toolName: 'bash', status: 'running' });

    drive(session, ev('tool.execution_complete', 't2', { toolCallId: 'c1', success: true, result: 'done' }));
    const tools = session.transcript.filter((e) => e.kind === 'tool');
    expect(tools).toHaveLength(1);
    tool = tools[0];
    expect(tool).toMatchObject({ toolName: 'bash', status: 'success', output: 'done' });
  });

  it('records tool progress so clients can explain a long-running call', () => {
    const { session } = makeSession();
    drive(session, ev('tool.execution_start', 't1', { toolCallId: 'c1', toolName: 'apply_patch' }));
    drive(
      session,
      ev('tool.execution_progress', 't2', {
        toolCallId: 'c1',
        progressMessage: 'Applying changes',
      }),
    );

    expect(session.transcript.find((event) => event.kind === 'tool')).toMatchObject({
      toolName: 'apply_patch',
      status: 'running',
      progress: 'Applying changes',
    });
  });

  it('reconciles a missed tool completion from the SDK event log', () => {
    const { session } = makeSession();
    const start = ev('tool.execution_start', 't1', {
      toolCallId: 'c1',
      toolName: 'apply_patch',
      arguments: { patch: 'change' },
    });
    const complete = ev('tool.execution_complete', 't2', {
      toolCallId: 'c1',
      success: true,
      result: { content: 'done', detailedContent: 'Modified 2 files' },
    });
    drive(session, start);

    reconcileToolTranscript(session, [start, complete]);

    expect(session.transcript.find((event) => event.kind === 'tool')).toMatchObject({
      toolName: 'apply_patch',
      status: 'success',
      output: 'Modified 2 files',
    });
  });

  it('clears a stale running tool when the SDK reports the session is idle', () => {
    const { session } = makeSession();
    const start = ev('tool.execution_start', 't1', {
      toolCallId: 'c1',
      toolName: 'apply_patch',
    });
    drive(session, start);

    reconcileToolTranscript(session, [start, ev('session.idle', 'idle1', {})]);

    expect(session.transcript.find((event) => event.kind === 'tool')).toMatchObject({
      status: 'error',
      output: 'Tool ended without returning a completion result.',
    });
  });

  it('emits a status change to busy on turn start and idle on session.idle', () => {
    const { session, messages } = makeSession();
    drive(session, ev('assistant.turn_start', 's1', {}));
    expect(session.status).toBe('busy');
    drive(session, ev('session.idle', 's2', {}));
    expect(session.status).toBe('idle');
    const statusMsgs = messages.filter((m) => m.type === 'status');
    expect(statusMsgs.map((m) => (m as { status: string }).status)).toContain('busy');
  });

  it('records session errors as error entries and returns to idle', () => {
    const { session } = makeSession();
    session.status = 'busy';
    drive(session, ev('session.error', 'e1', { message: 'boom' }));
    expect(session.transcript.some((e) => e.kind === 'error')).toBe(true);
    expect(session.status).toBe('idle');
  });

  it('updates share.steerable and broadcasts share_status on remote_steerable_changed', () => {
    const { session, messages } = makeSession();
    drive(session, ev('session.remote_steerable_changed', 'r1', { remoteSteerable: true }));
    expect(session.share.steerable).toBe(true);
    // Steering implies the session is at least shared.
    expect(session.share.mode).toBe('on');
    const shareMsg = messages.find((m) => m.type === 'share_status') as
      | { type: 'share_status'; status: { steerable: boolean; mode: string } }
      | undefined;
    expect(shareMsg?.status).toMatchObject({ steerable: true, mode: 'on' });
  });

  it('returns pending permission and plan prompts for reconnecting clients', () => {
    const { session } = makeSession();
    const permission: Extract<AgentServerMessage, { type: 'permission_request' }> = {
      type: 'permission_request',
      requestId: 'permission-1',
      title: 'Run shell command',
      detail: 'npm test',
      canSession: true,
    };
    const plan: Extract<AgentServerMessage, { type: 'exit_plan_request' }> = {
      type: 'exit_plan_request',
      requestId: 'plan-1',
      summary: 'Implement the fix',
      actions: ['interactive', 'autopilot'],
      recommended: 'autopilot',
    };
    session.pendingPermissions.set(permission.requestId, { resolve: vi.fn(), message: permission });
    session.pendingPlans.set(plan.requestId, { resolve: vi.fn(), message: plan });

    expect(pendingMessagesForSession(session)).toEqual([permission, plan]);
  });

  it('auto-approves permissions in auto-pilot or when allow-all is on', () => {
    const { session } = makeSession();
    expect(autoApprovesPermissions(session)).toBe(false);

    session.mode = 'autopilot';
    expect(autoApprovesPermissions(session)).toBe(true);

    session.mode = 'plan';
    session.allowAllPermissions = true;
    expect(autoApprovesPermissions(session)).toBe(true);
  });

  it('approve-all resolves the prompt and stops asking for the rest of the session', () => {
    const { session, messages } = makeSession();
    const resolve = vi.fn();
    session.pendingPermissions.set('r1', {
      resolve,
      message: { type: 'permission_request', requestId: 'r1', title: 'Run', detail: 'ls', canSession: false },
    });

    resolvePermission(session, 'r1', 'approve-all');

    expect(resolve).toHaveBeenCalledWith({ kind: 'approve-once' });
    expect(session.allowAllPermissions).toBe(true);
    expect(session.pendingPermissions.size).toBe(0);
    expect(messages).toContainEqual({ type: 'permission_resolved', requestId: 'r1' });
    expect(messages).toContainEqual({ type: 'allow_all', enabled: true });
  });

  it('enabling allow-all drains every queued permission prompt', () => {
    const { session, messages } = makeSession();
    const first = vi.fn();
    const second = vi.fn();
    session.pendingPermissions.set('r1', {
      resolve: first,
      message: { type: 'permission_request', requestId: 'r1', title: 'Run', detail: 'ls', canSession: false },
    });
    session.pendingPermissions.set('r2', {
      resolve: second,
      message: { type: 'permission_request', requestId: 'r2', title: 'Write', detail: 'a.txt', canSession: false },
    });

    applyAllowAll(session, true);

    expect(first).toHaveBeenCalledWith({ kind: 'approve-once' });
    expect(second).toHaveBeenCalledWith({ kind: 'approve-once' });
    expect(session.pendingPermissions.size).toBe(0);
    expect(messages.filter((m) => m.type === 'permission_resolved')).toHaveLength(2);
  });

  it('disabling allow-all restores prompting without touching the queue', () => {
    const { session, messages } = makeSession();
    session.allowAllPermissions = true;

    applyAllowAll(session, false);

    expect(session.allowAllPermissions).toBe(false);
    expect(autoApprovesPermissions(session)).toBe(false);
    expect(messages).toContainEqual({ type: 'allow_all', enabled: false });
  });
});

describe('event timestamps and durations', () => {
  afterEach(() => {
    vi.clearAllTimers();
  });

  it('parses ISO timestamps and falls back to now when unusable', () => {
    const iso = '2024-05-01T10:20:30.000Z';
    expect(eventTs(ev('user.message', 'u1', {}, iso))).toBe(Date.parse(iso));
    const before = Date.now();
    expect(eventTs(ev('user.message', 'u2', {}, 'not-a-date'))).toBeGreaterThanOrEqual(before);
  });

  it('stamps entries with the runtime event time, not ingestion time', () => {
    const { session } = makeSession();
    const iso = '2024-05-01T10:20:30.000Z';
    handleSdkEvent(session, ev('user.message', 'u1', { content: 'hi' }, iso));
    expect(session.transcript[0].ts).toBe(Date.parse(iso));
  });

  it('derives assistant duration from message_start to message', () => {
    const { session } = makeSession();
    const start = '2024-05-01T10:20:30.000Z';
    const end = '2024-05-01T10:20:34.500Z';
    handleSdkEvent(session, ev('assistant.message_start', 'a0', { messageId: 'm1' }, start));
    handleSdkEvent(session, ev('assistant.message', 'a1', { messageId: 'm1', content: 'done' }, end));
    const entry = session.transcript.find((e) => e.kind === 'assistant');
    expect(entry).toBeDefined();
    expect(entry?.ts).toBe(Date.parse(start));
    expect(entry?.kind === 'assistant' && entry.durationMs).toBe(4_500);
  });

  it('measures assistant duration from the user request, not the first token', () => {
    const { session } = makeSession();
    const ask = '2024-05-01T10:20:00.000Z';
    const start = '2024-05-01T10:20:30.000Z';
    const end = '2024-05-01T10:20:34.500Z';
    handleSdkEvent(session, ev('user.message', 'u1', { content: 'hi' }, ask));
    handleSdkEvent(session, ev('assistant.message_start', 'a0', { messageId: 'm1' }, start));
    handleSdkEvent(session, ev('assistant.message', 'a1', { messageId: 'm1', content: 'done' }, end));
    const entry = session.transcript.find((e) => e.kind === 'assistant');
    // 34.5s of round trip from the moment the user asked, not 4.5s of tokens.
    expect(entry?.kind === 'assistant' && entry.durationMs).toBe(34_500);
  });

  it('reports the turn start time with the busy status and clears it when idle', () => {
    const { session, messages } = makeSession();
    const ask = '2024-05-01T10:20:00.000Z';
    handleSdkEvent(session, ev('user.message', 'u1', { content: 'hi' }, ask));
    handleSdkEvent(session, ev('assistant.turn_start', 'a0', {}, ask));
    expect(messages).toContainEqual({ type: 'status', status: 'busy', turnStartedAt: Date.parse(ask) });

    handleSdkEvent(session, ev('session.idle', 'i0', {}, ask));
    expect(messages).toContainEqual({ type: 'status', status: 'idle', turnStartedAt: null });
    expect(session.turnStartTs).toBeNull();
  });

  it('derives tool duration from execution_start to execution_complete', () => {
    const { session } = makeSession();
    const start = '2024-05-01T10:20:30.000Z';
    const end = '2024-05-01T10:20:32.250Z';
    handleSdkEvent(
      session,
      ev('tool.execution_start', 't0', { toolCallId: 'c1', toolName: 'bash' }, start),
    );
    handleSdkEvent(
      session,
      ev('tool.execution_complete', 't1', { toolCallId: 'c1', success: true, result: 'ok' }, end),
    );
    const entry = session.transcript.find((e) => e.kind === 'tool');
    expect(entry?.ts).toBe(Date.parse(start));
    expect(entry?.kind === 'tool' && entry.durationMs).toBe(2_250);
  });
});

describe('usage accounting', () => {
  afterEach(() => {
    vi.clearAllTimers();
  });

  it('accumulates token and cost usage across model calls', () => {
    const { session, messages } = makeSession();
    handleSdkEvent(
      session,
      ev('assistant.usage', 'x1', {
        model: 'claude',
        inputTokens: 1_000,
        outputTokens: 200,
        cacheReadTokens: 50,
        reasoningTokens: 30,
        cost: 1,
        copilotUsage: { totalNanoAiu: 1_500_000 },
      }),
    );
    handleSdkEvent(
      session,
      ev('assistant.usage', 'x2', {
        model: 'claude',
        inputTokens: 500,
        outputTokens: 100,
        cost: 0.5,
        copilotUsage: { totalNanoAiu: 700_000 },
      }),
    );

    expect(session.usage).toMatchObject({
      requests: 2,
      inputTokens: 1_500,
      outputTokens: 300,
      cachedTokens: 50,
      reasoningTokens: 30,
      premiumRequests: 1.5,
      nanoAiu: 2_200_000,
    });
    const usageMsgs = messages.filter((m) => m.type === 'usage');
    expect(usageMsgs).toHaveLength(2);
  });

  it('ignores a usage checkpoint that is behind the live total', () => {
    const { session } = makeSession();
    handleSdkEvent(session, ev('session.usage_checkpoint', 'c1', { totalNanoAiu: 5_000 }));
    expect(session.usage.nanoAiu).toBe(5_000);
    handleSdkEvent(session, ev('session.usage_checkpoint', 'c2', { totalNanoAiu: 1_000 }));
    expect(session.usage.nanoAiu).toBe(5_000);
  });

  it('records context-window occupancy from usage_info', () => {
    const { session } = makeSession();
    handleSdkEvent(session, ev('session.usage_info', 'i1', { currentTokens: 12_000, tokenLimit: 200_000 }));
    expect(session.usage.contextTokens).toBe(12_000);
    expect(session.usage.contextLimit).toBe(200_000);
  });

  it('starts with a zeroed usage accumulator', () => {
    expect(emptyAgentUsage()).toMatchObject({ requests: 0, inputTokens: 0, nanoAiu: 0 });
  });
});

describe('deriveStatusFromEvents', () => {
  it('treats a missing or empty event log as idle', () => {
    expect(deriveStatusFromEvents(undefined)).toBe('idle');
    expect(deriveStatusFromEvents([])).toBe('idle');
  });

  it('reports busy when the last turn boundary started work', () => {
    const events = [ev('user.message', 'u1', { content: 'go' }), ev('tool.execution_start', 't1', {})];
    expect(deriveStatusFromEvents(events)).toBe('busy');
  });

  it('reports idle once the turn has ended', () => {
    const events = [
      ev('user.message', 'u1', { content: 'go' }),
      ev('tool.execution_start', 't1', {}),
      ev('session.idle', 'i1', {}),
    ];
    expect(deriveStatusFromEvents(events)).toBe('idle');
  });

  it('ignores events that are not turn boundaries', () => {
    const events = [ev('session.idle', 'i1', {}), ev('assistant.reasoning', 'r1', { content: 'hmm' })];
    expect(deriveStatusFromEvents(events)).toBe('idle');
  });

  // The persisted log returned by `getEvents()` is NOT the live event stream:
  // it ends at `assistant.turn_end` and never carries `session.idle`. Reading a
  // finished session as busy would leave the UI spinning forever.
  it('treats a completed turn in the persisted log as idle', () => {
    const events = [
      ev('session.start', 's1', {}),
      ev('user.message', 'u1', { content: 'hi' }),
      ev('assistant.turn_start', 'ts1', {}),
      ev('assistant.message', 'm1', { content: 'kiwi' }),
      ev('assistant.turn_end', 'te1', {}),
      ev('hook.start', 'h1', {}),
      ev('hook.end', 'h2', {}),
    ];
    expect(deriveStatusFromEvents(events)).toBe('idle');
  });

  it('still reports busy for a turn that started but never ended', () => {
    const events = [
      ev('user.message', 'u1', { content: 'hi' }),
      ev('assistant.turn_start', 'ts1', {}),
      ev('tool.execution_start', 't1', {}),
    ];
    expect(deriveStatusFromEvents(events)).toBe('busy');
  });

  // The runtime tears a session down when its owning client disconnects; that
  // session is finished, not busy, however abruptly it ended.
  it('treats a runtime-side session shutdown as idle', () => {
    const events = [
      ev('user.message', 'u1', { content: 'hi' }),
      ev('assistant.turn_start', 'ts1', {}),
      ev('session.shutdown', 'sd1', {}),
    ];
    expect(deriveStatusFromEvents(events)).toBe('idle');
  });
});

describe('busy watchdog', () => {
  it('recovers a stuck busy session when the runtime says the turn is over', async () => {
    const { session, messages } = makeSession();
    session.status = 'busy';
    session.sdk = {
      getEvents: vi.fn().mockResolvedValue([ev('user.message', 'u1', { content: 'go' }), ev('session.idle', 'i1', {})]),
    } as unknown as AgentSession['sdk'];

    await checkBusyLiveness(session);

    expect(session.status).toBe('idle');
    expect(messages).toContainEqual({ type: 'status', status: 'idle', turnStartedAt: null });
    expect(session.transcript.some((e) => e.kind === 'notice')).toBe(true);
  });

  it('leaves a genuinely busy session alone', async () => {
    const { session } = makeSession();
    session.status = 'busy';
    session.sdk = {
      getEvents: vi.fn().mockResolvedValue([ev('user.message', 'u1', { content: 'go' })]),
    } as unknown as AgentSession['sdk'];

    await checkBusyLiveness(session);

    expect(session.status).toBe('busy');
  });

  it('surfaces an error and unsticks the UI when the runtime is unreachable', async () => {
    const { session } = makeSession();
    session.status = 'busy';
    session.sdk = {
      getEvents: vi.fn().mockRejectedValue(new Error('no such session')),
    } as unknown as AgentSession['sdk'];

    await checkBusyLiveness(session);

    expect(session.status).toBe('idle');
    expect(session.transcript.some((e) => e.kind === 'error')).toBe(true);
  });

  it('does nothing for a session that is not busy', async () => {
    const { session } = makeSession();
    const getEvents = vi.fn();
    session.sdk = { getEvents } as unknown as AgentSession['sdk'];

    await checkBusyLiveness(session);

    expect(getEvents).not.toHaveBeenCalled();
  });
});

describe('session cwd matching', () => {
  const root = 'C:\\Users\\me\\repos\\app';

  it('matches the working directory exactly', () => {
    expect(cwdMatches('C:\\Users\\me\\repos\\app', root)).toBe(true);
  });

  it('matches regardless of slash direction and trailing separators', () => {
    expect(cwdMatches('C:/Users/me/repos/app', root)).toBe(true);
    expect(cwdMatches('C:\\Users\\me\\repos\\app\\', root)).toBe(true);
  });

  it('matches subdirectories of the repo', () => {
    expect(cwdMatches('C:\\Users\\me\\repos\\app\\src\\server', root)).toBe(true);
  });

  it('does not match a sibling directory that merely shares a prefix', () => {
    expect(cwdMatches('C:\\Users\\me\\repos\\app-worktree1', root)).toBe(false);
  });

  it('ignores sessions with no recorded working directory', () => {
    expect(cwdMatches(undefined, root)).toBe(false);
  });
});

describe('buildToolsForKind', () => {
  // Regression coverage for a bug where resuming a session after a server
  // restart lost its tools: the SDK negotiates tool availability per
  // connection, and `resumeAgentSession` was hardcoding kind 'agent' and
  // never passing `tools` to `client.resumeSession`. Any session that needed
  // a tool call (worktree/merge/project-lead/chief-of-staff sessions) would
  // then silently stall or error on the next turn — the "dead after restart"
  // symptom. `createAgentSession` and `resumeAgentSession` both now derive
  // their tool set from this single helper so they can never drift apart.
  it('gives chief_of_staff sessions the chief-of-staff tool set regardless of scope', () => {
    const tools = buildToolsForKind('chief_of_staff', null, null);
    expect(tools).toBeDefined();
    expect(tools!.length).toBeGreaterThan(0);
  });

  it('gives project_lead sessions the project-lead tool set when a projectId is present', () => {
    const tools = buildToolsForKind('project_lead', 'proj-1', null);
    expect(tools).toBeDefined();
    expect(tools!.length).toBeGreaterThan(0);
  });

  it('gives project_lead sessions no tools when projectId is missing', () => {
    expect(buildToolsForKind('project_lead', null, null)).toBeUndefined();
  });

  it('gives plain agent sessions worktree + merge tools when scoped to a worktree', () => {
    const tools = buildToolsForKind('agent', null, 'wt-1');
    expect(tools).toBeDefined();
    expect(tools!.length).toBeGreaterThan(0);
  });

  it('gives plain agent sessions with no worktree no extra tools', () => {
    expect(buildToolsForKind('agent', null, null)).toBeUndefined();
  });
});
