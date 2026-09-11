import { describe, it, expect, beforeEach, vi } from 'vitest';
import { shortTitle } from '../shared/delegation-store';

describe('shortTitle', () => {
  it('leaves short labels alone', () => {
    expect(shortTitle('Fix login redirect')).toBe('Fix login redirect');
  });

  it('collapses whitespace', () => {
    expect(shortTitle('Fix   login\n redirect')).toBe('Fix login redirect');
  });

  it('truncates long labels on a word boundary', () => {
    const result = shortTitle('Rewrite the entire authentication subsystem including tokens');
    expect(result.length).toBeLessThanOrEqual(41);
    expect(result.endsWith('…')).toBe(true);
    expect(result).not.toContain('  ');
  });
});

describe('lead plan review', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function loadRuntime(delegation: unknown) {
    const notified: string[] = [];
    const marked: Array<Record<string, unknown>> = [];
    vi.doMock('../shared/delegation-store', () => ({
      getDelegationForWorktree: () => delegation,
      markWorktreeDelegation: (_id: string, patch: Record<string, unknown>) => { marked.push(patch); },
    }));
    vi.doMock('../shared/agent-bridge', () => ({
      getOrCreatePersistentLeadSession: async () => ({ sessionId: 'lead-1' }),
      sendToSession: async (_s: unknown, message: string) => { notified.push(message); },
    }));
    const runtime = await import('../shared/delegation-runtime');
    return { runtime, notified, marked };
  }

  const delegation = { id: 'd1', title: 'Fix login', worktreeId: 'wt-1', projectId: 'p1' };

  it('delivers the plan to the lead and resolves on approval', async () => {
    const { runtime, notified, marked } = await loadRuntime(delegation);

    const review = runtime.requestLeadPlanReview({
      userId: 'u1', projectId: 'p1', worktreeId: 'wt-1',
      summary: 'Add a redirect guard', planContent: '1. add guard\n2. test',
    });

    await vi.waitFor(() => expect(notified.length).toBe(1));
    expect(notified[0]).toContain('worker plan review · Fix login');
    expect(notified[0]).toContain('1. add guard');
    expect(notified[0]).toContain('decide_worker_plan');
    expect(marked[0]).toMatchObject({ status: 'awaiting_plan_review', unread: true });
    expect(runtime.hasPendingPlanReview('wt-1')).toBe(true);

    expect(runtime.resolveLeadPlanReview('wt-1', true, 'Looks right')).toBe(true);
    await expect(review).resolves.toEqual({ approved: true, note: 'Looks right' });
    expect(runtime.hasPendingPlanReview('wt-1')).toBe(false);
  });

  it('resolves as rejected when the lead requests changes', async () => {
    const { runtime, notified } = await loadRuntime(delegation);
    const review = runtime.requestLeadPlanReview({
      userId: 'u1', projectId: 'p1', worktreeId: 'wt-1',
      summary: 'Rewrite everything', planContent: 'rm -rf',
    });
    await vi.waitFor(() => expect(notified.length).toBe(1));

    runtime.resolveLeadPlanReview('wt-1', false, 'Too broad — only touch the auth guard');
    await expect(review).resolves.toEqual({
      approved: false,
      note: 'Too broad — only touch the auth guard',
    });
  });

  it('returns null for a worktree with no delegation, so the user is asked instead', async () => {
    const { runtime, notified } = await loadRuntime(undefined);
    await expect(runtime.requestLeadPlanReview({
      userId: 'u1', projectId: 'p1', worktreeId: 'wt-unknown',
      summary: 's', planContent: 'p',
    })).resolves.toBeNull();
    expect(notified).toEqual([]);
  });

  it('reports no pending review for an unknown worktree', async () => {
    const { runtime } = await loadRuntime(delegation);
    expect(runtime.resolveLeadPlanReview('wt-nope', true, 'ok')).toBe(false);
  });

  it('supersedes an earlier plan from the same worker', async () => {
    const { runtime, notified } = await loadRuntime(delegation);
    const first = runtime.requestLeadPlanReview({
      userId: 'u1', projectId: 'p1', worktreeId: 'wt-1', summary: 'v1', planContent: 'v1',
    });
    await vi.waitFor(() => expect(notified.length).toBe(1));

    const second = runtime.requestLeadPlanReview({
      userId: 'u1', projectId: 'p1', worktreeId: 'wt-1', summary: 'v2', planContent: 'v2',
    });
    await vi.waitFor(() => expect(notified.length).toBe(2));

    await expect(first).resolves.toEqual({ approved: false, note: 'Superseded by a newer plan' });
    runtime.resolveLeadPlanReview('wt-1', true, 'ok');
    await expect(second).resolves.toEqual({ approved: true, note: 'ok' });
  });

  it('gives up cleanly when the lead cannot be reached', async () => {
    vi.doMock('../shared/delegation-store', () => ({
      getDelegationForWorktree: () => delegation,
      markWorktreeDelegation: () => {},
    }));
    vi.doMock('../shared/agent-bridge', () => ({
      getOrCreatePersistentLeadSession: async () => { throw new Error('runtime down'); },
      sendToSession: async () => {},
    }));
    const runtime = await import('../shared/delegation-runtime');
    // null means "no lead answer" so the caller escalates to the user instead.
    await expect(runtime.requestLeadPlanReview({
      userId: 'u1', projectId: 'p1', worktreeId: 'wt-1', summary: 's', planContent: 'p',
    })).resolves.toBeNull();
    expect(runtime.hasPendingPlanReview('wt-1')).toBe(false);
  });
});
