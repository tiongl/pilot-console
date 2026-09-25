import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { AgentServerMessage } from '@/types';

// Capture the hook options so tests can drive server → client messages, and
// expose the mocked `send` so we can assert client → server messages.
const hooked = vi.hoisted(() => ({
  onMessage: undefined as ((msg: AgentServerMessage) => void) | undefined,
  lastOptions: null as { onMessage?: (msg: AgentServerMessage) => void; forceNew?: boolean } | null,
  send: vi.fn(),
  reset: vi.fn(),
  switchTo: vi.fn(),
}));

vi.mock('@/hooks/useAgentSocket', () => ({
  useAgentSocket: (opts: { onMessage?: (msg: AgentServerMessage) => void; forceNew?: boolean }) => {
    hooked.onMessage = opts.onMessage;
    hooked.lastOptions = opts;
    return { state: 'open' as const, send: hooked.send, reset: hooked.reset, switchTo: hooked.switchTo };
  },
}));

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({ svg: '<svg viewBox="0 0 200 100" data-testid="agent-mermaid-svg"></svg>' })),
  },
}));

import AgentPane from '@/components/terminal/AgentPane';
import { writeTranscript } from '@/lib/transcript-cache';
import { readDraft as readDraftLib, writeDraft as writeDraftLib } from '@/lib/composer-draft';

function emit(msg: AgentServerMessage) {
  act(() => {
    hooked.onMessage?.(msg);
  });
}

