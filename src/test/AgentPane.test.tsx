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

    // Open the View menu and uncheck "Tool calls".
    fireEvent.click(screen.getByTitle('Show/hide output types'));
    const toolToggle = await screen.findByLabelText('Tool calls');
    fireEvent.click(toolToggle);

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
    fireEvent.click(await screen.findByLabelText('Tool calls'));

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
    fireEvent.click(await screen.findByLabelText('Tool calls'));

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
    fireEvent.click(await screen.findByLabelText('Tool calls'));
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

  it('disables the "Tool output" sub-filter while tool calls are hidden', async () => {
    renderPane();
    fireEvent.click(screen.getByTitle('Show/hide output types'));
    const outputToggle = await screen.findByTestId('filter-tool-output');
    expect(outputToggle).not.toBeDisabled();

    fireEvent.click(screen.getByLabelText('Tool calls'));

    await waitFor(() => expect(screen.getByTestId('filter-tool-output')).toBeDisabled());
    expect(screen.getByTestId('filter-tool-output')).not.toBeChecked();
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
    fireEvent.click(await screen.findByLabelText('Tool calls'));

    // The ordinary tool call collapses to a badge, the summary stays readable.
    await waitFor(() => expect(screen.getByTestId('tool-badge-c1')).toBeTruthy());
    expect(screen.queryByTestId('tool-badge-c2')).toBeNull();
    expect(screen.getByTestId('task-complete-c2').textContent).toContain('Shipped the parser fix.');
  });

  it('keeps reasoning expanded by default and collapses it to a badge when unchecked', async () => {
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
    fireEvent.click(await screen.findByLabelText('Reasoning'));

    // Unchecking collapses it to a brain badge rather than removing it.
    const badge = await screen.findByTestId('agent-reasoning-badge');
    expect(screen.queryByText('Weighing the two parser strategies')).toBeNull();

    // The badge still expands on click.
    fireEvent.click(badge);
    expect(screen.getByText('Weighing the two parser strategies')).toBeTruthy();
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
