import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { AgentServerMessage } from '@/types';

// Capture the hook options so tests can drive server → client messages, and
// expose the mocked `send` so we can assert client → server messages.
const hooked = vi.hoisted(() => ({
  onMessage: undefined as ((msg: AgentServerMessage) => void) | undefined,
  send: vi.fn(),
  reset: vi.fn(),
  switchTo: vi.fn(),
}));

vi.mock('@/hooks/useAgentSocket', () => ({
  useAgentSocket: (opts: { onMessage?: (msg: AgentServerMessage) => void }) => {
    hooked.onMessage = opts.onMessage;
    return { state: 'open' as const, send: hooked.send, reset: hooked.reset, switchTo: hooked.switchTo };
  },
}));

import AgentPane from '@/components/terminal/AgentPane';

function emit(msg: AgentServerMessage) {
  act(() => {
    hooked.onMessage?.(msg);
  });
}

describe('AgentPane', () => {
  beforeEach(() => {
    hooked.send.mockClear();
    hooked.reset.mockClear();
    hooked.switchTo.mockClear();
    hooked.onMessage = undefined;
    global.fetch = vi.fn(() =>
      Promise.resolve({ json: () => Promise.resolve({ models: [{ id: 'auto', name: 'Auto' }] }) }),
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

  it('renders a tool activity card with the tool name', async () => {
    renderPane();
    emit({
      type: 'event',
      event: { kind: 'tool', id: 't1', ts: 1, toolCallId: 'c1', toolName: 'bash', status: 'running' },
    });
    await waitFor(() => expect(screen.getByText('bash')).toBeTruthy());
  });

  it('sends a message when the composer submits', async () => {
    renderPane();
    const textarea = screen.getByPlaceholderText(/Message Copilot/i);
    fireEvent.change(textarea, { target: { value: 'do something' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(hooked.send).toHaveBeenCalledWith({ type: 'send', prompt: 'do something' }));
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

  it('cycles the agent mode via the bottom indicator and notifies the server', async () => {
    renderPane();
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

    // Open the View menu and uncheck "Tool calls".
    fireEvent.click(screen.getByTitle('Show/hide output types'));
    const toolToggle = await screen.findByLabelText('Tool calls');
    fireEvent.click(toolToggle);

    await waitFor(() => expect(screen.queryByText('bash')).toBeNull());
    // The assistant message stays visible.
    expect(screen.getByText('Working on it')).toBeTruthy();
  });

  it('renders a system message entry with a "System message" indicator', async () => {
    renderPane();
    emit({
      type: 'event',
      event: { kind: 'system', id: 's1', ts: 1, content: 'You are a helpful assistant.' },
    });
    await waitFor(() => expect(screen.getByText('System message')).toBeTruthy());
    expect(screen.getByText('You are a helpful assistant.')).toBeTruthy();
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
});
