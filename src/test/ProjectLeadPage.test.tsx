import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';

/**
 * AgentPane owns a websocket and an editor; the tabs are what is under test, so
 * it is replaced with a marker that reports the props the page chose.
 */
const paneProps: Array<Record<string, unknown>> = [];
vi.mock('@/components/terminal/AgentPane', () => ({
  default: (props: Record<string, unknown>) => {
    paneProps.push(props);
    return (
      <div
        data-testid={`pane-${props.sessionKind ?? 'agent'}-${props.worktreeId ?? 'lead'}`}
        data-session-id={String(props.sessionId ?? '')}
      />
    );
  },
}));

const projectId = 'p1';

const cancelledDelegation = {
  id: 'deleg-old',
  worktreeId: 'wt-1',
  sessionId: 'session-old',
  title: 'W29 multi-source',
  status: 'cancelled',
  note: null,
  unread: 0,
};

const liveDelegation = {
  id: 'deleg-new',
  worktreeId: 'wt-1',
  sessionId: 'session-new',
  title: 'W29 multi-source',
  status: 'working',
  note: null,
  unread: 0,
};

let delegations: Array<Record<string, unknown>> = [];

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  paneProps.length = 0;
  delegations = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/delegations')) return jsonResponse({ delegations });
    if (url.endsWith('/audit-log')) return jsonResponse({ entries: [] });
    if (url.endsWith('/decision-threads')) return jsonResponse({ threads: [] });
    if (url.endsWith('/memory')) return jsonResponse(null);
    return jsonResponse({});
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderPage() {
  const { default: ProjectLeadPage } = await import('@/pages/ProjectLeadPage');
  render(
    <MemoryRouter initialEntries={[`/projects/${projectId}/lead`]}>
      <Routes>
        <Route path="/projects/:id/lead" element={<ProjectLeadPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ProjectLeadPage worker tabs', () => {
  /**
   * The pane used to be resolved from the project and worktree alone, which
   * picks whichever session in that directory was touched most recently — not
   * necessarily this worker, and never the right one after a server restart.
   * The result was a worker tab that showed an empty conversation.
   */
  it('opens the worker tab on that worker\'s own session', async () => {
    delegations = [liveDelegation];
    await renderPage();

    const pane = await screen.findByTestId('pane-agent-wt-1');
    expect(pane.getAttribute('data-session-id')).toBe('session-new');
  });

  /**
   * Re-delegating leaves the closed-out delegation behind. Both rendered, so a
   * worktree got two tabs sharing one id and clicking either displayed both
   * panes stacked.
   */
  it('shows one tab per worktree, owned by the newest delegation', async () => {
    delegations = [cancelledDelegation, liveDelegation];
    await renderPage();

    await screen.findByTestId('lead-tab-wt-1');
    expect(screen.getAllByTestId('lead-tab-wt-1')).toHaveLength(1);
    expect(screen.getAllByTestId('pane-agent-wt-1')).toHaveLength(1);
    expect(screen.getByTestId('pane-agent-wt-1').getAttribute('data-session-id')).toBe('session-new');
  });

  it('switches to the worker pane when its tab is clicked', async () => {
    delegations = [liveDelegation];
    await renderPage();

    fireEvent.click(await screen.findByTestId('lead-tab-wt-1'));

    const pane = screen.getByTestId('pane-agent-wt-1');
    await waitFor(() => expect(pane.parentElement?.style.display).toBe('block'));
    expect(screen.getByTestId('pane-project_lead-lead').parentElement?.style.display).toBe('none');
    // The visible pane is the one told it is active, so it connects and streams.
    const workerProps = paneProps.filter((p) => p.worktreeId === 'wt-1');
    expect(workerProps[workerProps.length - 1].active).toBe(true);
  });

  it('keeps the lead tab on the project lead session', async () => {
    delegations = [];
    await renderPage();

    const pane = await screen.findByTestId('pane-project_lead-lead');
    expect(pane.parentElement?.style.display).toBe('block');
  });
});
