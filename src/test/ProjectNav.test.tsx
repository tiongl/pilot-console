import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import ProjectNav from '@/components/nav/ProjectNav';
import type { Project } from '@/types';

const project = { id: 'p1', name: 'WebOS' } as unknown as Project;

const managedWorktree = {
  id: 'wt-1',
  projectId: 'p1',
  name: 'parser-fix',
  branch: 'feat/parser-fix',
  worktreePath: 'C:\\repos\\webos-parser-fix',
  isManaged: true,
  type: 'worktree',
  issueNumber: null,
  createdAt: '2026-01-01T00:00:00Z',
};

const attachedWorktree = { ...managedWorktree, id: 'wt-2', name: 'legacy', isManaged: false };

let worktrees = [managedWorktree];
let fetchMock: ReturnType<typeof vi.fn>;

function mockFetch() {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/projects') return jsonResponse({ projects: [] });
    if (url === '/api/sessions/active') return jsonResponse({ sessions: [] });
    if (url === '/api/projects/p1/worktrees' && !init) return jsonResponse({ worktrees });
    if (init?.method === 'DELETE') return jsonResponse({ ok: true });
    return jsonResponse({});
  });
  vi.stubGlobal('fetch', fetchMock);
}

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body } as unknown as Response;
}

/** Render the nav and expand the project so its worktrees are listed. */
async function renderExpanded() {
  render(
    <MemoryRouter>
      <ProjectNav projects={[project]} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getAllByRole('button')[0]);
  await screen.findByText(worktrees[0].name);
}

beforeEach(() => {
  worktrees = [managedWorktree];
  mockFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * Deleting a worktree destroys a directory, so it must never happen on a
 * stray click: the right-click entry only opens a dialog that names what is
 * about to be removed, and nothing is requested until that is confirmed.
 */
describe('ProjectNav worktree deletion', () => {
  it('opens a delete entry from the worktree context menu', async () => {
    await renderExpanded();

    fireEvent.contextMenu(screen.getByText('parser-fix'));

    expect(await screen.findByText('Delete worktree…')).toBeTruthy();
  });

  it('asks for confirmation before deleting and names the directory at risk', async () => {
    await renderExpanded();

    fireEvent.contextMenu(screen.getByText('parser-fix'));
    fireEvent.click(await screen.findByText('Delete worktree…'));

    expect(await screen.findByText('Delete worktree?')).toBeTruthy();
    expect(screen.getByText(/C:\\repos\\webos-parser-fix/)).toBeTruthy();
    expect(screen.getByText(/deleted from disk/)).toBeTruthy();
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit)?.method === 'DELETE')).toBe(false);
  });

  it('does not delete when the dialog is cancelled', async () => {
    await renderExpanded();

    fireEvent.contextMenu(screen.getByText('parser-fix'));
    fireEvent.click(await screen.findByText('Delete worktree…'));
    fireEvent.click(await screen.findByText('Cancel'));

    await waitFor(() => expect(screen.queryByText('Delete worktree?')).toBeNull());
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit)?.method === 'DELETE')).toBe(false);
  });

  it('deletes the worktree once confirmed', async () => {
    await renderExpanded();

    fireEvent.contextMenu(screen.getByText('parser-fix'));
    fireEvent.click(await screen.findByText('Delete worktree…'));
    worktrees = [];
    fireEvent.click(await screen.findByText('Delete'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/projects/p1/worktrees/wt-1', { method: 'DELETE' }),
    );
    await waitFor(() => expect(screen.queryByText('Delete worktree?')).toBeNull());
  });

  it('keeps the dialog open and reports why when the server refuses', async () => {
    await renderExpanded();
    fetchMock.mockImplementationOnce(async () => ({
      ok: false,
      json: async () => ({ error: 'Worktree has uncommitted changes' }),
    }) as unknown as Response);

    fireEvent.contextMenu(screen.getByText('parser-fix'));
    fireEvent.click(await screen.findByText('Delete worktree…'));
    fireEvent.click(await screen.findByText('Delete'));

    expect(await screen.findByText('Worktree has uncommitted changes')).toBeTruthy();
    expect(screen.getByText('Delete worktree?')).toBeTruthy();
  });

  // An attached worktree is the user's own directory; unregistering it must not
  // be described, or confirmed, as destroying anything.
  it('describes an attached worktree as a removal from Pilot Console only', async () => {
    worktrees = [attachedWorktree];
    await renderExpanded();

    fireEvent.contextMenu(screen.getByText('legacy'));
    fireEvent.click(await screen.findByText('Remove from Pilot Console…'));

    expect(await screen.findByText('Remove worktree?')).toBeTruthy();
    expect(screen.getByText(/directory on disk is left untouched/)).toBeTruthy();
  });
});
