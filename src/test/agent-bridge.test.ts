import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SessionEvent } from '@github/copilot-sdk';
import { handleSdkEvent, type AgentSession, type AgentSubscriber } from '../shared/agent-bridge';
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
    assistantByMessageId: new Map<string, string>(),
    toolByCallId: new Map<string, string>(),
    share: { mode: 'off', steerable: false },
  } as unknown as AgentSession;
  return { session, messages };
}

function ev(type: string, id: string, data: unknown): SessionEvent {
  return { type, id, parentId: null, timestamp: Date.now(), data } as unknown as SessionEvent;
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

  it('maps tool start/complete to a single tool entry that transitions to success', () => {
    const { session } = makeSession();
    drive(session, ev('tool.execution_start', 't1', { toolCallId: 'c1', toolName: 'bash', arguments: { cmd: 'ls' } }));
    let tool = session.transcript.find((e) => e.kind === 'tool');
    expect(tool).toMatchObject({ toolName: 'bash', status: 'running' });

    drive(session, ev('tool.execution_complete', 't2', { toolCallId: 'c1', success: true, result: 'done' }));
    const tools = session.transcript.filter((e) => e.kind === 'tool');
    expect(tools).toHaveLength(1);
    tool = tools[0];
    expect(tool).toMatchObject({ toolName: 'bash', status: 'success', output: 'done' });
  });

  it('caps large tool output to bound transcript memory', () => {
    const { session } = makeSession();
    drive(session, ev('tool.execution_start', 't1', { toolCallId: 'c1', toolName: 'bash' }));
    const big = 'x'.repeat(200_000);
    drive(session, ev('tool.execution_complete', 't2', { toolCallId: 'c1', success: true, result: big }));
    const tool = session.transcript.find((e) => e.kind === 'tool') as { output?: string };
    expect(tool.output!.length).toBeLessThan(big.length);
    expect(tool.output).toContain('[truncated');
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
});
