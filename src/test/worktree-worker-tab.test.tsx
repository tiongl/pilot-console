import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

/**
 * The heavy panes own websockets and terminals; the tab strip is what is under
 * test, so each pane is reduced to a marker carrying its session id.
 */
vi.mock('@/components/terminal/AgentPane', () => ({
  default: (props: Record<string, unknown>) => (
    <div data-testid="agent-pane" data-session-id={String(props.sessionId ?? '')} />
  ),
}));
vi.mock('@/components/terminal/TerminalPane', () => ({
  default: () => <div data-testid="terminal-pane" />,
  TERMINAL_FONTS: [{ name: 'Mono', family: 'monospace' }],
}));
vi.mock('@/components/terminal/CliPane', () => ({ default: () => <div data-testid="cli-pane" /> }));
vi.mock('@/components/project/GitLogTab', () => ({ default: () => <div /> }));
vi.mock('@/components/project/GitPanel', () => ({ default: () => <div /> }));
vi.mock('@/components/project/FileExplorer', () => ({ default: () => <div /> }));

const projectId = 'p1';
const worktreeId = 'wt-1';
const WORKTREE_CWD = 'C:/repos/wt-1';

let delegations: Array<Record<string, unknown>> = [];

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  localStorage.clear();
  delegations = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/delegations')) return jsonResponse({ delegations });
    if (url.includes('/sessions/active')) return jsonResponse({ sessions: [] });
    if (url.includes('/seed')) return jsonResponse({ seed: null });
    return jsonResponse({});
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

async function renderWorktree() {
  const { default: ProjectChatPage } = await import('@/pages/ProjectChatPage');
  const { ProjectSplitProvider } = await import('@/lib/project-split-context');
  return render(
    <MemoryRouter>
      <ProjectSplitProvider stateKey="test">
        <ProjectChatPage projectId={projectId} worktreeId={worktreeId} cwd={WORKTREE_CWD} />
      </ProjectSplitProvider>
    </MemoryRouter>,
  );
}

/**
 * Opening a delegated worktree used to land on a blank CLI tab, leaving no way
 * to see what the worker had been doing without going via the lead page.
 */
describe('worktree worker tab', () => {
  it('pins the worker conversation as the first tab', async () => {
    delegations = [{ worktreeId, sessionId: 'session-1', title: 'W29 parser fix' }];
    await renderWorktree();

    const tab = await screen.findByTestId('worker-tab');
    expect(tab.textContent).toContain('W29 parser fix');

    const strip = tab.parentElement!;
    expect(Array.from(strip.children).indexOf(tab)).toBe(0);
    await waitFor(() =>
      expect(screen.getByTestId('agent-pane').getAttribute('data-session-id')).toBe('session-1'),
    );
  });

  it('has no close button', async () => {
    delegations = [{ worktreeId, sessionId: 'session-1', title: 'W29 parser fix' }];
    await renderWorktree();

    const tab = await screen.findByTestId('worker-tab');
    // Only the "open in a new browser tab" control remains.
    expect(tab.querySelectorAll('button')).toHaveLength(1);
    expect(tab.getAttribute('draggable')).toBe('false');
  });

  it('follows the newest delegation when a worktree is re-delegated', async () => {
    delegations = [
      { worktreeId, sessionId: 'session-old', title: 'W29 first try' },
      { worktreeId, sessionId: 'session-new', title: 'W29 retry' },
    ];
    await renderWorktree();

    const tab = await screen.findByTestId('worker-tab');
    expect(tab.textContent).toContain('W29 retry');
    await waitFor(() =>
      expect(screen.getByTestId('agent-pane').getAttribute('data-session-id')).toBe('session-new'),
    );
  });

  it('leaves an undelegated worktree alone', async () => {
    delegations = [{ worktreeId: 'other-wt', sessionId: 'session-1', title: 'Elsewhere' }];
    await renderWorktree();

    await screen.findByRole('button', { name: /new tab/i }).catch(() => null);
    await waitFor(() => expect(screen.queryByTestId('worker-tab')).toBeNull());
  });

  // The lead can retire a merged worktree. Its delegation rows go `closed`, and
  // the pinned tab must not resurrect the dead session.
  it('drops the worker tab once the worktree is closed', async () => {
    delegations = [{ worktreeId, sessionId: 'session-1', title: 'W29 parser fix', status: 'closed' }];
    await renderWorktree();

    await waitFor(() => expect(screen.queryByTestId('worker-tab')).toBeNull());
  });

  it('ignores an older open delegation once the worktree is closed', async () => {
    delegations = [
      { worktreeId, sessionId: 'session-old', title: 'W29 parser fix', status: 'working' },
      { worktreeId, sessionId: 'session-new', title: 'W29 parser fix', status: 'closed' },
    ];
    await renderWorktree();

    await waitFor(() => expect(screen.queryByTestId('worker-tab')).toBeNull());
  });

  it('does not persist the worker tab, so a stale session is never restored', async () => {
    delegations = [{ worktreeId, sessionId: 'session-1', title: 'W29 parser fix' }];
    await renderWorktree();
    await screen.findByTestId('worker-tab');

    await waitFor(() => {
      const raw = localStorage.getItem(`pilot-console-tabs:${WORKTREE_CWD}`);
      expect(raw).toBeTruthy();
      const saved = JSON.parse(raw!) as { tabs: Array<{ pinned?: boolean; sessionId?: string }> };
      expect(saved.tabs.some((t) => t.pinned)).toBe(false);
      expect(saved.tabs.some((t) => t.sessionId === 'session-1')).toBe(false);
    });
  });

  it('clicking the worker tab shows the worker session', async () => {
    delegations = [{ worktreeId, sessionId: 'session-1', title: 'W29 parser fix' }];
    await renderWorktree();

    fireEvent.click(await screen.findByTestId('worker-tab'));

    const pane = screen.getByTestId('agent-pane');
    await waitFor(() => expect(pane.parentElement?.style.display).toBe('block'));
  });
});