describe('AgentPane', () => {
  beforeEach(() => {
    // The View filters persist to localStorage, so reset them or a test that
    // toggles a filter leaks that choice into every later test.
    localStorage.clear();
    hooked.send.mockClear();
    hooked.reset.mockClear();
    hooked.switchTo.mockClear();
    hooked.onMessage = undefined;
    hooked.lastOptions = null;
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            models: [
              { id: 'auto', name: 'Auto' },
              { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5' },
            ],
          }),
      }),
    ) as unknown as typeof fetch;
  });

  function renderPane() {
    return render(<AgentPane projectId="p1" active />);
  }

  it('applies the selected terminal theme colors and font to the pane', () => {
    const { container } = render(
      <AgentPane projectId="p1" active themeName="Dracula" fontFamily='"Fira Code", monospace' fontSize={16} />,
    );
    const root = container.firstChild as HTMLElement;
    // Dracula background is #282a36
    expect(root.style.backgroundColor).toBe('#282a36');
    expect(root.style.fontFamily).toContain('Fira Code');
  });

  it('renders replayed user and assistant messages', async () => {
    renderPane();
    emit({
      type: 'replay',
      events: [
        { kind: 'user', id: 'u1', ts: 1, content: 'Hello agent' },
        { kind: 'assistant', id: 'a1', ts: 2, content: 'Hi there' },
      ],
    });
    await waitFor(() => expect(screen.getByText('Hello agent')).toBeTruthy());
    expect(screen.getByText('Hi there')).toBeTruthy();
  });

  it('copies an assistant reply as markdown source and rendered text', async () => {
    const writeText = vi.fn((_text: string) => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    renderPane();
    emit({
      type: 'replay',
      events: [
        { kind: 'assistant', id: 'a1', ts: 2, content: '# Title\n\nBody text' },
      ],
    });

    const trigger = await screen.findByTestId('assistant-copy-button');
    fireEvent.click(trigger);
    const md = await screen.findByTestId('assistant-copy-markdown');
    fireEvent.click(md);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('# Title\n\nBody text'));

    fireEvent.click(await screen.findByTestId('assistant-copy-button'));
    const txt = await screen.findByTestId('assistant-copy-text');
    fireEvent.click(txt);
    await waitFor(() => {
      const copied = writeText.mock.calls.at(-1)?.[0] as string;
      expect(copied).toContain('Title');
      expect(copied).toContain('Body text');
      expect(copied).not.toContain('#');
    });
  });
  it('renders mermaid diagrams in assistant markdown', async () => {
    renderPane();
    emit({
      type: 'replay',
      events: [
        {
          kind: 'assistant',
          id: 'a1',
          ts: 1,
          content: '```mermaid\ngraph TD;A-->B;\n```',
        },
      ],
    });

    const frame = await screen.findByTestId('mermaid-diagram');
    expect(frame.querySelector('svg')).toBeTruthy();
  });

  it('renders rich markdown code blocks with copy controls and math', async () => {
    renderPane();
    emit({
      type: 'event',
      event: {
        kind: 'assistant',
        id: 'a-rich',
        ts: 1,
        content: '```typescript\nconst answer = 42;\n```\n\nInline math: $x^2$.',
      },
    });

    expect(await screen.findByText('typescript')).toBeTruthy();
    expect(screen.getByLabelText('Copy code')).toBeTruthy();
    expect(screen.getByText('answer')).toBeTruthy();
    expect(document.querySelector('.katex')).toBeTruthy();
  });

  it('hides an assistant entry that has no text', async () => {
    renderPane();
    emit({
      type: 'replay',
      events: [
        { kind: 'user', id: 'u1', ts: 1, content: 'Hello agent' },
        { kind: 'assistant', id: 'a1', ts: 2, content: '' },
      ],
    });
    await waitFor(() => expect(screen.getByText('Hello agent')).toBeTruthy());
    expect(screen.queryByText('Copilot')).toBeNull();
  });

  it('requests a brand-new agent session when the tab has no session id', () => {    renderPane();
    expect(hooked.lastOptions?.forceNew).toBe(true);
  });

  it('does not force a new session when resuming an existing tab session', () => {
    render(<AgentPane projectId="p1" active sessionId="sess-current" />);
    expect(hooked.lastOptions?.forceNew).toBe(false);
  });

  it('shows a hydrating indicator (not the new-session text) for an existing session before replay', () => {
    render(<AgentPane projectId="p1" active sessionId="sess-existing" />);
    expect(screen.getByTestId('agent-hydrating')).toBeTruthy();
    expect(screen.getByText('Loading conversation…')).toBeTruthy();
    expect(screen.queryByText('Start a conversation with the Copilot agent.')).toBeNull();
  });

  it('shows the new-session empty text for a genuinely new session (no sessionId)', () => {
    renderPane();
    expect(screen.getByText('Start a conversation with the Copilot agent.')).toBeTruthy();
    expect(screen.queryByTestId('agent-hydrating')).toBeNull();
  });

  it('paints the cached transcript optimistically and reconciles to the authoritative replay', async () => {
    writeTranscript('sess-cached', [{ kind: 'user', id: 'u1', ts: 1, content: 'cached message' }]);
    render(<AgentPane projectId="p1" active sessionId="sess-cached" />);
    // Cached content paints immediately, before any replay arrives.
    expect(screen.getByText('cached message')).toBeTruthy();
    expect(screen.queryByTestId('agent-hydrating')).toBeNull();

    emit({
      type: 'replay',
      events: [{ kind: 'assistant', id: 'a1', ts: 2, content: 'fresh reply' }],
    });
    await waitFor(() => expect(screen.getByText('fresh reply')).toBeTruthy());
    // The cached transcript is replaced wholesale — no leftover, no duplicate.
    expect(screen.queryByText('cached message')).toBeNull();
  });

  it('does not render a cached transcript that belongs to a different session', () => {
    writeTranscript('other-session', [{ kind: 'user', id: 'u1', ts: 1, content: 'other session message' }]);
    render(<AgentPane projectId="p1" active sessionId="sess-x" />);
    expect(screen.queryByText('other session message')).toBeNull();
    expect(screen.getByTestId('agent-hydrating')).toBeTruthy();
  });

  it('degrades gracefully when transcript-cache storage throws', () => {
    // A cache entry exists, but storage throws on read — the pane must not
    // crash and must fall back to hydrating instead of painting cached content.
    writeTranscript('sess-existing', [{ kind: 'user', id: 'u1', ts: 1, content: 'cached message' }]);
    const getSpy = vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    const setSpy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    try {
      render(<AgentPane projectId="p1" active sessionId="sess-existing" />);
      expect(screen.queryByText('cached message')).toBeNull();
      expect(screen.getByTestId('agent-hydrating')).toBeTruthy();
      expect(screen.queryByText('Start a conversation with the Copilot agent.')).toBeNull();
    } finally {
      getSpy.mockRestore();
      setSpy.mockRestore();
    }
  });

  it('renders a tool activity card with the tool name', async () => {
    renderPane();
    emit({
      type: 'event',
      event: {
        kind: 'tool',
        id: 't1',
        ts: Date.now(),
        toolCallId: 'c1',
        toolName: 'bash',
        status: 'running',
        progress: 'Launching command',
      },
    });
    await waitFor(() => expect(screen.getByText('bash')).toBeTruthy());
    // Collapsed header, expanded body, and the composer progress banner.
    expect(screen.getAllByText('Launching command')).toHaveLength(3);
    expect(screen.getByTestId('tool-progress-c1')).toHaveTextContent('Running for 0s');
  });

  it('keeps Stop available while a tool is running even if session status says idle', async () => {
    renderPane();
    emit({
      type: 'event',
      event: {
        kind: 'tool',
        id: 't1',
        ts: Date.now(),
        toolCallId: 'c1',
        toolName: 'apply_patch',
        status: 'running',
      },
    });
    fireEvent.click(await screen.findByTitle('Stop'));
    expect(hooked.send).toHaveBeenCalledWith({ type: 'cancel' });
  });

  it('sends a message when the composer submits', async () => {
    renderPane();
    const textarea = screen.getByPlaceholderText(/Message Copilot/i);
    fireEvent.change(textarea, { target: { value: 'do something' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(hooked.send).toHaveBeenCalledWith({ type: 'send', prompt: 'do something' }));
  });

  describe('optimistic user message', () => {
    function submitMessage(value: string) {
      const textarea = screen.getByPlaceholderText(/Message Copilot/i);
      fireEvent.change(textarea, { target: { value } });
      fireEvent.keyDown(textarea, { key: 'Enter' });
    }

    it('paints the user bubble immediately, before any server event', async () => {
      renderPane();
      submitMessage('optimistic hello');
      // No server `event` has been emitted yet — the bubble must already show.
      await waitFor(() => expect(screen.getByText('optimistic hello')).toBeTruthy());
      expect(hooked.send).toHaveBeenCalledWith({ type: 'send', prompt: 'optimistic hello' });
    });

    it('does not duplicate when the server echoes the matching user event', async () => {
      renderPane();
      submitMessage('optimistic hello');
      await waitFor(() => expect(screen.getByText('optimistic hello')).toBeTruthy());
      // The server persists and broadcasts the authoritative user event with its
      // own SDK-assigned id — this must replace the optimistic bubble, not add one.
      emit({ type: 'event', event: { kind: 'user', id: 'srv-1', ts: 99, content: 'optimistic hello' } });
      await waitFor(() => expect(screen.getAllByText('optimistic hello')).toHaveLength(1));
    });

    it('collapses the optimistic bubble on a full replay', async () => {
      renderPane();
      submitMessage('optimistic hello');
      await waitFor(() => expect(screen.getByText('optimistic hello')).toBeTruthy());
      // A reconnect/replay is authoritative: its copy wins with no dupe and no
      // orphaned optimistic bubble.
      emit({
        type: 'replay',
        events: [{ kind: 'user', id: 'srv-1', ts: 99, content: 'optimistic hello' }],
      });
      await waitFor(() => expect(screen.getAllByText('optimistic hello')).toHaveLength(1));
    });

    it('does not paint an optimistic bubble for a slash command', async () => {
      renderPane();
      submitMessage('/help');
      // Slash commands run through their own branch — no user bubble, no `send`.
      await waitFor(() =>
        expect(hooked.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'send' })),
      );
      expect(screen.queryByText('/help')).toBeNull();
    });

    it('does not paint an optimistic bubble when answering a pending question', () => {
      renderPane();
      emit({
        type: 'ask_user_request',
        requestId: 'q1',
        question: 'Which database?',
        options: ['SQLite', 'Postgres'],
        allowText: true,
      });
      const textarea = screen.getByPlaceholderText(/Click an option above/i);
      fireEvent.change(textarea, { target: { value: 'use DuckDB' } });
      fireEvent.keyDown(textarea, { key: 'Enter' });
      // The typed text routes to the question, not a normal send — so no
      // optimistic user bubble is painted for it.
      expect(hooked.send).toHaveBeenCalledWith({
        type: 'ask_user_response',
        requestId: 'q1',
        answer: 'use DuckDB',
      });
      expect(hooked.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'send' }));
      expect(screen.queryByText('use DuckDB')).toBeNull();
    });
  });

  describe('composer draft persistence', () => {
    it('restores a persisted draft on remount for the same session', () => {
      const { unmount } = render(<AgentPane projectId="p1" active sessionId="sess-draft" />);
      fireEvent.change(screen.getByPlaceholderText(/Message Copilot/i), {
        target: { value: 'unsent thoughts' },
      });
      unmount();
      // Simulate a refresh: a fresh mount for the same session restores the draft.
      render(<AgentPane projectId="p1" active sessionId="sess-draft" />);
      expect((screen.getByPlaceholderText(/Message Copilot/i) as HTMLTextAreaElement).value).toBe(
        'unsent thoughts',
      );
    });

    it('clears the persisted draft after the message is sent', async () => {
      const first = render(<AgentPane projectId="p1" active sessionId="sess-draft" />);
      const textarea = screen.getByPlaceholderText(/Message Copilot/i);
      fireEvent.change(textarea, { target: { value: 'send me' } });
      fireEvent.keyDown(textarea, { key: 'Enter' });
      await waitFor(() =>
        expect(hooked.send).toHaveBeenCalledWith({ type: 'send', prompt: 'send me' }),
      );
      first.unmount();
      render(<AgentPane projectId="p1" active sessionId="sess-draft" />);
      expect((screen.getByPlaceholderText(/Message Copilot/i) as HTMLTextAreaElement).value).toBe('');
    });

    it('does not surface another session\'s draft', () => {
      const first = render(<AgentPane projectId="p1" active sessionId="sess-a" />);
      fireEvent.change(screen.getByPlaceholderText(/Message Copilot/i), {
        target: { value: 'draft for A' },
      });
      first.unmount();
      render(<AgentPane projectId="p1" active sessionId="sess-b" />);
      expect((screen.getByPlaceholderText(/Message Copilot/i) as HTMLTextAreaElement).value).toBe('');
    });

    it('hands off drafts on an in-place session switch without destroying them', () => {
      // Session B already has a saved draft from an earlier visit.
      writeDraftLib('sess-b', 'draft for B');
      const { rerender } = render(<AgentPane projectId="p1" active sessionId="sess-a" />);
      const textarea = () => screen.getByPlaceholderText(/Message Copilot/i) as HTMLTextAreaElement;
      // Type into A; it is mirrored under A's key.
      fireEvent.change(textarea(), { target: { value: 'draft for A' } });
      expect(readDraftLib('sess-a')).toBe('draft for A');
      // In-place switch (same mount, no remount) — the sessionId prop changes,
      // exactly as ProjectChatPage does on /resume.
      rerender(<AgentPane projectId="p1" active sessionId="sess-b" />);
      // B's saved draft is restored (not clobbered by A's stale composer value)…
      expect(textarea().value).toBe('draft for B');
      // …and A's draft is preserved under A's own key, never overwritten with B.
      expect(readDraftLib('sess-a')).toBe('draft for A');
      expect(readDraftLib('sess-b')).toBe('draft for B');
    });

    it('keeps a typed first message when a brand-new session gains its id', () => {
      // A brand-new session mounts without an id; the id arrives in place.
      const { rerender } = render(<AgentPane projectId="p1" active />);
      const textarea = () => screen.getByPlaceholderText(/Message Copilot/i) as HTMLTextAreaElement;
      fireEvent.change(textarea(), { target: { value: 'first message' } });
      rerender(<AgentPane projectId="p1" active sessionId="sess-new" />);
      // The composer text belongs to this session — it must not be wiped, and it
      // is now persisted under the freshly assigned id.
      expect(textarea().value).toBe('first message');
      expect(readDraftLib('sess-new')).toBe('first message');
    });
  });

  it('surfaces a permission prompt and responds on Allow', async () => {
    renderPane();
    emit({
      type: 'permission_request',
      requestId: 'r1',
      title: 'Run shell command',
      detail: 'ls -la',
      canSession: true,
    });
    await waitFor(() => expect(screen.getByText('Run shell command')).toBeTruthy());
    fireEvent.click(screen.getByText('Allow'));
    expect(hooked.send).toHaveBeenCalledWith({
      type: 'permission_response',
      requestId: 'r1',
      decision: 'approve-once',
    });
  });

  it('does not duplicate a permission prompt when reconnect state is replayed', async () => {
    renderPane();
    const request = {
      type: 'permission_request',
      requestId: 'r1',
      title: 'Run shell command',
      detail: 'ls -la',
      canSession: true,
    } as const;
    emit(request);
    emit(request);
    await waitFor(() => expect(screen.getAllByText('Run shell command')).toHaveLength(1));
  });

  it('offers "Allow everything" on a prompt and stops asking afterwards', async () => {
    renderPane();
    emit({
      type: 'permission_request',
      requestId: 'r1',
      title: 'Run shell command',
      detail: 'ls -la',
      canSession: false,
    });
    await waitFor(() => expect(screen.getByText('Run shell command')).toBeTruthy());
    fireEvent.click(screen.getByTestId('permission-allow-everything'));
    expect(hooked.send).toHaveBeenCalledWith({
      type: 'permission_response',
      requestId: 'r1',
      decision: 'approve-all',
    });
    await waitFor(() => expect(screen.queryByText('Run shell command')).toBeNull());
    expect(screen.getByTestId('agent-allow-all-toggle').textContent).toContain('on');
  });

  it('toggles allow-all from the bottom bar and reflects the server state', async () => {
    renderPane();
    const toggle = screen.getByTestId('agent-allow-all-toggle');
    expect(toggle.textContent).toContain('off');
    fireEvent.click(toggle);
    expect(hooked.send).toHaveBeenCalledWith({ type: 'set_allow_all', enabled: true });
    await waitFor(() => expect(screen.getByTestId('agent-allow-all-toggle').textContent).toContain('on'));

    emit({ type: 'allow_all', enabled: false });
    await waitFor(() => expect(screen.getByTestId('agent-allow-all-toggle').textContent).toContain('off'));
  });

  it('requires a second Escape to stop a running turn', async () => {
    renderPane();
    emit({ type: 'status', status: 'busy' });

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.getByTestId('agent-stop-confirm')).toBeTruthy());
    expect(hooked.send).not.toHaveBeenCalledWith({ type: 'cancel' });

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(hooked.send).toHaveBeenCalledWith({ type: 'cancel' }));
    expect(screen.queryByTestId('agent-stop-confirm')).toBeNull();
  });

  it('ignores Escape when the agent is idle', async () => {
    renderPane();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('agent-stop-confirm')).toBeNull();
    expect(hooked.send).not.toHaveBeenCalledWith({ type: 'cancel' });
  });

  it('lets the user keep the turn running after arming the stop', async () => {
    renderPane();
    emit({ type: 'status', status: 'busy' });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.getByTestId('agent-stop-confirm')).toBeTruthy());
    fireEvent.click(screen.getByText('keep running'));
    await waitFor(() => expect(screen.queryByTestId('agent-stop-confirm')).toBeNull());
    expect(hooked.send).not.toHaveBeenCalledWith({ type: 'cancel' });
  });

  it('cycles the agent mode via the bottom indicator and notifies the server', async () => {    renderPane();
    // Ready defaults to interactive; clicking the indicator cycles to plan.
    const indicator = screen.getByTestId('agent-mode-indicator');
    expect(indicator.textContent).toContain('Interactive');
    fireEvent.click(indicator);
    await waitFor(() => expect(hooked.send).toHaveBeenCalledWith({ type: 'set_mode', mode: 'plan' }));
  });

  it('cycles the agent mode with Shift+Tab', async () => {
    renderPane();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    await waitFor(() => expect(hooked.send).toHaveBeenCalledWith({ type: 'set_mode', mode: 'plan' }));
  });

  it('reflects a server-driven mode change', async () => {
    renderPane();
    emit({ type: 'mode', mode: 'autopilot' });
    await waitFor(() => expect(screen.getByTestId('agent-mode-indicator').textContent).toContain('Auto-pilot'));
  });

  it('surfaces an exit-plan request and responds with the chosen action', async () => {
    renderPane();
    emit({
      type: 'exit_plan_request',
      requestId: 'p1',
      summary: 'Implement the feature',
      actions: ['interactive', 'autopilot', 'exit_only'],
      recommended: 'autopilot',
    });
    await waitFor(() => expect(screen.getByText('Plan ready')).toBeTruthy());
    fireEvent.click(screen.getByText('Proceed in auto-pilot'));
    expect(hooked.send).toHaveBeenCalledWith({
      type: 'exit_plan_response',
      requestId: 'p1',
      action: 'autopilot',
    });
  });

  it('shows a slash-command menu when typing "/"', async () => {
    renderPane();
    const textarea = screen.getByPlaceholderText(/Message Copilot/i);
    fireEvent.change(textarea, { target: { value: '/' } });
    await waitFor(() => expect(screen.getByTestId('slash-menu')).toBeTruthy());
    expect(screen.getByTestId('slash-item-model')).toBeTruthy();
    expect(screen.getByTestId('slash-item-clear')).toBeTruthy();
    // Filters as the user narrows the query.
    fireEvent.change(textarea, { target: { value: '/mo' } });
    await waitFor(() => expect(screen.getByTestId('slash-item-model')).toBeTruthy());
    expect(screen.queryByTestId('slash-item-clear')).toBeNull();
  });

  it('runs /mode to change the agent mode', async () => {
    renderPane();
    const textarea = screen.getByPlaceholderText(/Message Copilot/i);
    fireEvent.change(textarea, { target: { value: '/mode autopilot' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(hooked.send).toHaveBeenCalledWith({ type: 'set_mode', mode: 'autopilot' }));
  });

  it('runs /stop to cancel the current turn', async () => {
    renderPane();
    const textarea = screen.getByPlaceholderText(/Message Copilot/i);
    // Selecting a no-arg command from the menu executes it immediately.
    fireEvent.change(textarea, { target: { value: '/stop' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(hooked.send).toHaveBeenCalledWith({ type: 'cancel' }));
  });

  it('sends cancel from the stop button while the agent is busy', async () => {
    renderPane();
    emit({ type: 'status', status: 'busy' });
    fireEvent.click(await screen.findByTitle('Stop'));
    expect(hooked.send).toHaveBeenCalledWith({ type: 'cancel' });
  });

  it('still lets the user send a follow-up while the agent is busy', async () => {
    renderPane();
    emit({ type: 'status', status: 'busy' });

    const textarea = screen.getByPlaceholderText(/Message Copilot/i);
    fireEvent.change(textarea, { target: { value: 'what about the other topic?' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(hooked.send).toHaveBeenCalledWith({ type: 'send', prompt: 'what about the other topic?' });
    // Stop stays available alongside send, so a busy turn is never a dead end.
    expect(screen.getByTitle('Stop')).toBeTruthy();
  });

  it('lists queued follow-ups and can drop one', async () => {
    renderPane();
    emit({ type: 'status', status: 'busy' });
    emit({ type: 'queued', prompts: ['first follow-up', 'second follow-up'] });

    const queue = await screen.findByTestId('agent-queued');
    expect(queue.textContent).toContain('2 follow-ups queued');
    expect(screen.getByText('first follow-up')).toBeTruthy();

    fireEvent.click(screen.getAllByTitle('Remove this queued follow-up')[1]);
    expect(hooked.send).toHaveBeenCalledWith({ type: 'dequeue', index: 1 });
  });

  it('hides the queue once the server reports it empty', async () => {
    renderPane();
    emit({ type: 'status', status: 'busy' });
    emit({ type: 'queued', prompts: ['only one'] });
    expect(await screen.findByTestId('agent-queued')).toBeTruthy();

    emit({ type: 'queued', prompts: [] });
    await waitFor(() => expect(screen.queryByTestId('agent-queued')).toBeNull());
  });

  it('runs /clear to start a new session', async () => {
    renderPane();
    const textarea = screen.getByPlaceholderText(/Message Copilot/i);
    fireEvent.change(textarea, { target: { value: '/clear' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(hooked.reset).toHaveBeenCalled());
  });

  it('does not send a slash command as a chat prompt', async () => {
    renderPane();
    const textarea = screen.getByPlaceholderText(/Message Copilot/i);
    fireEvent.change(textarea, { target: { value: '/help' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(screen.getByText(/Slash commands:/i)).toBeTruthy());
    expect(hooked.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'send' }));
  });

  it('merges the dynamic (plugin/skill-aware) command catalog into the menu', async () => {
    renderPane();
    emit({
      type: 'commands',
      commands: [
        { name: 'review', kind: 'builtin', description: 'Run code review' },
        { name: 'ship-it', kind: 'skill', description: 'Plugin command' },
      ],
    });
    const textarea = screen.getByPlaceholderText(/Message Copilot/i);
    fireEvent.change(textarea, { target: { value: '/rev' } });
    await waitFor(() => expect(screen.getByTestId('slash-item-review')).toBeTruthy());
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() =>
      expect(hooked.send).toHaveBeenCalledWith({ type: 'run_command', name: 'review', input: undefined }),
    );
  });

  it('routes an unknown/plugin command through run_command with args', async () => {
    renderPane();
    const textarea = screen.getByPlaceholderText(/Message Copilot/i);
    fireEvent.change(textarea, { target: { value: '/compact focus on auth' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() =>
      expect(hooked.send).toHaveBeenCalledWith({
        type: 'run_command',
        name: 'compact',
        input: 'focus on auth',
      }),
    );
  });

  it('shows a subcommand picker and invokes the chosen subcommand', async () => {
    renderPane();
    emit({
      type: 'command_subcommands',
      command: 'session',
      title: 'Pick a session action',
      options: [
        { name: 'list', description: 'List sessions' },
        { name: 'rename', description: 'Rename session' },
      ],
    });
    await waitFor(() => expect(screen.getByTestId('subcommand-menu')).toBeTruthy());
    fireEvent.mouseDown(screen.getByTestId('subcommand-item-rename'));
    expect(hooked.send).toHaveBeenCalledWith({ type: 'run_command', name: 'session', input: 'rename' });
  });

  it('opens a submenu (not a bare invoke) for a command that advertises choices', async () => {
    renderPane();
    emit({
      type: 'commands',
      commands: [
        {
          name: 'session',
          kind: 'builtin',
          description: 'View and manage sessions',
          argHint: '[info|rename]',
          argChoices: [
            { name: 'info', description: 'Show session details' },
            { name: 'rename', description: 'Rename the current session' },
          ],
        },
      ],
    });
    const textarea = screen.getByPlaceholderText(/Message Copilot/i);
    fireEvent.change(textarea, { target: { value: '/session' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    // Instead of invoking bare, it shows the choices as a picker.
    await waitFor(() => expect(screen.getByTestId('subcommand-menu')).toBeTruthy());
    expect(screen.getByTestId('subcommand-item-info')).toBeTruthy();
    expect(hooked.send).not.toHaveBeenCalledWith({ type: 'run_command', name: 'session', input: undefined });
    fireEvent.mouseDown(screen.getByTestId('subcommand-item-info'));
    expect(hooked.send).toHaveBeenCalledWith({ type: 'run_command', name: 'session', input: 'info' });
  });

  it('/resume lists sessions and switches to the chosen one', async () => {
    render(<AgentPane projectId="p1" active sessionId="sess-current" />);
    const textarea = screen.getByPlaceholderText(/Message Copilot/i);
    fireEvent.change(textarea, { target: { value: '/resume' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(hooked.send).toHaveBeenCalledWith({ type: 'list_sessions' });
    emit({
      type: 'sessions',
      sessions: [
        { id: 'sess-current', summary: 'Current', startTime: '', modifiedTime: '2026-01-02T00:00:00Z', isRemote: false, current: true },
        { id: 'sess-other', summary: 'Older session', startTime: '', modifiedTime: '2026-01-01T00:00:00Z', isRemote: false, current: false },
      ],
    });
    await waitFor(() => expect(screen.getByTestId('session-switcher')).toBeTruthy());
    fireEvent.click(screen.getByTestId('session-item-sess-other'));
    expect(hooked.switchTo).toHaveBeenCalledWith('sess-other');
  });

  it('/diff requests and renders the working-tree diff', async () => {
    renderPane();
    const textarea = screen.getByPlaceholderText(/Message Copilot/i);
    fireEvent.change(textarea, { target: { value: '/diff' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(hooked.send).toHaveBeenCalledWith({ type: 'get_diff' });
    emit({ type: 'diff', content: 'diff --git a/x b/x\n+hello', truncated: false });
    await waitFor(() => expect(screen.getByTestId('diff-panel')).toBeTruthy());
    expect(screen.getByText(/diff --git a\/x/)).toBeTruthy();
  });

  it('hides tool calls when the "Tool calls" view filter is unchecked', async () => {
    renderPane();
    emit({
      type: 'replay',
      events: [
        { kind: 'assistant', id: 'a1', ts: 1, content: 'Working on it' },
        { kind: 'tool', id: 't1', ts: 2, toolCallId: 'c1', toolName: 'bash', status: 'running' },
      ],
    });
    await waitFor(() => expect(screen.getByText('bash')).toBeTruthy());

    // Open the View menu and set "Tool calls" to Badge.
    fireEvent.click(screen.getByTitle('Show/hide output types'));
    const toolBadge = await screen.findByTestId('filter-tool-badge');
    fireEvent.click(toolBadge);

    // The expanded tool card is gone; only a compact badge remains.
    await waitFor(() => expect(screen.queryByTestId('tool-progress-c1')).toBeNull());
    expect(screen.getByTestId('tool-badge-c1')).toBeTruthy();
    // The assistant message stays visible.
    expect(screen.getByText('Working on it')).toBeTruthy();
  });

  it('collapses hidden tool calls into mini badges that name the tool on hover', async () => {
    renderPane();
    emit({
      type: 'replay',
      events: [
        { kind: 'tool', id: 't1', ts: 1, toolCallId: 'c1', toolName: 'bash', status: 'success', output: 'ok' },
        { kind: 'tool', id: 't2', ts: 2, toolCallId: 'c2', toolName: 'view', status: 'running' },
      ],
    });
    await waitFor(() => expect(screen.getByText('bash')).toBeTruthy());

    fireEvent.click(screen.getByTitle('Show/hide output types'));
    fireEvent.click(await screen.findByTestId('filter-tool-badge'));

    // Both calls collapse into a single strip of badges, in transcript order.
    const strip = await screen.findByTestId('tool-badges');
    expect(strip.children).toHaveLength(2);
    expect(screen.getByTestId('tool-badge-c1')).toHaveAttribute('title', 'bash\nClick for details');
    expect(screen.getByTestId('tool-badge-c2')).toHaveAttribute('title', 'view — running…\nClick for details');
    // The transcript is not treated as empty just because tools are hidden.
    expect(screen.queryByText(/All output is hidden/)).toBeNull();
  });

  it('labels badges with the tool name and duration, keeping call detail on hover', async () => {
    renderPane();
    emit({
      type: 'replay',
      events: [
        {
          kind: 'tool',
          id: 't1',
          ts: 1,
          toolCallId: 'c1',
          toolName: 'powershell',
          status: 'success',
          output: 'ok',
          durationMs: 2_500,
          args: { command: 'npm run build', description: 'Build the project' },
        },
      ],
    });
    await waitFor(() => expect(screen.getByText('powershell')).toBeTruthy());

    fireEvent.click(screen.getByTitle('Show/hide output types'));
    fireEvent.click(await screen.findByTestId('filter-tool-badge'));

    const badge = await screen.findByTestId('tool-badge-c1');
    expect(badge.textContent).toContain('powershell');
    expect(badge.textContent).not.toContain('Build the project');
    // Durations render in whole minutes/seconds everywhere: 2.5s rounds to 3s.
    expect(badge.textContent).toContain('3s');
    // Shell tools are indistinguishable by name alone, so a short command
    // prefix rides along on the badge face.
    expect(badge.textContent).toContain('npm run bu…');
    // The specific call detail lives in the hover tooltip, not the badge face.
    expect(badge).toHaveAttribute('title', 'powershell — Build the project\nClick for details');
  });

  it('opens a tool badge in a detail dialog when clicked', async () => {
    renderPane();
    emit({
      type: 'replay',
      events: [
        {
          kind: 'tool',
          id: 't1',
          ts: 1,
          toolCallId: 'c1',
          toolName: 'powershell',
          status: 'success',
          output: 'build succeeded',
          durationMs: 1_200,
          args: { command: 'npm run build', description: 'Build the project' },
        },
      ],
    });
    await waitFor(() => expect(screen.getByText('powershell')).toBeTruthy());

    fireEvent.click(screen.getByTitle('Show/hide output types'));
    fireEvent.click(await screen.findByTestId('filter-tool-badge'));
    expect(screen.queryByTestId('tool-detail-dialog')).toBeNull();

    fireEvent.click(await screen.findByTestId('tool-badge-c1'));

    const dialog = await screen.findByTestId('tool-detail-dialog');
    expect(dialog.textContent).toContain('Build the project');
    expect(dialog.textContent).toContain('npm run build');
    expect(await screen.findByTestId('tool-detail-output')).toHaveTextContent('build succeeded');
  });

  it('hides only the tool result body when the "Tool output" sub-filter is unchecked', async () => {
    renderPane();
    emit({
      type: 'replay',
      events: [
        { kind: 'tool', id: 't1', ts: 1, toolCallId: 'c1', toolName: 'bash', status: 'success', output: 'secret out' },
      ],
    });
    await waitFor(() => expect(screen.getByText('bash')).toBeTruthy());
    // Completed tool cards start collapsed — expand to reveal the output.
    fireEvent.click(screen.getByText('bash'));
    expect(screen.getByText('secret out')).toBeTruthy();

    fireEvent.click(screen.getByTitle('Show/hide output types'));
    fireEvent.click(await screen.findByTestId('filter-tool-output'));

    await waitFor(() => expect(screen.queryByText('secret out')).toBeNull());
    // The call itself is still listed.
    expect(screen.getByText('bash')).toBeTruthy();
    expect(screen.getByTestId('tool-output-hidden-c1')).toBeTruthy();
  });

  it('disables the "Tool output" sub-filter while tool calls are not shown in full', async () => {
    renderPane();
    fireEvent.click(screen.getByTitle('Show/hide output types'));
    const outputToggle = await screen.findByTestId('filter-tool-output');
    expect(outputToggle).not.toBeDisabled();

    // Badge mode: the tool card (and its body) is collapsed, so the sub-filter
    // has nothing to act on and is disabled.
    fireEvent.click(screen.getByTestId('filter-tool-badge'));

    await waitFor(() => expect(screen.getByTestId('filter-tool-output')).toBeDisabled());
    expect(screen.getByTestId('filter-tool-output')).not.toBeChecked();

    // Hide mode keeps it disabled too.
    fireEvent.click(screen.getByTestId('filter-tool-hide'));
    expect(screen.getByTestId('filter-tool-output')).toBeDisabled();

    // Back to Show re-enables it.
    fireEvent.click(screen.getByTestId('filter-tool-show'));
    await waitFor(() => expect(screen.getByTestId('filter-tool-output')).not.toBeDisabled());
  });

  it('does not render system messages', async () => {
    renderPane();
    emit({
      type: 'event',
      event: { kind: 'system', id: 's1', ts: 1, content: 'You are a helpful assistant.' },
    });
    await waitFor(() => expect(screen.queryByText('You are a helpful assistant.')).toBeNull());
    expect(screen.queryByText('System message')).toBeNull();
  });

  it('shares the session read-only from the Share panel', async () => {
    renderPane();
    fireEvent.click(screen.getByTestId('agent-share-button'));
    fireEvent.click(await screen.findByTestId('agent-share-export'));
    await waitFor(() =>
      expect(hooked.send).toHaveBeenCalledWith({ type: 'share_session', mode: 'export' }),
    );
  });

  it('shares the session with steering enabled', async () => {
    renderPane();
    fireEvent.click(screen.getByTestId('agent-share-button'));
    fireEvent.click(await screen.findByTestId('agent-share-on'));
    await waitFor(() =>
      expect(hooked.send).toHaveBeenCalledWith({ type: 'share_session', mode: 'on' }),
    );
  });

  it('reflects a share_status with a URL and stops sharing on demand', async () => {
    renderPane();
    emit({
      type: 'share_status',
      status: {
        mode: 'export',
        url: 'https://github.com/tiongl/pilot-console/tasks/abc-123',
        steerable: false,
      },
    });
    await waitFor(() => expect(screen.getByText('Shared')).toBeTruthy());

    fireEvent.click(screen.getByTestId('agent-share-button'));
    expect(
      await screen.findByText('https://github.com/tiongl/pilot-console/tasks/abc-123'),
    ).toBeTruthy();

    fireEvent.click(screen.getByTestId('agent-share-off'));
    await waitFor(() =>
      expect(hooked.send).toHaveBeenCalledWith({ type: 'share_session', mode: 'off' }),
    );
  });

  it('shares the session via the /share slash command', async () => {
    renderPane();
    const textarea = screen.getByPlaceholderText(/Message Copilot/i);
    fireEvent.change(textarea, { target: { value: '/share on' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() =>
      expect(hooked.send).toHaveBeenCalledWith({ type: 'share_session', mode: 'on' }),
    );
  });

  it('does not render empty assistant bubbles (tool-only turns)', async () => {
    renderPane();
    emit({
      type: 'replay',
      events: [
        { kind: 'user', id: 'u1', ts: 1, content: 'Run the tests' },
        // Assistant message that ended up containing only tool calls → empty text.
        { kind: 'assistant', id: 'a1', ts: 2, content: '' },
        { kind: 'tool', id: 't1', ts: 3, toolCallId: 'c1', toolName: 'bash', status: 'success' },
        { kind: 'assistant', id: 'a2', ts: 4, content: 'All tests passed.' },
      ],
    });
    await waitFor(() => expect(screen.getByText('All tests passed.')).toBeTruthy());
    // No stray "…" placeholder bubble from the empty assistant entry.
    expect(screen.queryByText('…')).toBeNull();
    // The non-empty assistant message and the tool card still render.
    expect(screen.getByText('bash')).toBeTruthy();
  });

  it('windows a long transcript and reveals earlier items on demand', async () => {
    renderPane();
    const events = Array.from({ length: 900 }, (_, i) => ({
      kind: 'user' as const,
      id: `u${i}`,
      ts: i,
      content: `message ${i}`,
    }));
    emit({ type: 'replay', events });
    // The most recent items render; the oldest are windowed out initially.
    await waitFor(() => expect(screen.getByText('message 899')).toBeTruthy());
    expect(screen.queryByText('message 0')).toBeNull();
    // A "show earlier" control reveals the next window.
    fireEvent.click(screen.getByText(/earlier of \d+ hidden/i));
    await waitFor(() => expect(screen.getByText('message 100')).toBeTruthy());
  });


  it('pulls older transcript slices from the server when the local window runs out', async () => {
    renderPane();
    const events = Array.from({ length: 5 }, (_, i) => ({
      kind: 'user' as const,
      id: `u${i}`,
      ts: i,
      content: `message ${i}`,
    }));
    // A short tail plus `hasMore`: everything local is already on screen, so
    // the only way to see more is to ask the server.
    emit({ type: 'replay', events, hasMore: true });
    await waitFor(() => expect(screen.getByText('message 4')).toBeTruthy());

    hooked.send.mockClear();
    fireEvent.click(screen.getByTestId('agent-fetch-earlier'));
    expect(hooked.send).toHaveBeenCalledWith({ type: 'fetch_earlier', beforeId: 'u0' });

    emit({
      type: 'earlier',
      events: [{ kind: 'user' as const, id: 'old1', ts: -1, content: 'ancient message' }],
      hasMore: false,
    });
    // The fetched slice is rendered immediately, not hidden behind another click.
    await waitFor(() => expect(screen.getByText('ancient message')).toBeTruthy());
    expect(screen.queryByTestId('agent-fetch-earlier')).toBeNull();
  });

  it('does not offer a server fetch when the whole transcript is already loaded', async () => {
    renderPane();
    emit({
      type: 'replay',
      events: [{ kind: 'user' as const, id: 'u0', ts: 0, content: 'only message' }],
      hasMore: false,
    });
    await waitFor(() => expect(screen.getByText('only message')).toBeTruthy());
    expect(screen.queryByTestId('agent-fetch-earlier')).toBeNull();
  });

  it('appends streamed tool output without repeating what is already shown', async () => {
    renderPane();
    emit({
      type: 'replay',
      events: [
        { kind: 'tool' as const, id: 'tool:c1', ts: 0, toolCallId: 'c1', toolName: 'bash', status: 'running' as const, output: '' },
      ],
      hasMore: false,
    });
    emit({ type: 'tool_delta', id: 'tool:c1', delta: 'line 1' });
    emit({ type: 'tool_delta', id: 'tool:c1', delta: '\nline 2' });

    await waitFor(() => expect(screen.getByText(/line 1\s+line 2/)).toBeTruthy());
    // The first line must appear once, not once per streamed frame.
    expect(screen.getAllByText(/line 1/)).toHaveLength(1);
  });

  it('replaces tool output when a tool rewrites rather than extends it', async () => {
    renderPane();
    emit({
      type: 'replay',
      events: [
        { kind: 'tool' as const, id: 'tool:c1', ts: 0, toolCallId: 'c1', toolName: 'bash', status: 'running' as const, output: '50% done' },
      ],
      hasMore: false,
    });
    emit({ type: 'tool_output', id: 'tool:c1', output: 'done' });

    await waitFor(() => expect(screen.getByText('done')).toBeTruthy());
    expect(screen.queryByText(/50%/)).toBeNull();
  });

  it('shows the token/credit usage badge in the header', async () => {    renderPane();
    emit({
      type: 'usage',
      usage: {
        inputTokens: 12_500,
        outputTokens: 2_500,
        cachedTokens: 0,
        reasoningTokens: 0,
        requests: 3,
        premiumRequests: 3,
        nanoAiu: 4_200_000_000,
      },
    });

    const badge = await screen.findByTestId('agent-usage-button');
    // 15,000 total tokens, and the premium-request multiplier.
    expect(badge.textContent).toContain('15.0k');
    expect(badge.textContent).toContain('3.00×');

    fireEvent.click(badge);
    const panel = await screen.findByTestId('agent-usage-panel');
    expect(panel.textContent).toContain('Model calls');
    expect(panel.textContent).toContain('4.20');
  });

  it('offers a jump-to-bottom control once the user scrolls up', async () => {
    const { container } = renderPane();
    emit({
      type: 'replay',
      events: [{ kind: 'assistant', id: 'a1', ts: 1, content: 'First reply' }],
    });
    await waitFor(() => expect(screen.getByText('First reply')).toBeTruthy());

    // A replay always lands at the bottom, so the affordance stays hidden.
    expect(screen.queryByTestId('agent-jump-to-bottom')).toBeNull();

    const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 2_000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 });
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);

    const jump = await screen.findByTestId('agent-jump-to-bottom');
    fireEvent.click(jump);
    expect(scroller.scrollTop).toBe(2_000);
    await waitFor(() => expect(screen.queryByTestId('agent-jump-to-bottom')).toBeNull());
  });

  /**
   * Following the bottom cannot rely on React commits alone. Markdown, diagrams
   * and images settle afterwards, and that late growth fires no scroll event —
   * so the view silently drifts up while the pane still thinks it is pinned.
   */
  describe('auto-follow', () => {
    /** Give the pane a real geometry, since jsdom lays nothing out. */
    const measure = (scroller: HTMLElement, scrollHeight: number, clientHeight = 400) => {
      Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: scrollHeight });
      Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: clientHeight });
    };

    const settled = async (scroller: HTMLElement) => {
      // Content the pane did not render itself, e.g. a diagram finishing late.
      scroller.appendChild(document.createElement('div'));
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    };

    it('re-pins when content grows after the render', async () => {
      const { container } = renderPane();
      emit({ type: 'replay', events: [{ kind: 'assistant', id: 'a1', ts: 1, content: 'Reply' }] });
      await waitFor(() => expect(screen.getByText('Reply')).toBeTruthy());

      const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;
      measure(scroller, 2_000);
      // The growth itself moved us off the bottom; no scroll event was fired.
      scroller.scrollTop = 0;
      await settled(scroller);

      expect(scroller.scrollTop).toBe(2_000);
    });

    it('leaves the scroll alone once the user has scrolled away', async () => {
      const { container } = renderPane();
      emit({ type: 'replay', events: [{ kind: 'assistant', id: 'a1', ts: 1, content: 'Reply' }] });
      await waitFor(() => expect(screen.getByText('Reply')).toBeTruthy());

      const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;
      measure(scroller, 2_000);
      scroller.scrollTop = 0;
      fireEvent.scroll(scroller);
      await screen.findByTestId('agent-jump-to-bottom');

      await settled(scroller);
      expect(scroller.scrollTop).toBe(0);
    });

    it('keeps following from a hair above the bottom', async () => {
      const { container } = renderPane();
      emit({ type: 'replay', events: [{ kind: 'assistant', id: 'a1', ts: 1, content: 'Reply' }] });
      await waitFor(() => expect(screen.getByText('Reply')).toBeTruthy());

      const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;
      measure(scroller, 2_000);
      // 50px short of the bottom: a nudge of the wheel, not a decision to read back.
      scroller.scrollTop = 1_550;
      fireEvent.scroll(scroller);

      expect(screen.queryByTestId('agent-jump-to-bottom')).toBeNull();
      await settled(scroller);
      expect(scroller.scrollTop).toBe(2_000);
    });

    it('says it is following while the agent writes', async () => {
      renderPane();
      expect(screen.queryByTestId('agent-following')).toBeNull();

      emit({ type: 'status', status: 'busy' });
      expect(await screen.findByTestId('agent-following')).toBeTruthy();

      emit({ type: 'status', status: 'idle' });
      await waitFor(() => expect(screen.queryByTestId('agent-following')).toBeNull());
    });

    it('calls out new messages rather than a plain jump while busy', async () => {
      const { container } = renderPane();
      emit({ type: 'status', status: 'busy' });
      emit({ type: 'replay', events: [{ kind: 'assistant', id: 'a1', ts: 1, content: 'Reply' }] });
      await waitFor(() => expect(screen.getByText('Reply')).toBeTruthy());

      const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;
      measure(scroller, 2_000);
      scroller.scrollTop = 0;
      fireEvent.scroll(scroller);

      const jump = await screen.findByTestId('agent-jump-to-bottom');
      expect(jump.textContent).toContain('New messages');
      expect(screen.queryByTestId('agent-following')).toBeNull();
    });
  });

  it('searches the conversation and reports the match count', async () => {
    renderPane();
    emit({
      type: 'replay',
      events: [
        { kind: 'user', id: 'u1', ts: 1, content: 'please fix the parser' },
        { kind: 'assistant', id: 'a1', ts: 2, content: 'The parser is fixed' },
        { kind: 'assistant', id: 'a2', ts: 3, content: 'Anything else?' },
      ],
    });
    await waitFor(() => expect(screen.getByText('Anything else?')).toBeTruthy());

    fireEvent.click(screen.getByTestId('agent-search-toggle'));
    fireEvent.change(await screen.findByTestId('agent-search-input'), { target: { value: 'parser' } });

    await waitFor(() => expect(screen.getByTestId('agent-search-count').textContent).toBe('1 of 2'));
    fireEvent.click(screen.getByTestId('agent-search-next'));
    expect(screen.getByTestId('agent-search-count').textContent).toBe('2 of 2');

    fireEvent.change(screen.getByTestId('agent-search-input'), { target: { value: 'nothing here' } });
    await waitFor(() => expect(screen.getByTestId('agent-search-count').textContent).toBe('No matches'));
  });

  it('always renders task_complete expanded, even when tool calls are hidden', async () => {
    renderPane();
    emit({
      type: 'replay',
      events: [
        { kind: 'tool', id: 't1', ts: 1, toolCallId: 'c1', toolName: 'bash', status: 'success', output: 'ok' },
        {
          kind: 'tool',
          id: 't2',
          ts: 2,
          toolCallId: 'c2',
          toolName: 'task_complete',
          status: 'success',
          args: { summary: 'Shipped the parser fix.' },
        },
      ],
    });
    await waitFor(() => expect(screen.getByText('Shipped the parser fix.')).toBeTruthy());

    fireEvent.click(screen.getByTitle('Show/hide output types'));
    fireEvent.click(await screen.findByTestId('filter-tool-badge'));

    // The ordinary tool call collapses to a badge, the summary stays readable.
    await waitFor(() => expect(screen.getByTestId('tool-badge-c1')).toBeTruthy());
    expect(screen.queryByTestId('tool-badge-c2')).toBeNull();
    expect(screen.getByTestId('task-complete-c2').textContent).toContain('Shipped the parser fix.');
  });

  it('keeps reasoning expanded by default and collapses it to a badge in Badge mode', async () => {
    renderPane();
    emit({
      type: 'replay',
      events: [
        { kind: 'reasoning', id: 'r1', ts: 1, content: 'Weighing the two parser strategies' },
        { kind: 'assistant', id: 'a1', ts: 2, content: 'Done' },
      ],
    });

    // Expanded by default: the trace text is on screen without any interaction.
    await waitFor(() => expect(screen.getByText('Weighing the two parser strategies')).toBeTruthy());
    expect(screen.queryByTestId('agent-reasoning-badge')).toBeNull();

    fireEvent.click(screen.getByTitle('Show/hide output types'));
    fireEvent.click(await screen.findByTestId('filter-reasoning-badge'));

    // Badge mode collapses it to a brain badge rather than removing it.
    const badge = await screen.findByTestId('agent-reasoning-badge');
    expect(screen.queryByText('Weighing the two parser strategies')).toBeNull();

    // The badge still expands on click.
    fireEvent.click(badge);
    expect(screen.getByText('Weighing the two parser strategies')).toBeTruthy();
  });

  it('fully removes reasoning when its view mode is Hide', async () => {
    renderPane();
    emit({
      type: 'replay',
      events: [
        { kind: 'reasoning', id: 'r1', ts: 1, content: 'Weighing the two parser strategies' },
        { kind: 'assistant', id: 'a1', ts: 2, content: 'Done' },
      ],
    });
    await waitFor(() => expect(screen.getByText('Weighing the two parser strategies')).toBeTruthy());

    fireEvent.click(screen.getByTitle('Show/hide output types'));
    fireEvent.click(await screen.findByTestId('filter-reasoning-hide'));

    // Nothing left behind: no trace text and no brain badge.
    await waitFor(() => expect(screen.queryByText('Weighing the two parser strategies')).toBeNull());
    expect(screen.queryByTestId('agent-reasoning-badge')).toBeNull();
    // The assistant message it preceded still renders.
    expect(screen.getByText('Done')).toBeTruthy();
  });

  it('fully removes tool calls when the tool view mode is Hide', async () => {
    renderPane();
    emit({
      type: 'replay',
      events: [
        { kind: 'assistant', id: 'a1', ts: 1, content: 'Working on it' },
        { kind: 'tool', id: 't1', ts: 2, toolCallId: 'c1', toolName: 'bash', status: 'running' },
      ],
    });
    await waitFor(() => expect(screen.getByText('bash')).toBeTruthy());

    fireEvent.click(screen.getByTitle('Show/hide output types'));
    fireEvent.click(await screen.findByTestId('filter-tool-hide'));

    // Neither the full card nor a badge remains.
    await waitFor(() => expect(screen.queryByTestId('tool-progress-c1')).toBeNull());
    expect(screen.queryByTestId('tool-badge-c1')).toBeNull();
    expect(screen.queryByTestId('tool-badges')).toBeNull();
    // The assistant message stays visible.
    expect(screen.getByText('Working on it')).toBeTruthy();
  });

  it('shows notices in full by default, as a badge in Badge mode, and gone in Hide mode', async () => {
    renderPane();
    emit({
      type: 'replay',
      events: [{ kind: 'notice', id: 'n1', ts: 1, message: 'Session resumed' }],
    });
    // Show (default): full notice text is visible.
    await waitFor(() => expect(screen.getByText('Session resumed')).toBeTruthy());
    expect(screen.queryByTestId('notice-badge-n1')).toBeNull();

    // Badge: collapses to a compact notice badge, full text gone.
    fireEvent.click(screen.getByTitle('Show/hide output types'));
    fireEvent.click(await screen.findByTestId('filter-notice-badge'));
    await waitFor(() => expect(screen.getByTestId('notice-badge-n1')).toBeTruthy());
    expect(screen.queryByText('Session resumed')).toBeNull();

    // Hide: nothing left at all.
    fireEvent.click(screen.getByTestId('filter-notice-hide'));
    await waitFor(() => expect(screen.queryByTestId('notice-badge-n1')).toBeNull());
    expect(screen.queryByText('Session resumed')).toBeNull();
  });

  it('marks the active view mode with aria-pressed', async () => {
    renderPane();
    fireEvent.click(screen.getByTitle('Show/hide output types'));
    // Default is Show for every kind.
    expect(await screen.findByTestId('filter-reasoning-show')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('filter-reasoning-badge')).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByTestId('filter-reasoning-badge'));
    expect(screen.getByTestId('filter-reasoning-badge')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('filter-reasoning-show')).toHaveAttribute('aria-pressed', 'false');
  });

  it('migrates the old boolean visibility payload to the tri-state model', async () => {
    // Old shape: tool hidden, notice hidden, reasoning shown.
    localStorage.setItem(
      'pilot-console-agent-visibility',
      JSON.stringify({ tool: false, reasoning: true, notice: false, toolOutput: true }),
    );
    renderPane();
    emit({
      type: 'replay',
      events: [
        { kind: 'tool', id: 't1', ts: 1, toolCallId: 'c1', toolName: 'bash', status: 'running' },
        { kind: 'notice', id: 'n1', ts: 2, message: 'Session resumed' },
        { kind: 'reasoning', id: 'r1', ts: 3, content: 'Thinking hard' },
      ],
    });

    // old tool:false → badge (the collapsed strip is present).
    await waitFor(() => expect(screen.getByTestId('tool-badge-c1')).toBeTruthy());
    expect(screen.queryByTestId('tool-progress-c1')).toBeNull();
    // old notice:false → hide (fully gone, no badge).
    expect(screen.queryByText('Session resumed')).toBeNull();
    expect(screen.queryByTestId('notice-badge-n1')).toBeNull();
    // old reasoning:true → show (expanded trace text visible).
    expect(screen.getByText('Thinking hard')).toBeTruthy();

    // The dropdown reflects the migrated modes.
    fireEvent.click(screen.getByTitle('Show/hide output types'));
    expect(await screen.findByTestId('filter-tool-badge')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('filter-notice-hide')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('filter-reasoning-show')).toHaveAttribute('aria-pressed', 'true');
  });

  it('outlines the conversation and jumps back into the transcript on click', async () => {
    renderPane();
    emit({
      type: 'replay',
      events: [
        { kind: 'user', id: 'u1', ts: 1, content: 'Please fix the parser' },
        { kind: 'assistant', id: 'a1', ts: 2, content: 'Let me look into that' },
        { kind: 'tool', id: 't1', ts: 3, toolCallId: 'c1', toolName: 'bash', status: 'success', output: 'ok' },
        { kind: 'assistant', id: 'a2', ts: 4, content: 'The parser is fixed now' },
        { kind: 'user', id: 'u2', ts: 5, content: 'Thanks, ship it' },
      ],
    });
    await waitFor(() => expect(screen.getByText('Thanks, ship it')).toBeTruthy());

    fireEvent.click(screen.getByTestId('agent-outline-toggle'));
    const list = await screen.findByTestId('agent-outline');

    // Both requests plus only the *final* response of the first turn.
    expect(list.children).toHaveLength(3);
    expect(list.textContent).toContain('Please fix the parser');
    expect(list.textContent).toContain('The parser is fixed now');
    expect(list.textContent).not.toContain('Let me look into that');
    // Tool calls never appear in the outline.
    expect(screen.queryByTestId('tool-badge-c1')).toBeNull();

    // Picking a row leaves the outline and returns to the full transcript.
    fireEvent.click(screen.getByTestId('outline-item-a2'));
    await waitFor(() => expect(screen.queryByTestId('agent-outline')).toBeNull());
    expect(screen.getByText('Let me look into that')).toBeTruthy();
    expect(screen.getByTestId('agent-outline-toggle')).toHaveAttribute('aria-pressed', 'false');
  });

  it('prefers a task_complete summary over the assistant message before it', async () => {
    renderPane();
    emit({
      type: 'replay',
      events: [
        { kind: 'user', id: 'u1', ts: 1, content: 'Do the thing' },
        { kind: 'assistant', id: 'a1', ts: 2, content: 'Working on it' },
        {
          kind: 'tool',
          id: 't1',
          ts: 3,
          toolCallId: 'c1',
          toolName: 'task_complete',
          status: 'success',
          args: { summary: 'Did the thing.' },
        },
      ],
    });
    await waitFor(() => expect(screen.getByText('Did the thing.')).toBeTruthy());

    fireEvent.click(screen.getByTestId('agent-outline-toggle'));
    const list = await screen.findByTestId('agent-outline');
    expect(list.children).toHaveLength(2);
    expect(list.textContent).toContain('Did the thing.');
    expect(list.textContent).not.toContain('Working on it');
  });

  it('refetches the model list when the first response is degraded', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          json: () => Promise.resolve({ models: [{ id: 'auto', name: 'Auto' }], degraded: true }),
        })
        .mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              models: [
                { id: 'auto', name: 'Auto' },
                { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5' },
              ],
            }),
        });
      global.fetch = fetchMock as unknown as typeof fetch;

      renderPane();
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_100);
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // A healthy second response ends the retry loop.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('turn progress', () => {
    it('shows no progress banner while the agent is idle', () => {
      renderPane();
      emit({ type: 'status', status: 'idle', turnStartedAt: null });
      expect(screen.queryByTestId('agent-turn-progress')).toBeNull();
    });

    it('shows a live progress banner with elapsed time while the agent works', () => {
      vi.useFakeTimers();
      try {
        const started = Date.now();
        renderPane();
        emit({ type: 'status', status: 'busy', turnStartedAt: started });

        expect(screen.getByTestId('agent-turn-progress')).toBeTruthy();
        expect(screen.getByTestId('agent-turn-elapsed').textContent).toBe('0s');

        act(() => {
          vi.advanceTimersByTime(5_000);
        });
        expect(screen.getByTestId('agent-turn-elapsed').textContent).toBe('5s');

        // Past a minute the counter switches to minutes + zero-padded seconds.
        act(() => {
          vi.advanceTimersByTime(60_000);
        });
        expect(screen.getByTestId('agent-turn-elapsed').textContent).toBe('1m 05s');
      } finally {
        vi.useRealTimers();
      }
    });

    it('measures elapsed time from the server-reported request start, not from render', () => {
      vi.useFakeTimers();
      try {
        renderPane();
        // The turn began 90s ago; a reconnect must not restart the clock.
        emit({ type: 'status', status: 'busy', turnStartedAt: Date.now() - 90_000 });
        expect(screen.getByTestId('agent-turn-elapsed').textContent).toBe('1m 30s');
      } finally {
        vi.useRealTimers();
      }
    });

    it('clears the progress banner once the turn completes', () => {
      renderPane();
      emit({ type: 'status', status: 'busy', turnStartedAt: Date.now() });
      expect(screen.getByTestId('agent-turn-progress')).toBeTruthy();
      emit({ type: 'status', status: 'idle', turnStartedAt: null });
      expect(screen.queryByTestId('agent-turn-progress')).toBeNull();
    });

    it('renders assistant reply durations in minutes and seconds', () => {
      renderPane();
      emit({
        type: 'event',
        event: { kind: 'assistant', id: 'a1', ts: Date.now(), content: 'done', durationMs: 95_000 },
      });
      expect(screen.getByText(/1m 35s/)).toBeTruthy();
    });
  });

  // The agent can put a question to the user as buttons so non-freeform
  // answers need a click rather than typing.
  describe('ask_user prompts', () => {
    const question = {
      type: 'ask_user_request' as const,
      requestId: 'q1',
      question: 'Which database?',
      detail: 'Both are already installed.',
      options: ['Postgres', 'SQLite'],
      allowText: true,
    };

    it('renders the question, detail, and one button per option', () => {
      renderPane();
      emit(question);
      const card = screen.getByTestId('ask-user-prompt');
      expect(card.textContent).toContain('Which database?');
      expect(card.textContent).toContain('Both are already installed.');
      expect(screen.getByRole('button', { name: 'Postgres' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'SQLite' })).toBeTruthy();
    });

    it('sends the clicked option back and clears the prompt', () => {
      renderPane();
      emit(question);
      fireEvent.click(screen.getByRole('button', { name: 'SQLite' }));
      expect(hooked.send).toHaveBeenCalledWith({
        type: 'ask_user_response',
        requestId: 'q1',
        answer: 'SQLite',
      });
      expect(screen.queryByTestId('ask-user-prompt')).toBeNull();
    });

    it('accepts a typed answer when the prompt allows one', () => {
      renderPane();
      emit(question);
      const box = screen.getByLabelText('Type an answer instead');
      fireEvent.change(box, { target: { value: '  DuckDB  ' } });
      fireEvent.keyDown(box, { key: 'Enter' });
      expect(hooked.send).toHaveBeenCalledWith({
        type: 'ask_user_response',
        requestId: 'q1',
        answer: 'DuckDB',
      });
    });

    it('omits the free-text box when the agent wants a strict choice', () => {
      renderPane();
      emit({ ...question, allowText: false });
      expect(screen.queryByLabelText('Type an answer instead')).toBeNull();
      expect(screen.getByRole('button', { name: 'Postgres' })).toBeTruthy();
    });

    it('removes the prompt when the server resolves it elsewhere', () => {
      renderPane();
      emit(question);
      emit({ type: 'ask_user_resolved', requestId: 'q1' });
      expect(screen.queryByTestId('ask-user-prompt')).toBeNull();
    });

    it('replaces rather than duplicates a re-sent question on reconnect', () => {
      renderPane();
      emit(question);
      emit(question);
      expect(screen.getAllByTestId('ask-user-prompt')).toHaveLength(1);
    });

    // The agent's turn is parked inside the ask_user call, so a normal send
    // would queue behind a turn that can never end. The buttons must never be
    // a gate on typing.
    it('answers the pending question with text typed in the main composer', () => {
      renderPane();
      emit(question);
      const textarea = screen.getByPlaceholderText(/Click an option above/i);
      fireEvent.change(textarea, { target: { value: 'actually use DuckDB' } });
      fireEvent.keyDown(textarea, { key: 'Enter' });
      expect(hooked.send).toHaveBeenCalledWith({
        type: 'ask_user_response',
        requestId: 'q1',
        answer: 'actually use DuckDB',
      });
      expect(hooked.send).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'send' }),
      );
      expect(screen.queryByTestId('ask-user-prompt')).toBeNull();
    });

    it('still shows a pending question while the Outline view is open', async () => {
      renderPane();
      emit(question);
      fireEvent.click(screen.getByTestId('agent-outline-toggle'));
      await screen.findByTestId('agent-outline');
      // The agent's turn is parked on this question; hiding it behind a view
      // toggle makes the session look hung with nothing to click.
      expect(screen.getByTestId('ask-user-prompt')).toBeTruthy();
    });

    it('routes the composer back to a normal send once nothing is pending', () => {
      renderPane();
      emit(question);
      emit({ type: 'ask_user_resolved', requestId: 'q1' });
      const textarea = screen.getByPlaceholderText(/Message Copilot/i);
      fireEvent.change(textarea, { target: { value: 'carry on' } });
      fireEvent.keyDown(textarea, { key: 'Enter' });
      expect(hooked.send).toHaveBeenCalledWith({ type: 'send', prompt: 'carry on' });
    });

    it('still runs slash commands while a question is pending', () => {
      renderPane();
      emit(question);
      const textarea = screen.getByPlaceholderText(/Click an option above/i);
      fireEvent.change(textarea, { target: { value: '/mode autopilot' } });
      fireEvent.keyDown(textarea, { key: 'Enter' });
      expect(hooked.send).toHaveBeenCalledWith({ type: 'set_mode', mode: 'autopilot' });
    });
  });

  describe('voice input', () => {
    class FakeRecognition {
      static instances: FakeRecognition[] = [];
      continuous = false;
      interimResults = false;
      lang = '';
      maxAlternatives = 1;
      started = 0;
      onresult: ((e: unknown) => void) | null = null;
      onerror: ((e: { error: string }) => void) | null = null;
      onend: (() => void) | null = null;
      onstart: (() => void) | null = null;
      constructor() {
        FakeRecognition.instances.push(this);
      }
      start() {
        this.started += 1;
      }
      stop() {
        this.onend?.();
      }
      abort() {}
      say(transcript: string, isFinal: boolean) {
        this.onresult?.({
          resultIndex: 0,
          results: { length: 1, 0: { length: 1, isFinal, 0: { transcript } } },
        });
      }
    }

    beforeEach(() => {
      FakeRecognition.instances = [];
      (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition = FakeRecognition;
    });

    afterEach(() => {
      delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
    });

    function startDictation() {
      renderPane();
      act(() => {
        fireEvent.click(screen.getByTestId('agent-dictate'));
      });
      return FakeRecognition.instances.at(-1)!;
    }

    it('fills the composer with speech so it can be edited before sending', () => {
      const recognition = startDictation();
      act(() => recognition.say('add a retry to the fetch call', true));

      const box = screen.getByPlaceholderText(/Listening/) as HTMLTextAreaElement;
      expect(box.value).toBe('add a retry to the fetch call');
      // Still a normal textarea: the point is to edit before sending.
      expect(hooked.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'send' }));
    });

    it('shows interim speech and then the corrected final text', () => {
      const recognition = startDictation();
      act(() => recognition.say('add a retro', false));
      expect((screen.getByPlaceholderText(/Listening/) as HTMLTextAreaElement).value).toBe('add a retro');

      act(() => recognition.say('add a retry', true));
      expect((screen.getByPlaceholderText(/Listening/) as HTMLTextAreaElement).value).toBe('add a retry');
    });

    it('appends to text already typed instead of replacing it', () => {
      renderPane();
      const box = screen.getByPlaceholderText(/Message Copilot/) as HTMLTextAreaElement;
      fireEvent.change(box, { target: { value: 'Fix the bug:' } });
      act(() => {
        fireEvent.click(screen.getByTestId('agent-dictate'));
      });
      act(() => FakeRecognition.instances.at(-1)!.say('it throws on empty input', true));

      expect((screen.getByPlaceholderText(/Listening/) as HTMLTextAreaElement).value).toBe(
        'Fix the bug: it throws on empty input',
      );
    });

    it('stops listening when the message is sent', () => {
      const recognition = startDictation();
      act(() => recognition.say('hello', true));
      fireEvent.click(screen.getByTitle('Send'));

      expect(hooked.send).toHaveBeenCalledWith({ type: 'send', prompt: 'hello' });
      expect(screen.getByTestId('agent-dictate').getAttribute('aria-pressed')).toBe('false');
    });

    it('reports a blocked microphone instead of failing silently', () => {
      const recognition = startDictation();
      act(() => recognition.onerror?.({ error: 'not-allowed' }));

      expect(screen.getByText(/Microphone access was blocked/)).toBeTruthy();
      expect(screen.getByTestId('agent-dictate').getAttribute('aria-pressed')).toBe('false');
    });

    it('hides the mic entirely in browsers without the Web Speech API', () => {
      delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
      renderPane();
      expect(screen.queryByTestId('agent-dictate')).toBeNull();
    });
  });
});
