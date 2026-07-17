'use client';

import { useCallback, useEffect, useMemo, useRef, useState, memo, type KeyboardEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Send,
  Square,
  ChevronRight,
  ChevronDown,
  Wrench,
  Check,
  X as XIcon,
  Loader2,
  MessageSquare,
  ClipboardList,
  Rocket,
  SlidersHorizontal,
  Brain,
  Cog,
  Share2,
  Copy,
  ExternalLink,
} from 'lucide-react';
import { useAgentSocket } from '@/hooks/useAgentSocket';
import { getThemeByName } from '@/lib/terminal-themes';
import type {
  AgentModelOption,
  AgentMode,
  AgentServerMessage,
  AgentSlashCommand,
  AgentCommandOption,
  AgentSessionSummary,
  AgentShareStatus,
  AgentStatus,
  AgentTranscriptEvent,
} from '@/types';

interface Props {
  projectId: string;
  worktreeId?: string;
  sessionId?: string;
  active: boolean;
  themeName?: string;
  fontFamily?: string;
  fontSize?: number;
  onSessionId?: (sessionId: string) => void;
  onStatusChange?: (status: string) => void;
}

interface PermissionPrompt {
  requestId: string;
  title: string;
  detail: string;
  canSession: boolean;
}

interface ExitPlanPrompt {
  requestId: string;
  summary: string;
  planContent?: string;
  actions: string[];
  recommended: string;
}

const MODE_ORDER: AgentMode[] = ['interactive', 'plan', 'autopilot'];

const MODE_META: Record<AgentMode, { label: string; icon: typeof MessageSquare; color: string }> = {
  interactive: { label: 'Interactive', icon: MessageSquare, color: '#3fb950' },
  plan: { label: 'Plan', icon: ClipboardList, color: '#58a6ff' },
  autopilot: { label: 'Auto-pilot', icon: Rocket, color: '#d29922' },
};

const EXIT_ACTION_LABELS: Record<string, string> = {
  interactive: 'Proceed interactively',
  autopilot: 'Proceed in auto-pilot',
  autopilot_fleet: 'Auto-pilot (parallel)',
  exit_only: 'Exit plan mode',
};

/**
 * Commands handled entirely on the client — they map to controls already wired
 * into this pane (model picker, mode indicator, cancel, new-session), so they
 * work reliably without a round-trip through the SDK's TUI-oriented handlers.
 * Everything else in the menu is discovered dynamically from the session.
 */
const CLIENT_COMMANDS: AgentSlashCommand[] = [
  { name: 'model', kind: 'client', description: 'Switch the model', argHint: '<id>' },
  { name: 'mode', kind: 'client', description: 'Switch agent mode', argHint: '<interactive|plan|autopilot>' },
  { name: 'resume', kind: 'client', description: 'Switch to another session' },
  { name: 'diff', kind: 'client', description: 'Review working-tree changes' },
  { name: 'share', kind: 'client', description: 'Share this session on GitHub', argHint: '[export|on|off]' },
  { name: 'stop', kind: 'client', description: 'Stop the current turn' },
  { name: 'clear', kind: 'client', description: 'Start a new session' },
  { name: 'help', kind: 'client', description: 'List slash commands' },
];

const CLIENT_COMMAND_NAMES = new Set(CLIENT_COMMANDS.map((c) => c.name));

// Cap live-streamed tool output kept in browser memory (mirrors the server).
const MAX_TOOL_OUTPUT_CHARS = 50_000;
// How many transcript items to render at once; older items are collapsed
// behind a "show earlier" button so a long session doesn't render thousands
// of DOM nodes at once.
const RENDER_WINDOW = 400;

/** Whether a command should prompt for an argument before running. */
const commandTakesArg = (c: AgentSlashCommand): boolean =>
  c.argRequired === true || !!c.argHint || !!(c.argChoices && c.argChoices.length);

const KIND_LABEL: Record<AgentSlashCommand['kind'], string> = {
  client: '',
  builtin: '',
  skill: 'skill',
};

/**
 * Transcript entry kinds the user can show/hide from the Agent tab. `user`,
 * `assistant` and `error` are core conversation and always shown; the rest are
 * "extra" output types (tool calls, model reasoning, system notices).
 */
type FilterableKind = 'tool' | 'reasoning' | 'system' | 'notice';

const FILTERABLE_KINDS: { kind: FilterableKind; label: string }[] = [
  { kind: 'tool', label: 'Tool calls' },
  { kind: 'reasoning', label: 'Reasoning' },
  { kind: 'system', label: 'System messages' },
  { kind: 'notice', label: 'Notices' },
];

type Visibility = Record<FilterableKind, boolean>;

const DEFAULT_VISIBILITY: Visibility = { tool: true, reasoning: true, system: true, notice: true };

const VISIBILITY_LS_KEY = 'pilot-console-agent-visibility';

function loadVisibility(): Visibility {
  try {
    const raw = localStorage.getItem(VISIBILITY_LS_KEY);
    if (!raw) return { ...DEFAULT_VISIBILITY };
    const parsed = JSON.parse(raw) as Partial<Visibility>;
    return {
      tool: parsed.tool ?? true,
      reasoning: parsed.reasoning ?? true,
      system: parsed.system ?? true,
      notice: parsed.notice ?? true,
    };
  } catch {
    return { ...DEFAULT_VISIBILITY };
  }
}

