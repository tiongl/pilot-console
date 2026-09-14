import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
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
let leadTodos: Array<Record<string, unknown>> = [];
let artifacts: Array<Record<string, unknown>> = [];

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  paneProps.length = 0;
  delegations = [];
  leadTodos = [];
  artifacts = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/delegations')) return jsonResponse({ delegations });
    if (url.endsWith('/todos')) return jsonResponse({ todos: leadTodos });
    if (url.endsWith('/audit-log')) return jsonResponse({ entries: [] });
    if (url.endsWith('/decision-threads')) return jsonResponse({ threads: [] });
    if (url.endsWith('/memory')) return jsonResponse(null);
    if (url.endsWith('/lavish')) return jsonResponse({ artifacts });
    return jsonResponse({});
  }));
});

afterEach(() => {
  vi.useRealTimers();
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

  /**
   * Nothing ever removed a tab, so the strip grew with every worktree the
   * project had ever used. Closing a worktree retires its delegations, and
   * those must drop out of the strip.
   */
  it('drops the tab for a worktree that has been closed', async () => {
    delegations = [{ ...liveDelegation, status: 'closed' }];
    await renderPage();

    await screen.findByTestId('lead-tab-lead');
    expect(screen.queryByTestId('lead-tab-wt-1')).toBeNull();
    expect(screen.queryByTestId('pane-agent-wt-1')).toBeNull();
  });

  it('keeps the tab for a worktree whose worker merely finished', async () => {
    delegations = [{ ...liveDelegation, status: 'done' }];
    await renderPage();

    expect(await screen.findByTestId('lead-tab-wt-1')).toBeTruthy();
  });

  // A re-delegated worktree keeps its old rows; a closed one must not be
  // resurrected by an earlier, still-open delegation on the same worktree.
  it('ignores an older open delegation once the worktree is closed', async () => {
    delegations = [liveDelegation, { ...cancelledDelegation, id: 'deleg-newest', status: 'closed' }];
    await renderPage();

    await screen.findByTestId('lead-tab-lead');
    expect(screen.queryByTestId('lead-tab-wt-1')).toBeNull();
  });

  /**
   * The lead retires a merged worktree itself, which deletes its delegation and
   * takes the tab with it. The selection was left pointing at a tab that no
   * longer existed, so the page showed no pane at all.
   */
  it('falls back to the lead tab when the open worker is closed', async () => {
    delegations = [liveDelegation];
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderPage();
    fireEvent.click(await screen.findByTestId('lead-tab-wt-1'));
    expect(screen.getByTestId('pane-agent-wt-1')).toBeTruthy();

    // The lead closed it out: its delegation is gone on the next poll.
    delegations = [];
    await vi.advanceTimersByTimeAsync(9000);

    await waitFor(() => expect(screen.queryByTestId('lead-tab-wt-1')).toBeNull());
    expect(screen.getByTestId('lead-tab-lead').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('pane-project_lead-lead')).toBeTruthy();
  });

  it('keeps the chosen worker tab selected while it is still open', async () => {
    delegations = [liveDelegation];
    await renderPage();

    fireEvent.click(await screen.findByTestId('lead-tab-wt-1'));

    expect(screen.getByTestId('lead-tab-wt-1').getAttribute('aria-selected')).toBe('true');
  });

  it('renders a Lavish artifact tab and routes it through AgentPane', async () => {
    artifacts = [
      {
        id: 'a1',
        projectId,
        name: 'Architecture Plan',
        status: 'ready',
        sessionKey: 'key1',
        proxyPath: '/api/lavish/a1/session/key1',
      },
    ];
    await renderPage();

    const tab = await screen.findByTestId('lead-tab-art-a1');
    expect(tab.textContent).toContain('Architecture Plan');

    const pane = screen.getByTestId('pane-artifact-lead');
    expect(pane).toBeTruthy();
    const props = paneProps.find((p) => p.sessionKind === 'artifact');
    expect(props?.artifactId).toBe('a1');
    expect(props?.artifactSessionKey).toBe('key1');
    expect(props?.artifactStatus).toBe('ready');
  });

  it('switches to the worker pane when its tab is clicked', async () => {    delegations = [liveDelegation];
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
/**
 * The details column used to grow the page instead of scrolling inside itself,
 * so a project with a long audit trail pushed the conversation off screen.
 */
describe('ProjectLeadPage details panel', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('scrolls inside its own panel rather than growing the page', async () => {
    await renderPage();

    const panel = await screen.findByTestId('lead-side-panel');
    expect(panel.className).toContain('xl:overflow-y-auto');
    expect(panel.className).toContain('xl:min-h-0');
  });

  it('hides and restores the panel from the toggle', async () => {
    await renderPage();

    const toggle = await screen.findByTestId('lead-side-panel-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(toggle);
    await waitFor(() => expect(screen.queryByTestId('lead-side-panel')).toBeNull());
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toggle);
    expect(await screen.findByTestId('lead-side-panel')).toBeTruthy();
  });

  /**
   * The lead keeps its plan in the project todo list rather than in its replies,
   * where compaction would eventually lose it. The panel is where the user reads
   * that plan back.
   */
  it('shows the project todo list', async () => {
    leadTodos = [
      { id: 't1', projectId, parentId: null, text: 'Ship login', done: 0, position: 0, createdAt: null },
    ];
    await renderPage();

    const panel = await screen.findByTestId('lead-todos');
    expect((await screen.findByTestId('todo-text-t1') as HTMLTextAreaElement).value).toBe('Ship login');
    expect(panel.contains(screen.getByTestId('todo-text-t1'))).toBe(true);
  });

  it('hides the todo list with the rest of the panel', async () => {
    leadTodos = [
      { id: 't1', projectId, parentId: null, text: 'Ship login', done: 0, position: 0, createdAt: null },
    ];
    await renderPage();
    await screen.findByTestId('todo-text-t1');

    fireEvent.click(screen.getByTestId('lead-side-panel-toggle'));

    await waitFor(() => expect(screen.queryByTestId('lead-todos')).toBeNull());
  });

  it('remembers that the panel was hidden', async () => {    await renderPage();
    fireEvent.click(await screen.findByTestId('lead-side-panel-toggle'));
    await waitFor(() => expect(localStorage.getItem('pilot-console:lead-side-panel')).toBe('hidden'));

    cleanup();
    await renderPage();

    await screen.findByTestId('lead-side-panel-toggle');
    expect(screen.queryByTestId('lead-side-panel')).toBeNull();
  });

  it('gives the conversation the full width once the panel is hidden', async () => {
    await renderPage();
    const toggle = await screen.findByTestId('lead-side-panel-toggle');
    const grid = toggle.closest('div.grid');

    expect(grid?.className).toContain('xl:grid-cols-[minmax(0,1fr)_22rem]');
    fireEvent.click(toggle);
    await waitFor(() => expect(grid?.className).toContain('xl:grid-cols-[minmax(0,1fr)]'));
  });
});
