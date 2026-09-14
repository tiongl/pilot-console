import { describe, it, expect, vi } from 'vitest';
import {
  sendToSession,
  flushQueuedPrompts,
  emptyAgentUsage,
  type AgentSession,
  type AgentSubscriber,
} from '../shared/agent-bridge';
import type { AgentServerMessage } from '../shared/types';

function makeSession(): { session: AgentSession; messages: AgentServerMessage[]; sent: string[] } {
  const messages: AgentServerMessage[] = [];
  const sent: string[] = [];
  const sub: AgentSubscriber = (m) => messages.push(m);
  const session = {
    sessionId: 'queue-session',
    userId: 'u1',
    projectId: 'p1',
    worktreeId: null,
    kind: 'project_lead',
    cwd: '/tmp',
    model: 'auto',
    mode: 'interactive',
    status: 'idle',
    alive: true,
    transcript: [],
    subscribers: new Set<AgentSubscriber>([sub]),
    pendingPermissions: new Map(),
    pendingPlans: new Map(),
    sdk: {
      send: vi.fn(async ({ prompt }: { prompt: string }) => { sent.push(prompt); }),
      getEvents: undefined,
    },
    unsubscribe: () => {},
    saveTimer: null,
    toolReconcileTimer: null,
    toolReconcileInFlight: false,
    busyWatchdogTimer: null,
    busyWatchdogInFlight: false,
    assistantByMessageId: new Map<string, string>(),
    assistantStartTs: new Map<string, number>(),
    turnStartTs: null,
    toolByCallId: new Map<string, string>(),
    share: { mode: 'off', steerable: false },
    usage: emptyAgentUsage(),
    allowAllPermissions: false,
    queuedPrompts: [],
  } as unknown as AgentSession;
  return { session, messages, sent };
}

const queuedMessages = (messages: AgentServerMessage[]) =>
  messages.filter((m): m is Extract<AgentServerMessage, { type: 'queued' }> => m.type === 'queued');

describe('mid-turn follow-up queue', () => {
  it('sends immediately when the session is idle', async () => {
    const { session, sent } = makeSession();
    await sendToSession(session, 'first');
    expect(sent).toEqual(['first']);
    expect(session.queuedPrompts).toEqual([]);
  });

  it('queues instead of dropping input while a turn is in flight', async () => {
    const { session, sent, messages } = makeSession();
    session.status = 'busy';

    await sendToSession(session, 'what about the other topic?');

    expect(sent).toEqual([]);
    expect(session.queuedPrompts).toEqual(['what about the other topic?']);
    expect(queuedMessages(messages).at(-1)?.prompts).toEqual(['what about the other topic?']);
  });

  it('preserves order across several queued follow-ups', async () => {
    const { session } = makeSession();
    session.status = 'busy';
    await sendToSession(session, 'one');
    await sendToSession(session, 'two');
    expect(session.queuedPrompts).toEqual(['one', 'two']);
  });

  it('flushes the oldest follow-up once the turn ends', async () => {
    const { session, sent } = makeSession();
    session.status = 'busy';
    await sendToSession(session, 'one');
    await sendToSession(session, 'two');

    session.status = 'idle';
    await flushQueuedPrompts(session);

    expect(sent).toEqual(['one']);
    expect(session.queuedPrompts).toEqual(['two']);
    expect(session.status).toBe('busy');
  });

  it('does not flush while the session is still busy', async () => {
    const { session, sent } = makeSession();
    session.status = 'busy';
    await sendToSession(session, 'one');

    await flushQueuedPrompts(session);

    expect(sent).toEqual([]);
    expect(session.queuedPrompts).toEqual(['one']);
  });

  it('is a no-op when nothing is queued', async () => {
    const { session, sent } = makeSession();
    await flushQueuedPrompts(session);
    expect(sent).toEqual([]);
  });
});