export default function AgentPane({
  projectId,
  worktreeId,
  sessionId,
  active,
  themeName,
  fontFamily,
  fontSize = 13,
  onSessionId,
  onStatusChange,
}: Props) {
  const [events, setEvents] = useState<AgentTranscriptEvent[]>([]);
  const [status, setStatus] = useState<AgentStatus>('idle');
  const [model, setModel] = useState('auto');
  const [mode, setMode] = useState<AgentMode>('interactive');
  const [permissions, setPermissions] = useState<PermissionPrompt[]>([]);
  const [exitPlans, setExitPlans] = useState<ExitPlanPrompt[]>([]);
  const [models, setModels] = useState<AgentModelOption[]>([{ id: 'auto', name: 'Auto' }]);
  const [connError, setConnError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  // Dynamic slash-command catalog for this session (plugin/skill-aware).
  const [serverCommands, setServerCommands] = useState<AgentSlashCommand[]>([]);
  // Pending subcommand picker, when a command needs a further selection.
  const [subcommandPrompt, setSubcommandPrompt] = useState<{
    command: string;
    title: string;
    options: AgentCommandOption[];
  } | null>(null);
  // Native /resume switcher + /diff panel overlays.
  const [sessionList, setSessionList] = useState<AgentSessionSummary[] | null>(null);
  const [diffPanel, setDiffPanel] = useState<{ content: string; truncated: boolean } | null>(null);
  // Which "extra" output types (tool calls, reasoning, notices) are shown.
  const [visibility, setVisibility] = useState<Visibility>(loadVisibility);
  const [filterOpen, setFilterOpen] = useState(false);
  // GitHub session-sharing status + popover.
  const [shareStatus, setShareStatus] = useState<AgentShareStatus>({ mode: 'off', steerable: false });
  const [shareOpen, setShareOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  // Upsert a transcript entry by id (matching the server's semantics).
  const upsert = useCallback((event: AgentTranscriptEvent) => {
    setEvents((prev) => {
      const idx = prev.findIndex((e) => e.id === event.id);
      if (idx >= 0) {
        const next = prev.slice();
        next[idx] = event;
        return next;
      }
      return [...prev, event];
    });
  }, []);

  const applyDelta = useCallback((id: string, delta: string, kind: 'assistant' | 'tool') => {
    setEvents((prev) => {
      const idx = prev.findIndex((e) => e.id === id);
      if (idx < 0) return prev;
      const entry = prev[idx];
      const next = prev.slice();
      if (entry.kind === 'assistant' && kind === 'assistant') {
        next[idx] = { ...entry, content: entry.content + delta };
      } else if (entry.kind === 'tool' && kind === 'tool') {
        const combined = (entry.output ?? '') + delta;
        // Bound live-streamed tool output so a chatty tool can't grow the
        // browser's transcript memory without limit (matches the server cap).
        const output =
          combined.length > MAX_TOOL_OUTPUT_CHARS
            ? combined.slice(0, MAX_TOOL_OUTPUT_CHARS) + `\n… [truncated ${combined.length - MAX_TOOL_OUTPUT_CHARS} chars]`
            : combined;
        next[idx] = { ...entry, output };
      }
      return next;
    });
  }, []);

  const handleMessage = useCallback(
    (msg: AgentServerMessage) => {
      switch (msg.type) {
        case 'ready':
          setModel(msg.model);
          setMode(msg.mode);
          setStatus(msg.status);
          setConnError(null);
          break;
        case 'replay':
          setEvents(msg.events);
          break;
        case 'event':
          upsert(msg.event);
          break;
        case 'assistant_delta':
          applyDelta(msg.id, msg.delta, 'assistant');
          break;
        case 'tool_delta':
          applyDelta(msg.id, msg.delta, 'tool');
          break;
        case 'status':
          setStatus(msg.status);
          break;
        case 'model':
          setModel(msg.model);
          break;
        case 'mode':
          setMode(msg.mode);
          break;
        case 'commands':
          setServerCommands(msg.commands);
          break;
        case 'command_subcommands':
          setSubcommandPrompt({ command: msg.command, title: msg.title, options: msg.options });
          break;
        case 'sessions':
          setSessionList(msg.sessions);
          break;
        case 'diff':
          setDiffPanel({ content: msg.content, truncated: msg.truncated });
          break;
        case 'share_status':
          setShareStatus(msg.status);
          break;
        case 'permission_request':
          setPermissions((prev) => [
            ...prev,
            { requestId: msg.requestId, title: msg.title, detail: msg.detail, canSession: msg.canSession },
          ]);
          break;
        case 'permission_resolved':
          setPermissions((prev) => prev.filter((p) => p.requestId !== msg.requestId));
          break;
        case 'exit_plan_request':
          setExitPlans((prev) => [
            ...prev,
            {
              requestId: msg.requestId,
              summary: msg.summary,
              planContent: msg.planContent,
              actions: msg.actions,
              recommended: msg.recommended,
            },
          ]);
          break;
        case 'exit_plan_resolved':
          setExitPlans((prev) => prev.filter((p) => p.requestId !== msg.requestId));
          break;
        case 'error':
          setConnError(msg.message);
          break;
      }
    },
    [upsert, applyDelta],
  );

  const { state, send, reset, switchTo } = useAgentSocket({
    projectId,
    worktreeId,
    sessionId,
    model,
    onMessage: handleMessage,
    onReady: onSessionId,
  });

  useEffect(() => {
    // Report a connection-oriented status for the tab indicator dot.
    const s = state === 'open' ? (status === 'busy' ? 'busy' : 'open') : state === 'connecting' ? 'connecting' : 'closed';
    onStatusChange?.(s);
  }, [state, status, onStatusChange]);

  // Fetch available models once for the picker.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/agent/models')
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && Array.isArray(data.models) && data.models.length) setModels(data.models);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-scroll to bottom when new content arrives, unless the user scrolled up.
  useEffect(() => {
    if (atBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events, visibility, permissions, exitPlans]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  // Persist visibility preferences across sessions/reloads.
  useEffect(() => {
    try {
      localStorage.setItem(VISIBILITY_LS_KEY, JSON.stringify(visibility));
    } catch {
      /* quota exceeded — ignore */
    }
  }, [visibility]);

  const toggleVisibility = useCallback((kind: FilterableKind) => {
    setVisibility((prev) => ({ ...prev, [kind]: !prev[kind] }));
  }, []);

  const copyShareUrl = useCallback((url: string) => {
    void navigator.clipboard?.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, []);

  // Drop empty assistant bubbles: the SDK opens an assistant "message" for
  // turns that end up containing only tool calls (or produce no text), which
  // would otherwise render as a stray "…" bubble. Also covers such entries
  // already persisted in older sessions on replay.
  const nonEmptyEvents = useMemo(
    () => events.filter((e) => !(e.kind === 'assistant' && !e.content.trim())),
    [events],
  );
  // Transcript filtered by the current visibility preferences.
  const visibleEvents = useMemo(
    () =>
      nonEmptyEvents.filter((e) =>
        e.kind === 'tool' || e.kind === 'reasoning' || e.kind === 'system' || e.kind === 'notice'
          ? visibility[e.kind]
          : true,
      ),
    [nonEmptyEvents, visibility],
  );
  const hiddenCount = nonEmptyEvents.length - visibleEvents.length;
  const anyHidden = FILTERABLE_KINDS.some((f) => !visibility[f.kind]);

  // Only render the most recent `renderLimit` items to bound DOM size; older
  // items stay in state (and scroll history) but are revealed on demand.
  const [renderLimit, setRenderLimit] = useState(RENDER_WINDOW);
  const windowedEvents =
    visibleEvents.length > renderLimit ? visibleEvents.slice(-renderLimit) : visibleEvents;
  const earlierCount = visibleEvents.length - windowedEvents.length;

  const respond = (requestId: string, decision: 'approve-once' | 'approve-for-session' | 'reject') => {
    send({ type: 'permission_response', requestId, decision });
    setPermissions((prev) => prev.filter((p) => p.requestId !== requestId));
  };

  const changeModel = (m: string) => {
    setModel(m);
    send({ type: 'set_model', model: m });
  };

  const changeMode = useCallback(
    (m: AgentMode) => {
      setMode(m);
      send({ type: 'set_mode', mode: m });
    },
    [send],
  );

  const modeRef = useRef(mode);
  modeRef.current = mode;

  const cycleMode = useCallback(() => {
    const idx = MODE_ORDER.indexOf(modeRef.current);
    changeMode(MODE_ORDER[(idx + 1) % MODE_ORDER.length]);
  }, [changeMode]);

  const respondExitPlan = (requestId: string, action: string) => {
    send({ type: 'exit_plan_response', requestId, action });
    setExitPlans((prev) => prev.filter((p) => p.requestId !== requestId));
  };

  // --- Slash commands ------------------------------------------------------
  const [slashSel, setSlashSel] = useState(0);
  const noticeSeq = useRef(0);

  const pushNotice = useCallback((message: string) => {
    const id = `notice:${Date.now()}:${noticeSeq.current++}`;
    setEvents((prev) => [...prev, { kind: 'notice', id, ts: Date.now(), message }]);
    atBottomRef.current = true;
  }, []);

  const setShareMode = useCallback(
    (mode: AgentShareStatus['mode']) => {
      send({ type: 'share_session', mode });
      pushNotice(mode === 'off' ? 'Stopping session sharing…' : 'Sharing session to GitHub…');
    },
    [send, pushNotice],
  );

  const clearSession = useCallback(() => {
    setEvents([]);
    setPermissions([]);
    setExitPlans([]);
    setSubcommandPrompt(null);
    setConnError(null);
    reset();
  }, [reset]);

  // The full menu: client-handled commands first, then the dynamic catalog
  // (runtime built-ins + skills + plugin commands) with any client overrides
  // filtered out so a command only appears once.
  const allCommands = useMemo<AgentSlashCommand[]>(() => {
    const dynamic = serverCommands.filter(
      (c) => !CLIENT_COMMAND_NAMES.has(c.name) && !(c.aliases ?? []).some((a) => CLIENT_COMMAND_NAMES.has(a)),
    );
    return [...CLIENT_COMMANDS, ...dynamic];
  }, [serverCommands]);

  const matchesQuery = (c: AgentSlashCommand, q: string) =>
    c.name.startsWith(q) || (c.aliases ?? []).some((a) => a.startsWith(q));

  const findCommand = useCallback(
    (name: string): AgentSlashCommand | undefined =>
      allCommands.find((c) => c.name === name || (c.aliases ?? []).includes(name)),
    [allCommands],
  );

  // Handle the small set of commands wired directly into this pane's controls.
  const runClientCommand = useCallback(
    (name: string, arg: string): boolean => {
      switch (name) {
        case 'model': {
          const id = arg.trim();
          if (!id) {
            pushNotice('Available models: ' + models.map((m) => m.id).join(', '));
            return true;
          }
          const found = models.find((m) => m.id === id || m.name === id);
          changeModel(found ? found.id : id);
          pushNotice('Model set to ' + (found ? found.id : id));
          return true;
        }
        case 'mode': {
          const m = arg.trim() as AgentMode;
          if (MODE_ORDER.includes(m)) {
            changeMode(m);
            pushNotice('Mode set to ' + MODE_META[m].label);
          } else {
            pushNotice('Usage: /mode interactive|plan|autopilot');
          }
          return true;
        }
        case 'stop':
          send({ type: 'cancel' });
          return true;
        case 'resume':
          setSessionList([]);
          send({ type: 'list_sessions' });
          return true;
        case 'diff':
          setDiffPanel({ content: '', truncated: false });
          send({ type: 'get_diff' });
          return true;
        case 'share': {
          const a = arg.trim().toLowerCase();
          const mode: 'export' | 'on' | 'off' = a === 'on' ? 'on' : a === 'off' ? 'off' : 'export';
          send({ type: 'share_session', mode });
          pushNotice(mode === 'off' ? 'Stopping session sharing…' : 'Sharing session to GitHub…');
          return true;
        }
        case 'clear':
          clearSession();
          return true;
        case 'help':
          pushNotice(
            'Slash commands:\n' +
              allCommands
                .map((c) => `/${c.name}${c.argHint ? ' ' + c.argHint : ''} — ${c.description}`)
                .join('\n'),
          );
          return true;
        default:
          return false;
      }
    },
    [models, changeModel, changeMode, send, clearSession, pushNotice, allCommands],
  );

  // Open a command's own subcommand choices as a picker (generic handling for
  // the `/session`, `/mcp`, `/memory`, … family that advertise input.choices).
  const openChoiceSubmenu = useCallback((cmd: AgentSlashCommand) => {
    setInput('');
    setSlashSel(0);
    setSubcommandPrompt({
      command: cmd.name,
      title: `/${cmd.name}${cmd.argHint ? ' ' + cmd.argHint : ''}`,
      options: (cmd.argChoices ?? []).map((c) => ({ name: c.name, description: c.description })),
    });
  }, []);

  const executeSlash = useCallback(
    (text: string) => {
      const body = text.replace(/^\//, '');
      const sp = body.indexOf(' ');
      const name = (sp === -1 ? body : body.slice(0, sp)).toLowerCase();
      const arg = sp === -1 ? '' : body.slice(sp + 1);
      const cmd = findCommand(name);
      // Client-handled command → run locally against the pane's own controls.
      if ((cmd && cmd.kind === 'client') || CLIENT_COMMAND_NAMES.has(name)) {
        if (runClientCommand(name, arg)) return;
      }
      // Subcommand-group command invoked bare → show its choices instead of
      // silently invoking the runtime default.
      if (cmd?.argChoices?.length && !arg.trim()) {
        openChoiceSubmenu(cmd);
        return;
      }
      // Everything else routes to the SDK's dynamic command handler.
      setSubcommandPrompt(null);
      send({ type: 'run_command', name, input: arg || undefined });
    },
    [findCommand, runClientCommand, openChoiceSubmenu, send],
  );

  // Menu is shown while typing a command name (before the first space).
  const slashQuery = input.startsWith('/') && !input.includes(' ') ? input.slice(1).toLowerCase() : null;
  const slashMatches = slashQuery !== null ? allCommands.filter((c) => matchesQuery(c, slashQuery)) : [];
  const slashIndex = slashMatches.length ? Math.min(slashSel, slashMatches.length - 1) : 0;

  const chooseCommand = (cmd: AgentSlashCommand) => {
    // Subcommand groups → open their choices as a picker.
    if (cmd.argChoices?.length) {
      openChoiceSubmenu(cmd);
      return;
    }
    // Free-form argument → prime the input and let the user type.
    if (commandTakesArg(cmd)) {
      setInput('/' + cmd.name + ' ');
    } else {
      executeSlash('/' + cmd.name);
      setInput('');
    }
    setSlashSel(0);
  };

  const chooseSubcommand = (option: AgentCommandOption) => {
    if (!subcommandPrompt) return;
    send({ type: 'run_command', name: subcommandPrompt.command, input: option.name });
    setSubcommandPrompt(null);
  };

  const pickSession = (id: string) => {
    setSessionList(null);
    if (id === sessionId) return;
    // Clear the local view; the server replays the target session's transcript.
    setEvents([]);
    setPermissions([]);
    setExitPlans([]);
    setConnError(null);
    onSessionId?.(id);
    switchTo(id);
  };

  const submit = () => {
    const trimmed = input.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('/')) {
      executeSlash(trimmed);
      setInput('');
      setSlashSel(0);
      return;
    }
    send({ type: 'send', prompt: trimmed });
    setInput('');
    atBottomRef.current = true;
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashSel((s) => (s + 1) % slashMatches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashSel((s) => (s - 1 + slashMatches.length) % slashMatches.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        chooseCommand(slashMatches[slashIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setInput('');
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  // Shift+Tab cycles the agent mode, matching the Copilot CLI keybinding.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Tab' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        cycleMode();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [active, cycleMode]);

  const busy = status === 'busy';

  const statusLabel = useMemo(() => {
    if (state !== 'open') return state === 'connecting' ? 'connecting…' : 'disconnected';
    return busy ? 'working…' : 'ready';
  }, [state, busy]);

  // Resolve appearance from the per-project terminal theme + font settings so
  // the agent chat matches the look of the terminal tabs.
  const appearance = useMemo(() => {
    const theme = getThemeByName(themeName ?? 'Catppuccin').theme;
    const fg = theme.foreground ?? '#cdd6f4';
    const bg = theme.background ?? '#1e1e2e';
    const accent = theme.blue ?? theme.brightBlue ?? '#89b4fa';
    return {
      theme,
      fg,
      bg,
      accent,
      surface: `color-mix(in srgb, ${fg} 8%, transparent)`,
      surfaceStrong: `color-mix(in srgb, ${fg} 14%, transparent)`,
      // Opaque tinted panel for floating overlays (popovers/menus) so the
      // transcript behind them doesn't bleed through.
      overlay: `color-mix(in srgb, ${fg} 8%, ${bg})`,
      border: `color-mix(in srgb, ${fg} 20%, transparent)`,
      muted: `color-mix(in srgb, ${fg} 60%, transparent)`,
    };
  }, [themeName]);

  const codeSize = Math.max(10, fontSize - 1);

  return (
    <div
      className="relative flex flex-col h-full"
      style={{ backgroundColor: appearance.bg, color: appearance.fg, fontFamily }}
    >
      {/* /resume — session switcher overlay */}
      {sessionList !== null && (
        <div
          className="absolute inset-0 z-20 flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0,0,0,0.45)' }}
          onMouseDown={() => setSessionList(null)}
        >
          <div
            data-testid="session-switcher"
            className="w-full max-w-md rounded-lg border shadow-lg overflow-hidden flex flex-col max-h-[80%]"
            style={{ borderColor: appearance.border, backgroundColor: appearance.overlay, color: appearance.fg }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div
              className="flex items-center px-3 py-2 border-b text-xs font-semibold"
              style={{ borderColor: appearance.border }}
            >
              Switch session
              <button type="button" className="ml-auto" onClick={() => setSessionList(null)}>
                <XIcon className="h-4 w-4" />
              </button>
            </div>
            <div className="overflow-y-auto">
              {sessionList.length === 0 ? (
                <div className="px-3 py-4 text-xs" style={{ color: appearance.muted }}>
                  No other sessions found for this project.
                </div>
              ) : (
                sessionList.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    data-testid={`session-item-${s.id}`}
                    onClick={() => pickSession(s.id)}
                    className="flex flex-col items-start gap-0.5 w-full px-3 py-2 text-left text-xs border-b"
                    style={{
                      borderColor: appearance.border,
                      backgroundColor: s.current ? appearance.surfaceStrong : 'transparent',
                    }}
                  >
                    <span className="font-medium truncate w-full">
                      {s.summary || s.id.slice(0, 8)}
                      {s.current && <span style={{ color: appearance.muted }}> (current)</span>}
                    </span>
                    <span style={{ color: appearance.muted }}>
                      {new Date(s.modifiedTime).toLocaleString()}
                      {s.isRemote ? ' · remote' : ''}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* /diff — working-tree diff overlay */}
      {diffPanel !== null && (
        <div
          className="absolute inset-0 z-20 flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0,0,0,0.45)' }}
          onMouseDown={() => setDiffPanel(null)}
        >
          <div
            data-testid="diff-panel"
            className="w-full max-w-2xl rounded-lg border shadow-lg overflow-hidden flex flex-col max-h-[85%]"
            style={{ borderColor: appearance.border, backgroundColor: appearance.overlay, color: appearance.fg }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div
              className="flex items-center px-3 py-2 border-b text-xs font-semibold"
              style={{ borderColor: appearance.border }}
            >
              Working-tree changes
              {diffPanel.truncated && (
                <span className="ml-2 font-normal" style={{ color: appearance.muted }}>
                  (truncated)
                </span>
              )}
              <button type="button" className="ml-auto" onClick={() => setDiffPanel(null)}>
                <XIcon className="h-4 w-4" />
              </button>
            </div>
            <pre
              className="overflow-auto p-3 text-xs whitespace-pre m-0"
              style={{ fontFamily, backgroundColor: appearance.bg }}
            >
              {diffPanel.content || 'Loading…'}
            </pre>
          </div>
        </div>
      )}

      {/* Header controls */}
      <div
        className="flex items-center gap-2 px-3 py-1.5 border-b shrink-0"
        style={{ borderColor: appearance.border, backgroundColor: appearance.surface }}
      >
        <span className="text-xs font-semibold">Copilot Agent</span>
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded ${
            busy ? 'bg-amber-500/15 text-amber-600' : 'bg-emerald-500/15 text-emerald-600'
          }`}
        >
          {statusLabel}
        </span>
        <div className="flex-1" />
        {/* GitHub session sharing */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setShareOpen((o) => !o)}
            title="Share this session on GitHub"
            data-testid="agent-share-button"
            className="flex items-center gap-1 h-6 px-1.5 rounded border text-[10px]"
            style={{
              borderColor: appearance.border,
              color: shareStatus.mode !== 'off' ? '#3fb950' : appearance.muted,
            }}
          >
            <Share2 className="h-3 w-3" />
            <span>{shareStatus.mode === 'off' ? 'Share' : 'Shared'}</span>
            {shareStatus.mode !== 'off' && (
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: '#3fb950' }} />
            )}
          </button>
          {shareOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setShareOpen(false)} />
              <div
                data-testid="agent-share-panel"
                className="absolute right-0 mt-1 z-20 w-64 rounded-md border shadow-xl p-2 space-y-2"
                style={{ borderColor: appearance.border, backgroundColor: appearance.overlay, color: appearance.fg }}
              >
                <div className="text-[10px] uppercase tracking-wide" style={{ color: appearance.muted }}>
                  Share with GitHub
                </div>
                <p className="text-[11px] leading-snug" style={{ color: appearance.muted }}>
                  {shareStatus.mode === 'off'
                    ? 'Publish this session so it appears in the GitHub agents tab.'
                    : shareStatus.mode === 'on'
                      ? 'Shared and steerable — GitHub can drive this session.'
                      : 'Shared read-only — visible in the GitHub agents tab.'}
                </p>

                {shareStatus.url && (
                  <div
                    className="flex items-center gap-1 rounded px-1.5 py-1 text-[11px] font-mono"
                    style={{ backgroundColor: appearance.surfaceStrong }}
                  >
                    <span className="truncate flex-1" title={shareStatus.url}>
                      {shareStatus.url}
                    </span>
                    <button
                      type="button"
                      title="Copy link"
                      data-testid="agent-share-copy"
                      onClick={() => copyShareUrl(shareStatus.url!)}
                      className="shrink-0"
                    >
                      {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
                    </button>
                    <a href={shareStatus.url} target="_blank" rel="noreferrer" title="Open in GitHub" className="shrink-0">
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                )}

                {shareStatus.error && (
                  <p className="text-[11px] text-destructive break-words">{shareStatus.error}</p>
                )}

                <div className="flex flex-col gap-1">
                  {shareStatus.mode === 'off' ? (
                    <>
                      <button
                        type="button"
                        data-testid="agent-share-export"
                        onClick={() => setShareMode('export')}
                        className="w-full rounded px-2 py-1 text-xs border hover:bg-black/5 dark:hover:bg-white/5"
                        style={{ borderColor: appearance.border }}
                      >
                        Share read-only
                      </button>
                      <button
                        type="button"
                        data-testid="agent-share-on"
                        onClick={() => setShareMode('on')}
                        className="w-full rounded px-2 py-1 text-xs border hover:bg-black/5 dark:hover:bg-white/5"
                        style={{ borderColor: appearance.border }}
                      >
                        Share &amp; allow steering
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        data-testid="agent-share-toggle-steer"
                        onClick={() => setShareMode(shareStatus.mode === 'on' ? 'export' : 'on')}
                        className="w-full rounded px-2 py-1 text-xs border hover:bg-black/5 dark:hover:bg-white/5"
                        style={{ borderColor: appearance.border }}
                      >
                        {shareStatus.mode === 'on' ? 'Make read-only' : 'Allow steering'}
                      </button>
                      <button
                        type="button"
                        data-testid="agent-share-off"
                        onClick={() => setShareMode('off')}
                        className="w-full rounded px-2 py-1 text-xs border border-destructive/40 text-destructive hover:bg-destructive/5"
                      >
                        Stop sharing
                      </button>
                    </>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
        <div className="relative">
          <button
            type="button"
            onClick={() => setFilterOpen((o) => !o)}
            title="Show/hide output types"
            className="flex items-center gap-1 h-6 px-1.5 rounded border text-[10px]"
            style={{
              borderColor: appearance.border,
              color: anyHidden ? appearance.accent : appearance.muted,
            }}
          >
            <SlidersHorizontal className="h-3 w-3" />
            <span>View</span>
            {hiddenCount > 0 && (
              <span
                className="ml-0.5 px-1 rounded-full"
                style={{ backgroundColor: appearance.accent, color: appearance.bg }}
              >
                {hiddenCount}
              </span>
            )}
          </button>
          {filterOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setFilterOpen(false)} />
              <div
                className="absolute right-0 mt-1 z-20 w-48 rounded-md border shadow-xl py-1"
                style={{
                  borderColor: appearance.border,
                  backgroundColor: appearance.overlay,
                  color: appearance.fg,
                }}
              >
                <div className="px-2 py-1 text-[10px] uppercase tracking-wide" style={{ color: appearance.muted }}>
                  Show output types
                </div>
                {FILTERABLE_KINDS.map((f) => (
                  <label
                    key={f.kind}
                    className="flex items-center gap-2 px-2 py-1 text-xs cursor-pointer hover:bg-black/5 dark:hover:bg-white/5"
                    style={{ color: appearance.fg }}
                  >
                    <input
                      type="checkbox"
                      checked={visibility[f.kind]}
                      onChange={() => toggleVisibility(f.kind)}
                    />
                    <span>{f.label}</span>
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="flex items-center gap-0.5 border rounded px-1" style={{ borderColor: appearance.border }}>
          <span className="text-[10px]" style={{ color: appearance.muted }}>Model</span>
          <select
            value={model}
            onChange={(e) => changeModel(e.target.value)}
            className="h-6 text-xs bg-transparent border-none outline-none px-0.5 max-w-[140px]"
            style={{ color: appearance.fg }}
          >
            {models.map((m) => (
              <option key={m.id} value={m.id} style={{ color: '#000' }}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {connError && (
        <div className="px-3 py-1.5 text-xs bg-destructive/10 text-destructive border-b">{connError}</div>
      )}

      {/* Transcript */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto px-3 py-3 space-y-3"
        style={{ fontSize }}
      >
        {nonEmptyEvents.length === 0 && (
          <div className="text-center pt-10" style={{ color: appearance.muted }}>
            Start a conversation with the Copilot agent.
          </div>
        )}
        {nonEmptyEvents.length > 0 && visibleEvents.length === 0 && (
          <div className="text-center pt-10 text-xs" style={{ color: appearance.muted }}>
            All output is hidden by the current filters.
          </div>
        )}
        {earlierCount > 0 && (
          <div className="text-center">
            <button
              type="button"
              onClick={() => setRenderLimit((n) => n + RENDER_WINDOW)}
              className="text-xs px-3 py-1 rounded-full border"
              style={{ borderColor: appearance.border, color: appearance.muted }}
            >
              Show {Math.min(RENDER_WINDOW, earlierCount)} earlier of {earlierCount} hidden
            </button>
          </div>
        )}
        {windowedEvents.map((e) => (
          <TranscriptItem key={e.id} event={e} appearance={appearance} codeSize={codeSize} />
        ))}

        {/* Pending permission prompts */}
        {permissions.map((p) => (
          <div key={p.requestId} className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 space-y-2">
            <div className="text-sm font-medium">{p.title}</div>
            {p.detail && (
              <pre
                className="font-mono whitespace-pre-wrap break-words rounded p-2 max-h-40 overflow-auto"
                style={{ backgroundColor: appearance.surfaceStrong, fontSize: codeSize }}
              >
                {p.detail}
              </pre>
            )}
            <div className="flex gap-2">
              <Button size="sm" className="h-7 gap-1" onClick={() => respond(p.requestId, 'approve-once')}>
                <Check className="h-3.5 w-3.5" /> Allow
              </Button>
              {p.canSession && (
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-7"
                  onClick={() => respond(p.requestId, 'approve-for-session')}
                >
                  Allow for session
                </Button>
              )}
              <Button size="sm" variant="ghost" className="h-7 gap-1" onClick={() => respond(p.requestId, 'reject')}>
                <XIcon className="h-3.5 w-3.5" /> Deny
              </Button>
            </div>
          </div>
        ))}

        {/* Exit-plan prompts (agent finished planning) */}
        {exitPlans.map((p) => (
          <div key={p.requestId} className="rounded-lg border border-sky-500/40 bg-sky-500/5 p-3 space-y-2">
            <div className="flex items-center gap-1.5 text-sm font-medium">
              <ClipboardList className="h-4 w-4 text-sky-500" /> Plan ready
            </div>
            {p.summary && <div className="text-xs whitespace-pre-wrap break-words">{p.summary}</div>}
            {p.planContent && (
              <pre
                className="whitespace-pre-wrap break-words rounded p-2 max-h-56 overflow-auto"
                style={{ backgroundColor: appearance.surfaceStrong, fontSize: codeSize }}
              >
                {p.planContent}
              </pre>
            )}
            <div className="flex flex-wrap gap-2">
              {p.actions.map((action) => (
                <Button
                  key={action}
                  size="sm"
                  className="h-7"
                  variant={action === p.recommended ? 'default' : 'secondary'}
                  onClick={() => respondExitPlan(p.requestId, action)}
                >
                  {EXIT_ACTION_LABELS[action] ?? action}
                </Button>
              ))}
              <Button size="sm" variant="ghost" className="h-7" onClick={() => respondExitPlan(p.requestId, 'reject')}>
                Keep planning
              </Button>
            </div>
          </div>
        ))}
      </div>

      {/* Composer */}
      <div className="border-t p-2 shrink-0" style={{ borderColor: appearance.border }}>
        {subcommandPrompt && (
          <div
            data-testid="subcommand-menu"
            className="mb-1 rounded-md border overflow-hidden"
            style={{ borderColor: appearance.border, backgroundColor: appearance.bg }}
          >
            <div
              className="flex items-center px-2 py-1 text-[11px]"
              style={{ color: appearance.muted, borderBottom: `1px solid ${appearance.border}` }}
            >
              <span>{subcommandPrompt.title || `/${subcommandPrompt.command}`}</span>
              <button
                type="button"
                className="ml-auto"
                style={{ color: appearance.muted }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setSubcommandPrompt(null);
                }}
              >
                <XIcon className="h-3 w-3" />
              </button>
            </div>
            {subcommandPrompt.options.map((o) => (
              <button
                key={o.name}
                type="button"
                data-testid={`subcommand-item-${o.name}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  chooseSubcommand(o);
                }}
                className="flex items-center gap-2 w-full px-2 py-1 text-left text-xs"
              >
                <span className="font-mono font-semibold">{o.name}</span>
                <span className="ml-auto" style={{ color: appearance.muted }}>
                  {o.description}
                </span>
              </button>
            ))}
          </div>
        )}
        {slashMatches.length > 0 && (
          <div
            data-testid="slash-menu"
            className="mb-1 rounded-md border overflow-hidden max-h-64 overflow-y-auto"
            style={{ borderColor: appearance.border, backgroundColor: appearance.bg }}
          >
            {slashMatches.map((c, i) => (
              <button
                key={c.name}
                type="button"
                data-testid={`slash-item-${c.name}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  chooseCommand(c);
                }}
                onMouseEnter={() => setSlashSel(i)}
                className="flex items-center gap-2 w-full px-2 py-1 text-left text-xs"
                style={{ backgroundColor: i === slashIndex ? appearance.surfaceStrong : 'transparent' }}
              >
                <span className="font-mono font-semibold">/{c.name}</span>
                {c.argHint && <span style={{ color: appearance.muted }}>{c.argHint}</span>}
                {KIND_LABEL[c.kind] && (
                  <span
                    className="rounded px-1 text-[9px] uppercase tracking-wide"
                    style={{ backgroundColor: appearance.surfaceStrong, color: appearance.muted }}
                  >
                    {KIND_LABEL[c.kind]}
                  </span>
                )}
                <span className="ml-auto truncate" style={{ color: appearance.muted }}>
                  {c.description}
                </span>
              </button>
            ))}
          </div>
        )}
        <div className="flex gap-2 items-end">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message Copilot… (/ for commands, Enter to send, Shift+Enter for newline)"
            rows={2}
            className="resize-none flex-1"
            style={{ fontFamily, fontSize }}
            disabled={!active && state !== 'open'}
          />
          {busy ? (
            <Button variant="destructive" size="icon" onClick={() => send({ type: 'cancel' })} title="Stop">
              <Square className="h-4 w-4" />
            </Button>
          ) : (
            <Button onClick={submit} disabled={!input.trim()} size="icon" title="Send">
              <Send className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {/* Mode indicator (bottom, like the CLI). Click or Shift+Tab to cycle. */}
      <button
        type="button"
        onClick={cycleMode}
        data-testid="agent-mode-indicator"
        className="flex items-center gap-1.5 px-3 py-1 border-t text-[11px] shrink-0 select-none"
        style={{ borderColor: appearance.border, backgroundColor: appearance.surface }}
        title="Cycle agent mode (Shift+Tab)"
      >
        {(() => {
          const Icon = MODE_META[mode].icon;
          return <Icon className="h-3.5 w-3.5" style={{ color: MODE_META[mode].color }} />;
        })()}
        <span className="font-semibold" style={{ color: MODE_META[mode].color }}>
          {MODE_META[mode].label}
        </span>
        <span style={{ color: appearance.muted }}>mode</span>
        <span className="ml-auto" style={{ color: appearance.muted }}>
          shift+tab to change
        </span>
      </button>
    </div>
  );
}

interface Appearance {
  theme: ReturnType<typeof getThemeByName>['theme'];
  fg: string;
  bg: string;
  accent: string;
  surface: string;
  surfaceStrong: string;
  border: string;
  muted: string;
}

const TranscriptItem = memo(function TranscriptItem({
  event,
  appearance,
  codeSize,
}: {
  event: AgentTranscriptEvent;
  appearance: Appearance;
  codeSize: number;
}) {
  if (event.kind === 'user') {
    return (
      <div className="flex flex-col items-end gap-0.5">
        <span className="text-[10px] uppercase tracking-wide px-1" style={{ color: appearance.muted }}>
          You
        </span>
        <div
          className="max-w-[85%] rounded-2xl rounded-br-sm px-4 py-2 whitespace-pre-wrap break-words"
          style={{ backgroundColor: appearance.accent, color: appearance.bg }}
        >
          {event.content}
        </div>
      </div>
    );
  }

  if (event.kind === 'assistant') {
    return (
      <div className="flex flex-col items-start gap-0.5">
        <span
          className="text-[10px] uppercase tracking-wide px-1 flex items-center gap-1"
          style={{ color: MODE_META.interactive.color }}
        >
          <MessageSquare className="h-3 w-3" />
          Copilot
        </span>
        <div
          className="max-w-[85%] rounded-2xl rounded-bl-sm px-4 py-2 overflow-hidden prose prose-sm dark:prose-invert max-w-none"
          style={{ backgroundColor: appearance.surface, color: appearance.fg }}
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{event.content || '…'}</ReactMarkdown>
        </div>
      </div>
    );
  }

  if (event.kind === 'reasoning') {
    return (
      <details className="text-xs" style={{ color: appearance.muted }}>
        <summary className="cursor-pointer select-none flex items-center gap-1">
          <Brain className="h-3 w-3" />
          Reasoning
        </summary>
        <div className="mt-1 whitespace-pre-wrap break-words pl-2 border-l" style={{ borderColor: appearance.border }}>
          {event.content}
        </div>
      </details>
    );
  }

  if (event.kind === 'system') {
    return (
      <details className="text-xs" style={{ color: appearance.muted }}>
        <summary className="cursor-pointer select-none flex items-center gap-1">
          <Cog className="h-3 w-3" />
          System message
        </summary>
        <div
          className="mt-1 whitespace-pre-wrap break-words pl-2 border-l font-mono"
          style={{ borderColor: appearance.border, fontSize: codeSize }}
        >
          {event.content}
        </div>
      </details>
    );
  }

  if (event.kind === 'tool') {
    return <ToolItem event={event} appearance={appearance} codeSize={codeSize} />;
  }

  if (event.kind === 'error') {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive whitespace-pre-wrap break-words">
        <span className="text-[10px] uppercase tracking-wide block mb-0.5 opacity-70">Error</span>
        {event.message}
      </div>
    );
  }

  // notice
  return (
    <div className="text-xs text-center italic" style={{ color: appearance.muted }}>
      {event.message}
    </div>
  );
});

const ToolItem = memo(function ToolItem({
  event,
  appearance,
  codeSize,
}: {
  event: Extract<AgentTranscriptEvent, { kind: 'tool' }>;
  appearance: Appearance;
  codeSize: number;
}) {
  const [open, setOpen] = useState(false);
  const argsText = useMemo(() => {
    if (event.args === undefined) return '';
    try {
      return typeof event.args === 'string' ? event.args : JSON.stringify(event.args, null, 2);
    } catch {
      return String(event.args);
    }
  }, [event.args]);

  const statusIcon =
    event.status === 'running' ? (
      <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-600" />
    ) : event.status === 'success' ? (
      <Check className="h-3.5 w-3.5 text-emerald-600" />
    ) : (
      <XIcon className="h-3.5 w-3.5 text-destructive" />
    );

  return (
    <div
      className="rounded-md border font-mono text-xs"
      style={{ backgroundColor: appearance.surface, borderColor: appearance.border }}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 w-full px-2 py-1.5 text-left"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <Wrench className="h-3.5 w-3.5" style={{ color: appearance.muted }} />
        <span className="font-semibold">{event.toolName}</span>
        <div className="flex-1" />
        {statusIcon}
      </button>
      {open && (
        <div className="px-2 pb-2 space-y-1">
          {argsText && (
            <pre
              className="whitespace-pre-wrap break-words rounded p-1.5 max-h-40 overflow-auto"
              style={{ backgroundColor: appearance.surfaceStrong, fontSize: codeSize }}
            >
              {argsText}
            </pre>
          )}
          {event.output && (
            <pre
              className="whitespace-pre-wrap break-words rounded p-1.5 max-h-64 overflow-auto"
              style={{ backgroundColor: appearance.surfaceStrong, fontSize: codeSize }}
            >
              {event.output}
            </pre>
          )}
        </div>
      )}
    </div>
  );
});
