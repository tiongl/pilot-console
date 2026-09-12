import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProjectTodoPanel from '@/components/project/ProjectTodoPanel';

const projectId = 'p1';

let todos: Array<Record<string, unknown>>;
let fetchMock: ReturnType<typeof vi.fn>;

function todo(id: string, text: string, extra: Record<string, unknown> = {}) {
  return { id, projectId, parentId: null, text, done: 0, position: 0, createdAt: null, ...extra };
}

beforeEach(() => {
  todos = [];
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'GET') {
      return { ok: true, json: async () => ({ todos }) } as unknown as Response;
    }
    return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('ProjectTodoPanel', () => {
  it('draws sub-items under their parent', async () => {
    todos = [todo('t1', 'Ship login'), todo('t2', 'Write tests', { parentId: 't1' })];
    render(<ProjectTodoPanel projectId={projectId} />);

    expect(await screen.findByTestId('todo-text-t2')).toBeTruthy();
  });

  /**
   * The Project Lead edits this same list through its own tools. A panel that
   * only loaded once showed a plan that silently drifted out of date.
   */
  it('picks up a change the lead made', async () => {
    todos = [todo('t1', 'Ship login')];
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<ProjectTodoPanel projectId={projectId} pollMs={1000} />);
    await screen.findByTestId('todo-text-t1');

    todos = [todo('t1', 'Ship login', { done: 1 }), todo('t2', 'Ship search')];
    await vi.advanceTimersByTimeAsync(1100);

    await waitFor(() => expect(screen.getByTestId('todo-text-t2')).toBeTruthy());
  });

  it('shows text the lead reworded', async () => {
    todos = [todo('t1', 'Ship login')];
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<ProjectTodoPanel projectId={projectId} pollMs={1000} />);
    await screen.findByTestId('todo-text-t1');

    todos = [todo('t1', 'Ship login with SSO')];
    await vi.advanceTimersByTimeAsync(1100);

    await waitFor(() =>
      expect((screen.getByTestId('todo-text-t1') as HTMLTextAreaElement).value).toBe(
        'Ship login with SSO',
      ),
    );
  });

  /**
   * The text boxes are uncontrolled and keyed on their text, so a poll landing
   * mid-edit would remount the box and throw away what the user had typed.
   */
  it('does not reload while the user is typing', async () => {
    todos = [todo('t1', 'Ship login')];
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<ProjectTodoPanel projectId={projectId} pollMs={1000} />);

    const box = (await screen.findByTestId('todo-text-t1')) as HTMLTextAreaElement;
    box.focus();
    fireEvent.change(box, { target: { value: 'Ship login with SSO' } });

    todos = [todo('t1', 'Something else entirely')];
    await vi.advanceTimersByTimeAsync(3100);

    // Re-queried, not the captured node: if the poll had landed, the box would
    // have been replaced and the stale reference would still read fine.
    expect((screen.getByTestId('todo-text-t1') as HTMLTextAreaElement).value).toBe(
      'Ship login with SSO',
    );
    expect(document.activeElement).toBe(screen.getByTestId('todo-text-t1'));
  });

  it('stops polling once it is unmounted', async () => {
    todos = [todo('t1', 'Ship login')];
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const view = render(<ProjectTodoPanel projectId={projectId} pollMs={1000} />);
    await screen.findByTestId('todo-text-t1');

    view.unmount();
    const before = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3100);

    expect(fetchMock.mock.calls.length).toBe(before);
  });

  // Clearing the box is a slip, not a request to store a blank row — and the
  // server rejects empty text, so saving it would just lose the item's label.
  it('restores the text when the box is cleared', async () => {
    todos = [todo('t1', 'Ship login')];
    render(<ProjectTodoPanel projectId={projectId} />);

    const box = (await screen.findByTestId('todo-text-t1')) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '   ' } });
    fireEvent.blur(box);

    expect(box.value).toBe('Ship login');
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit)?.method === 'PATCH')).toBe(
      false,
    );
  });

  it('saves an edit when the box loses focus', async () => {
    todos = [todo('t1', 'Ship login')];
    render(<ProjectTodoPanel projectId={projectId} />);

    const box = (await screen.findByTestId('todo-text-t1')) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'Ship login with SSO' } });
    fireEvent.blur(box);

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'PATCH');
      expect(JSON.parse(String((patch?.[1] as RequestInit).body))).toEqual({
        text: 'Ship login with SSO',
      });
    });
  });
});
