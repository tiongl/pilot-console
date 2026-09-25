'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import RichMarkdown from '@/components/markdown/RichMarkdown';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useSpeechInput } from '@/hooks/useSpeechInput';
import ServerTab, { type ServerStatus } from './ServerTab';
import ArtifactTab, { type ArtifactStatus } from './ArtifactTab';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
  Share2,
  Copy,
  ExternalLink,
  ArrowDown,
  Search,
  ChevronUp,
  Coins,
  ListTree,
  Mic,
  MicOff,
  MessageCircleQuestion,
  Info,
} from 'lucide-react';
import { useAgentSocket } from '@/hooks/useAgentSocket';
import { getThemeByName } from '@/lib/terminal-themes';
import { readTranscript, writeTranscript } from '@/lib/transcript-cache';
import { readDraft, writeDraft } from '@/lib/composer-draft';
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
  AgentUsage,
} from '@/types';

interface Props {
  projectId?: string;
  worktreeId?: string;
  sessionId?: string;
  active: boolean;
  themeName?: string;
  fontFamily?: string;
  fontSize?: number;
  onSessionId?: (sessionId: string) => void;
  onStatusChange?: (status: string) => void;
  sessionKind?: 'agent' | 'project_lead' | 'chief_of_staff' | 'server' | 'artifact';
  /** Server-tab metadata (only used when sessionKind === 'server'). */
  serverId?: string;
  serverName?: string;
  serverCommand?: string;
  serverStatus?: ServerStatus;
  onServerDeleted?: () => void;
  /** Artifact-tab metadata (only used when sessionKind === 'artifact'). */
  artifactId?: string;
  artifactName?: string;
  artifactSessionKey?: string | null;
  artifactStatus?: ArtifactStatus;
  onArtifactDeleted?: () => void;
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
  reviewNote?: string;
}

interface AskUserPrompt {
  requestId: string;
  question: string;
  detail?: string;
  options: string[];
  allowText: boolean;
}

const MODE_ORDER: AgentMode[] = ['interactive', 'plan', 'autopilot'];

/**
 * An agent question answered by clicking. Kept as its own component so the
 * optional free-text box can hold its draft without re-rendering the transcript
 * on every keystroke.
 */
function AskUserCard({
  prompt,
  onAnswer,
  surface,
}: {
  prompt: AskUserPrompt;
  onAnswer: (requestId: string, answer: string) => void;
  surface: string;
}) {
  const [text, setText] = useState('');
  return (
    <div
      data-testid="ask-user-prompt"
      className="rounded-lg border border-violet-500/40 bg-violet-500/5 p-3 space-y-2"
    >
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <MessageCircleQuestion className="h-4 w-4 text-violet-500" />
        <span className="whitespace-pre-wrap break-words">{prompt.question}</span>
      </div>
      {prompt.detail && (
        <div
          className="text-xs whitespace-pre-wrap break-words rounded p-2"
          style={{ backgroundColor: surface }}
        >
          {prompt.detail}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {prompt.options.map((option, index) => (
          <Button
            key={`${option}:${index}`}
            size="sm"
            className="h-7"
            variant={index === 0 ? 'default' : 'secondary'}
            onClick={() => onAnswer(prompt.requestId, option)}
          >
            {option}
          </Button>
        ))}
      </div>
      {prompt.allowText && (
        <div className="flex gap-2">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                onAnswer(prompt.requestId, text);
              }
            }}
            placeholder="Or type an answer…"
            aria-label="Type an answer instead"
            className="flex-1 h-7 rounded border bg-transparent px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
          />
          <Button
            size="sm"
            variant="ghost"
            className="h-7"
            disabled={!text.trim()}
            onClick={() => onAnswer(prompt.requestId, text)}
          >
            Send
          </Button>
        </div>
      )}
    </div>
  );
}

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

/**
 * How close to the bottom still counts as "at the bottom" for auto-follow.
 * Generous on purpose: a line or two of slack keeps following after a nudge of
 * the wheel or a trackpad's inertia, which is what the eye expects.
 */
const NEAR_BOTTOM_PX = 120;

/** Bound live-streamed tool output kept in browser memory (matches the server). */
const clampToolOutput = (text: string): string =>
  text.length > MAX_TOOL_OUTPUT_CHARS
    ? text.slice(0, MAX_TOOL_OUTPUT_CHARS) + `\n… [truncated ${text.length - MAX_TOOL_OUTPUT_CHARS} chars]`
    : text;

// Optimistic user bubbles are minted client-side and painted before the server
// echoes the persisted `user.message`. The server assigns the real id from the
// SDK event, which the client cannot predict, so we tag the placeholder with
// this prefix and reconcile it away when the authoritative event arrives.
const OPTIMISTIC_USER_PREFIX = 'optimistic:user:';

/** Whether an id belongs to a not-yet-confirmed optimistic user bubble. */
const isOptimisticUserId = (id: string): boolean => id.startsWith(OPTIMISTIC_USER_PREFIX);

/** Whether a command should prompt for an argument before running. */const commandTakesArg = (c: AgentSlashCommand): boolean =>
  c.argRequired === true || !!c.argHint || !!(c.argChoices && c.argChoices.length);

const KIND_LABEL: Record<AgentSlashCommand['kind'], string> = {
  client: '',
  builtin: '',
  skill: 'skill',
};

/**
 * Transcript entry kinds the user can show/hide from the Agent tab. `user`,
 * `assistant` and `error` are core conversation and always shown; the rest are
 * "extra" output types (tool calls, model reasoning, notices).
 */
type FilterableKind = 'tool' | 'reasoning' | 'notice';

const FILTERABLE_KINDS: { kind: FilterableKind; label: string }[] = [
  { kind: 'tool', label: 'Tool calls' },
  { kind: 'reasoning', label: 'Reasoning' },
  { kind: 'notice', label: 'Notices' },
];

/**
 * Each filterable kind has a tri-state view mode:
 * - `show`  — render the full entry (full tool card, expanded reasoning, full notice).
 * - `badge` — render a compact badge only (tool-badges strip, brain badge, notice badge).
 * - `hide`  — drop the entry entirely, leaving no badge or strip behind.
 */
type ViewMode = 'show' | 'badge' | 'hide';

const VIEW_MODES: { mode: ViewMode; label: string }[] = [
  { mode: 'show', label: 'Show' },
  { mode: 'badge', label: 'Badge' },
  { mode: 'hide', label: 'Hide' },
];

/**
 * `toolOutput` is a sub-filter of `tool`: it hides just the result body of a
 * tool call while the call itself (name, args, status) stays visible. It is
 * only meaningful when `tool === 'show'` (a badged or hidden tool has no body
 * to reveal), so the control is disabled otherwise.
 */
type Visibility = Record<FilterableKind, ViewMode> & { toolOutput: boolean };

/** A transcript row: either one entry, or a run of collapsed tool calls. */
type RenderItem =
  | { type: 'event'; key: string; event: AgentTranscriptEvent }
  | { type: 'tool-badges'; key: string; tools: Extract<AgentTranscriptEvent, { kind: 'tool' }>[] };

/** How long the first Escape stays "armed" before the stop prompt expires. */
const ESCAPE_CONFIRM_MS = 3_000;

const DEFAULT_VISIBILITY: Visibility = {
  tool: 'show',
  reasoning: 'show',
  notice: 'show',
  toolOutput: true,
};

/**
 * v2 stores the tri-state payload. The old v1 key held a per-kind boolean shape;
 * it is read once on load to migrate existing users, then superseded by v2.
 */
const VISIBILITY_LS_KEY = 'pilot-console-agent-visibility-v2';
const VISIBILITY_LS_KEY_V1 = 'pilot-console-agent-visibility';

/**
 * The runtime's task-completion tool. Its "argument" is the agent's closing
 * summary for the turn, so it is prose we always want to read — never a
 * collapsed badge.
 */
function isTaskComplete(toolName: string): boolean {
  return toolName === 'task_complete' || toolName === 'taskComplete';
}

/** The agent's closing summary text carried by a `task_complete` call. */
function taskCompleteSummary(event: Extract<AgentTranscriptEvent, { kind: 'tool' }>): string {
  const record = parseToolArgs(event.args);
  const fromArgs = typeof record?.summary === 'string' ? record.summary : undefined;
  return (fromArgs || event.output || '').trim();
}

/** One row in the conversation outline. */
interface OutlineItem {
  /** Matches the `RenderItem` key of the underlying transcript row. */
  key: string;
  role: 'user' | 'assistant';
  text: string;
  ts: number;
}

/**
 * Reduce a transcript to its skeleton: every user request, and the *final*
 * assistant response of the turn it started.
 *
 * Intermediate assistant chatter ("let me check…") is dropped — only the last
 * response before the next request survives, which is what makes the outline a
 * readable table of contents rather than a shorter transcript. A
 * `task_complete` summary supersedes the assistant message before it, since it
 * is the agent's actual closing word on the turn.
 */
function buildOutline(events: AgentTranscriptEvent[]): OutlineItem[] {
  const items: OutlineItem[] = [];
  let pending: OutlineItem | null = null;
  const flush = () => {
    if (pending) items.push(pending);
    pending = null;
  };

  for (const e of events) {
    if (e.kind === 'user') {
      flush();
      items.push({ key: e.id, role: 'user', text: e.content, ts: e.ts });
    } else if (e.kind === 'assistant' && e.content.trim()) {
      pending = { key: e.id, role: 'assistant', text: e.content, ts: e.ts };
    } else if (e.kind === 'tool' && isTaskComplete(e.toolName)) {
      const text = taskCompleteSummary(e);
      if (text) pending = { key: e.id, role: 'assistant', text, ts: e.ts };
    }
  }
  flush();
  return items;
}

/** First meaningful line of a message, trimmed for a one-line outline row. */
function outlinePreview(text: string): string {
  const line = text
    .split('\n')
    .map((l) => l.replace(/^[#>\-*\s]+/, '').trim())
    .find((l) => l.length > 0);
  const clean = (line ?? text).trim();
  return clean.length > 140 ? `${clean.slice(0, 139)}…` : clean;
}

/** Lowercased haystack for in-transcript search. */
function searchableText(event: AgentTranscriptEvent): string {
  const parts: string[] = [];
  switch (event.kind) {
    case 'user':
    case 'assistant':
    case 'reasoning':
    case 'system':
      parts.push(event.content);
      break;
    case 'tool':
      parts.push(event.toolName, event.output ?? '', event.progress ?? '');
      if (event.args !== undefined) {
        try {
          parts.push(typeof event.args === 'string' ? event.args : JSON.stringify(event.args));
        } catch {
          /* unserializable args are simply not searchable */
        }
      }
      break;
    default:
      parts.push(event.message);
      break;
  }
  return parts.join('\n').toLowerCase();
}

/** Escape a value for use inside a CSS attribute selector. */
function cssEscape(value: string): string {
  const fn = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS?.escape;
  return fn ? fn(value) : value.replace(/["\\]/g, '\\$&');
}

/** Compact token counts: 1234 → "1.2k", 1234567 → "1.2M". */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

/**
 * Nano-AI units → a readable AIU figure. CAPI bills in nano-units (1e-9), so
 * even a long session lands in the small-fraction range.
 */
function formatAiu(nanoAiu: number): string {
  const aiu = nanoAiu / 1e9;
  if (aiu === 0) return '0';
  if (aiu < 0.001) return aiu.toExponential(1);
  return aiu.toFixed(aiu < 1 ? 4 : 2);
}

function isDarkHexColor(color: string): boolean {
  const match = color.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!match) return true;
  const hex = match[1].length === 3
    ? match[1].split('').map((c) => c + c).join('')
    : match[1];
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) < 140;
}

function sanitizeMode(value: unknown): ViewMode | undefined {
  return value === 'show' || value === 'badge' || value === 'hide' ? value : undefined;
}

/**
 * Migrate the old v1 boolean payload to the tri-state model, reproducing today's
 * exact behavior for existing users:
 * - old `true`  → `'show'`
 * - old `false` → `'badge'` for tool & reasoning (they collapsed to a badge),
 *                 `'hide'` for notice (it was dropped entirely)
 */
function migrateV1(raw: string): Visibility {
  const parsed = JSON.parse(raw) as Partial<Record<FilterableKind, boolean>> & { toolOutput?: boolean };
  const kindMode = (kind: FilterableKind, hiddenMode: ViewMode): ViewMode =>
    parsed[kind] === false ? hiddenMode : 'show';
  return {
    tool: kindMode('tool', 'badge'),
    reasoning: kindMode('reasoning', 'badge'),
    notice: kindMode('notice', 'hide'),
    toolOutput: parsed.toolOutput ?? true,
  };
}

function loadVisibility(): Visibility {
  try {
    const raw = localStorage.getItem(VISIBILITY_LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Visibility>;
      return {
        tool: sanitizeMode(parsed.tool) ?? 'show',
        reasoning: sanitizeMode(parsed.reasoning) ?? 'show',
        notice: sanitizeMode(parsed.notice) ?? 'show',
        toolOutput: parsed.toolOutput ?? true,
      };
    }
    // No v2 payload yet — migrate the old boolean shape if present.
    const legacy = localStorage.getItem(VISIBILITY_LS_KEY_V1);
    if (legacy) return migrateV1(legacy);
    return { ...DEFAULT_VISIBILITY };
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
  sessionKind = 'agent',
  serverId,
  serverName,
  serverCommand,
  serverStatus,
  onServerDeleted,
  artifactId,
  artifactName,
  artifactSessionKey,
  artifactStatus,
  onArtifactDeleted,
}: Props) {
  // Server tabs render a live console instead of the agent transcript. This
  // early return runs before any hook, so a given instance (fixed sessionKind)
  // consistently takes the same branch — keeping the rules of hooks intact.
  if (sessionKind === 'server' && serverId) {
    return (
      <ServerTab
        serverId={serverId}
        name={serverName ?? 'Server'}
        command={serverCommand ?? ''}
        initialStatus={serverStatus}
        active={active}
        fontFamily={fontFamily}
        fontSize={fontSize}
        themeName={themeName}
        onDeleted={onServerDeleted}
      />
    );
  }

  // Artifact tabs embed a live Lavish session iframe. Same rules-of-hooks note
  // as the server branch above.
  if (sessionKind === 'artifact' && artifactId) {
    return (
      <ArtifactTab
        artifactId={artifactId}
        name={artifactName ?? 'Artifact'}
        sessionKey={artifactSessionKey}
        initialStatus={artifactStatus}
        active={active}
        onDeleted={onArtifactDeleted}
      />
    );
  }

  // Captures the session id this pane was opened for (if any). Reopening an
  // existing session has an id here; a brand-new session does not. Held in a
  // ref so the "hydrating" and cache-seed logic keys off the *initial* id and
  // is unaffected by a later prop identity change.
  const initialSessionIdRef = useRef(sessionId);
  // Optimistic paint: seed the transcript from the browser cache so reopening a
  // session shows its previous conversation immediately instead of a blank gap.
  // The authoritative `replay` replaces this wholesale when it arrives.
  const cachedInitial = useMemo(
    () => (initialSessionIdRef.current ? readTranscript(initialSessionIdRef.current) : null),
    [],
  );

  const [events, setEvents] = useState<AgentTranscriptEvent[]>(() => cachedInitial ?? []);
  // Whether the first authoritative `replay` for this session has landed. Until
  // it does, an existing (reopened) session is "hydrating" — never show the
  // new-session empty text for it.
  const [replayReceived, setReplayReceived] = useState(false);
  // Older events stay on the server until the user asks for them, so a long
  // conversation does not ship its whole history on connect.
  const [hasEarlier, setHasEarlier] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  // Only render the most recent `renderLimit` items to bound DOM size; older
  // items stay in state (and scroll history) but are revealed on demand.
  const [renderLimit, setRenderLimit] = useState(RENDER_WINDOW);
  const [status, setStatus] = useState<AgentStatus>('idle');
  /** Follow-ups typed mid-turn, held server-side until the current turn ends. */
  const [queued, setQueued] = useState<string[]>([]);
  /**
   * Wall-clock start of the in-flight turn. Set optimistically the moment the
   * user submits so the progress timer covers the full request → completion
   * round trip, then reconciled from the server's authoritative value.
   */
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  const [model, setModel] = useState('auto');
  const [mode, setMode] = useState<AgentMode>('interactive');
  const [permissions, setPermissions] = useState<PermissionPrompt[]>([]);
  const [exitPlans, setExitPlans] = useState<ExitPlanPrompt[]>([]);
  /** Click-to-answer questions raised by the agent's `ask_user` tool. */
  const [questions, setQuestions] = useState<AskUserPrompt[]>([]);
  const [models, setModels] = useState<AgentModelOption[]>([{ id: 'auto', name: 'Auto' }]);
  const [connError, setConnError] = useState<string | null>(null);
  // Restore any persisted draft so a refresh/reload doesn't lose a typed-but-
  // unsent message. Seeded from storage on mount (mirrors the transcript cache
  // seed); a session switch re-restores below.
  const [input, setInput] = useState(() => (sessionId ? readDraft(sessionId) ?? '' : ''));
  /**
   * Text already in the composer when dictation started. Speech is appended to
   * it so starting the mic never wipes a partially typed message.
   */
  const dictationBaseRef = useRef('');
  const speech = useSpeechInput({
    onTranscript: useCallback((text: string) => {
      const base = dictationBaseRef.current;
      const separator = base && !/\s$/.test(base) ? ' ' : '';
      setInput(text ? base + separator + text : base);
    }, []),
  });
  const toggleDictation = useCallback(() => {
    if (!speech.listening) dictationBaseRef.current = input;
    speech.toggle();
  }, [speech, input]);
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
  // "Allow everything": the session auto-approves every permission request.
  const [allowAll, setAllowAll] = useState(false);
  // Terminal-style stop confirmation: the first Escape arms it, a second
  // Escape (within the window) actually cancels the turn.
  const [stopArmed, setStopArmed] = useState(false);
  // Accumulated token/billing usage for this session.
  const [usage, setUsage] = useState<AgentUsage | null>(null);
  const [usageOpen, setUsageOpen] = useState(false);
  // In-transcript search.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchIndex, setSearchIndex] = useState(0);
  // Outline mode: just the requests and the final response of each turn.
  const [outline, setOutline] = useState(false);
  // Row the user jumped to from the outline, highlighted until they scroll on.
  const [jumpKey, setJumpKey] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  // Drives the jump-to-bottom affordance. `atBottomRef` is deliberately a ref
  // (it is read inside scroll handlers on every frame); this mirrors it into
  // render state only when the answer actually changes.
  const [atBottom, setAtBottom] = useState(true);

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

  // Monotonic counter so multiple optimistic bubbles minted within the same
  // millisecond still get distinct ids.
  const optimisticSeqRef = useRef(0);
  const mintOptimisticUserId = useCallback(
    () => `${OPTIMISTIC_USER_PREFIX}${Date.now()}:${optimisticSeqRef.current++}`,
    [],
  );

  // Reconcile the server's authoritative user event with any optimistic bubble
  // we already painted, so the message never double-renders. The echoed id is
  // SDK-assigned (unpredictable client-side), so we pair by content+role against
  // the oldest unconfirmed optimistic entry and replace it in place — preserving
  // ordering while adopting the real id/ts.
  const reconcileUserEvent = useCallback((event: Extract<AgentTranscriptEvent, { kind: 'user' }>) => {
    setEvents((prev) => {
      const byId = prev.findIndex((e) => e.id === event.id);
      if (byId >= 0) {
        const next = prev.slice();
        next[byId] = event;
        return next;
      }
      const optIdx = prev.findIndex(
        (e) => e.kind === 'user' && isOptimisticUserId(e.id) && e.content === event.content,
      );
      if (optIdx >= 0) {
        const next = prev.slice();
        next[optIdx] = event;
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
        next[idx] = { ...entry, output: clampToolOutput((entry.output ?? '') + delta) };
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
          setTurnStartedAt(msg.status === 'busy' ? (msg.turnStartedAt ?? Date.now()) : null);
          setConnError(null);
          break;
        case 'replay':
          setEvents(msg.events.filter((e) => e.kind !== 'system'));
          setReplayReceived(true);
          setHasEarlier(msg.hasMore ?? false);
          setLoadingEarlier(false);
          setRenderLimit(RENDER_WINDOW);
          // A replay is a fresh render of the whole conversation (first
          // connect, reconnect, or a manual refresh) — always land at the end.
          atBottomRef.current = true;
          setAtBottom(true);
          break;
        case 'earlier': {
          const older = msg.events.filter((e) => e.kind !== 'system');
          setHasEarlier(msg.hasMore);
          setLoadingEarlier(false);
          if (older.length === 0) break;
          setEvents((prev) => [...older, ...prev]);
          // Reveal what was just fetched instead of hiding it behind another
          // click, and stay where the user was reading rather than jumping.
          setRenderLimit((n) => n + older.length);
          break;
        }
        case 'event':
          if (msg.event.kind === 'user') reconcileUserEvent(msg.event);
          else if (msg.event.kind !== 'system') upsert(msg.event);
          break;
        case 'assistant_delta':
          applyDelta(msg.id, msg.delta, 'assistant');
          break;
        case 'tool_delta':
          applyDelta(msg.id, msg.delta, 'tool');
          break;
        case 'tool_output':
          setEvents((prev) => {
            const idx = prev.findIndex((e) => e.id === msg.id);
            if (idx < 0) return prev;
            const entry = prev[idx];
            if (entry.kind !== 'tool') return prev;
            const next = prev.slice();
            next[idx] = { ...entry, output: clampToolOutput(msg.output) };
            return next;
          });
          break;
        case 'status':
          setStatus(msg.status);
          // Keep an optimistic local start time if the server has not sent one
          // yet — never restart the clock mid-turn.
          setTurnStartedAt((prev) =>
            msg.status === 'busy' ? (msg.turnStartedAt ?? prev ?? Date.now()) : null,
          );
          break;
        case 'model':
          setModel(msg.model);
          break;
        case 'queued':
          setQueued(msg.prompts);
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
        case 'usage':
          setUsage(msg.usage);
          break;
        case 'allow_all':
          setAllowAll(msg.enabled);
          break;
        case 'permission_request':
          setPermissions((prev) => {
            const prompt = {
              requestId: msg.requestId,
              title: msg.title,
              detail: msg.detail,
              canSession: msg.canSession,
            };
            const idx = prev.findIndex((item) => item.requestId === msg.requestId);
            if (idx < 0) return [...prev, prompt];
            const next = prev.slice();
            next[idx] = prompt;
            return next;
          });
          break;
        case 'permission_resolved':
          setPermissions((prev) => prev.filter((p) => p.requestId !== msg.requestId));
          break;
        case 'exit_plan_request':
          setExitPlans((prev) => {
            const prompt = {
              requestId: msg.requestId,
              summary: msg.summary,
              planContent: msg.planContent,
              actions: msg.actions,
              recommended: msg.recommended,
            };
            const idx = prev.findIndex((item) => item.requestId === msg.requestId);
            if (idx < 0) return [...prev, prompt];
            const next = prev.slice();
            next[idx] = prompt;
            return next;
          });
          break;
        case 'exit_plan_resolved':
          setExitPlans((prev) => prev.filter((p) => p.requestId !== msg.requestId));
          break;
        case 'ask_user_request':
          setQuestions((prev) => {
            const prompt = {
              requestId: msg.requestId,
              question: msg.question,
              detail: msg.detail,
              options: msg.options,
              allowText: msg.allowText,
            };
            const idx = prev.findIndex((item) => item.requestId === msg.requestId);
            if (idx < 0) return [...prev, prompt];
            const next = prev.slice();
            next[idx] = prompt;
            return next;
          });
          break;
        case 'ask_user_resolved':
          setQuestions((prev) => prev.filter((p) => p.requestId !== msg.requestId));
          break;
        case 'error':
          setConnError(msg.message);
          break;
      }
    },
    [upsert, applyDelta, reconcileUserEvent],
  );

  // The real session id, known immediately for a reopened session and after
  // `onReady` for a brand-new one. Drives the debounced transcript cache write.
  const sessionIdRef = useRef<string | null>(sessionId ?? null);
  const handleReady = useCallback(
    (id: string) => {
      sessionIdRef.current = id;
      onSessionId?.(id);
    },
    [onSessionId],
  );

  const { state, send, reset, switchTo, reconnect } = useAgentSocket({
    projectId,
    worktreeId,
    sessionId,
    forceNew: !sessionId && sessionKind === 'agent',
    model,
    kind: sessionKind,
    onMessage: handleMessage,
    onReady: handleReady,
  });

  // Persist the settled transcript to the browser cache (debounced) so the next
  // reopen can paint it instantly. Keyed by the real session id, so we wait
  // until one is known. `system` events are dropped inside writeTranscript.
  useEffect(() => {
    const id = sessionIdRef.current;
    if (!id) return;
    const timer = setTimeout(() => writeTranscript(id, events), 500);
    return () => clearTimeout(timer);
  }, [events]);

  // Mirror the composer's unsent contents into per-session storage so a refresh
  // restores the draft. Writing an empty string clears it, so the persisted
  // draft vanishes the moment the message is sent (or the composer is emptied).
  useEffect(() => {
    if (!sessionId) return;
    writeDraft(sessionId, input);
  }, [input, sessionId]);

  // Re-restore the draft when the active session changes without a remount.
  // Never clobber text the user is actively typing — only fill an empty composer.
  const draftSessionRef = useRef(sessionId);
  useEffect(() => {
    if (draftSessionRef.current === sessionId) return;
    draftSessionRef.current = sessionId;
    setInput((cur) => (cur ? cur : sessionId ? readDraft(sessionId) ?? '' : ''));
  }, [sessionId]);

  useEffect(() => {
    // Report a connection-oriented status for the tab indicator dot.
    const s = state === 'open' ? (status === 'busy' ? 'busy' : 'open') : state === 'connecting' ? 'connecting' : 'closed';
    onStatusChange?.(s);
  }, [state, status, onStatusChange]);

  // Fetch available models for the picker. The runtime starts lazily, so the
  // first request can land before it is ready and come back with only the
  // placeholder "Auto" — retry with backoff instead of leaving the picker
  // stuck there for the life of the tab.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const load = (attempt: number) => {
      fetch('/api/agent/models')
        .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
        .then(({ ok, data }) => {
          if (cancelled) return;
          const list = Array.isArray(data?.models) ? (data.models as AgentModelOption[]) : [];
          if (list.length) setModels(list);
          const degraded = !ok || data?.degraded || list.length <= 1;
          if (degraded && attempt < 5) {
            timer = setTimeout(() => load(attempt + 1), Math.min(8_000, 1_000 * 2 ** attempt));
          }
        })
        .catch(() => {
          if (cancelled || attempt >= 5) return;
          timer = setTimeout(() => load(attempt + 1), Math.min(8_000, 1_000 * 2 ** attempt));
        });
    };

    load(0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Auto-scroll to bottom when new content arrives, unless the user scrolled up.
  useEffect(() => {
    if (atBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events, visibility, permissions, exitPlans, questions]);

  /**
   * Keep following the bottom as the content settles.
   *
   * The effect above only runs on commit, but plenty of height arrives later:
   * markdown re-layout, diagrams, images, wrapped code. That late growth fires
   * no scroll event, so the transcript drifted above the bottom while we still
   * believed we were sitting on it — no auto-scroll, and no affordance either,
   * because nothing told us we had fallen behind. Watching the subtree catches
   * every one of those, and the frame coalesces a burst of streamed deltas into
   * a single scroll.
   */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let frame = 0;
    const pin = () => {
      if (!atBottomRef.current) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (atBottomRef.current) el.scrollTop = el.scrollHeight;
      });
    };
    const mo = new MutationObserver(pin);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(pin);
    ro?.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      mo.disconnect();
      ro?.disconnect();
    };
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    atBottomRef.current = true;
    setAtBottom(true);
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    atBottomRef.current = bottom;
    setAtBottom((prev) => (prev === bottom ? prev : bottom));
  };

  // Persist visibility preferences across sessions/reloads.
  useEffect(() => {
    try {
      localStorage.setItem(VISIBILITY_LS_KEY, JSON.stringify(visibility));
    } catch {
      /* quota exceeded — ignore */
    }
  }, [visibility]);

  const setViewMode = useCallback((kind: FilterableKind, mode: ViewMode) => {
    setVisibility((prev) => ({ ...prev, [kind]: mode }));
  }, []);

  const toggleToolOutput = useCallback(() => {
    setVisibility((prev) => ({ ...prev, toolOutput: !prev.toolOutput }));
  }, []);

  const copyShareUrl = useCallback((url: string) => {
    void navigator.clipboard?.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, []);

  // Transcript filtered by the current visibility preferences. Assistant
  // entries with no text are dropped so a turn that produced only tool calls
  // never renders a stray placeholder bubble. Hidden tool calls are not
  // dropped outright — consecutive ones collapse into a strip of mini badges
  // so a long-running tool never looks like the agent has hung.
  const renderItems = useMemo(() => {
    const items: RenderItem[] = [];
    const renderedReasoningIds = new Set<string>();

    for (let i = 0; i < events.length; i++) {
      const e = events[i];

      if (e.kind === 'assistant') {
        // Reason appears before the message it explains (thinking happens first).
        // If there's reasoning immediately before this assistant message that hasn't
        // been rendered yet, render it first — unless reasoning is hidden entirely.
        if (
          i > 0 &&
          events[i - 1].kind === 'reasoning' &&
          !renderedReasoningIds.has(events[i - 1].id) &&
          visibility.reasoning !== 'hide'
        ) {
          const reasoning = events[i - 1];
          items.push({ type: 'event', key: reasoning.id, event: reasoning });
          renderedReasoningIds.add(reasoning.id);
        }

        if (e.content.trim().length > 0) items.push({ type: 'event', key: e.id, event: e });
        continue;
      }

      // Reasoning: `hide` drops it entirely; `badge`/`show` flow through as events
      // (ReasoningItem collapses to a brain badge when the mode is `badge`).
      if (e.kind === 'reasoning') {
        if (visibility.reasoning === 'hide') continue;
        // Skip reasoning events that come right before an assistant (handled above)
        if (i + 1 < events.length && events[i + 1].kind === 'assistant' && !renderedReasoningIds.has(e.id)) {
          // This will be handled by the assistant case above, so skip it here
          continue;
        }
        // Reasoning that doesn't immediately precede an assistant still renders normally
        if (!renderedReasoningIds.has(e.id)) {
          items.push({ type: 'event', key: e.id, event: e });
          renderedReasoningIds.add(e.id);
        }
        continue;
      }

      // The final "task complete" summary is the agent's closing statement, not
      // incidental tool chatter — it always renders in full, whatever the tool
      // filters say.
      if (e.kind === 'tool' && isTaskComplete(e.toolName)) {
        items.push({ type: 'event', key: e.id, event: e });
        continue;
      }
      // Tool calls: `hide` drops them, `badge` collapses consecutive ones into a
      // strip of mini badges (so a long-running tool never looks like a hang),
      // `show` renders the full card.
      if (e.kind === 'tool') {
        if (visibility.tool === 'hide') continue;
        if (visibility.tool === 'badge') {
          const last = items[items.length - 1];
          if (last && last.type === 'tool-badges') last.tools.push(e);
          else items.push({ type: 'tool-badges', key: `badges:${e.id}`, tools: [e] });
          continue;
        }
      }
      // Notices: `hide` drops them, `badge`/`show` still flow through as events —
      // the render mode passed to TranscriptItem decides badge vs full.
      if (e.kind === 'notice' && visibility.notice === 'hide') {
        continue;
      }
      items.push({ type: 'event', key: e.id, event: e });
    }
    return items;
  }, [events, visibility]);

  // Only render the most recent `renderLimit` items to bound DOM size; older
  // items stay in state (and scroll history) but are revealed on demand.
  const windowedItems =
    renderItems.length > renderLimit ? renderItems.slice(-renderLimit) : renderItems;
  const earlierCount = renderItems.length - windowedItems.length;

  // --- Outline -------------------------------------------------------------
  const outlineItems = useMemo(() => buildOutline(events), [events]);

  /**
   * Leave the outline and land on the row the user picked. The scroll cannot
   * happen here — the transcript is not mounted until the outline is off — so
   * it is deferred to an effect keyed on `jumpKey`.
   */
  const jumpToOutlineItem = useCallback((key: string) => {
    setOutline(false);
    setJumpKey(key);
  }, []);

  useEffect(() => {
    if (outline || !jumpKey || !scrollRef.current) return;
    const el = scrollRef.current.querySelector(`[data-entry-key="${cssEscape(jumpKey)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    // The row is no longer the "latest", so suppress the auto-scroll that would
    // otherwise yank the user back down on the next streamed token.
    atBottomRef.current = false;
    setAtBottom(false);
    const timer = setTimeout(() => setJumpKey(null), 2_000);
    return () => clearTimeout(timer);
  }, [outline, jumpKey, renderItems]);

  // --- In-transcript search ------------------------------------------------
  // Matching is done over the *rendered* rows so hidden output is never a
  // phantom hit, and navigation scrolls the matching row into view.
  const searchMatches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [] as string[];
    return renderItems
      .filter((item) =>
        item.type === 'event'
          ? searchableText(item.event).includes(q)
          : item.tools.some((t) => searchableText(t).includes(q)),
      )
      .map((item) => item.key);
  }, [renderItems, searchQuery]);

  const activeMatchKey = searchMatches.length ? searchMatches[searchIndex % searchMatches.length] : null;

  useEffect(() => {
    setSearchIndex(0);
  }, [searchQuery]);

  useEffect(() => {
    if (!activeMatchKey || !scrollRef.current) return;
    const el = scrollRef.current.querySelector(`[data-entry-key="${cssEscape(activeMatchKey)}"]`);
    el?.scrollIntoView({ block: 'center' });
  }, [activeMatchKey]);

  const stepSearch = useCallback(
    (delta: number) => {
      setSearchIndex((prev) => {
        const total = searchMatches.length;
        if (total === 0) return 0;
        return (prev + delta + total) % total;
      });
    },
    [searchMatches.length],
  );

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery('');
    setSearchIndex(0);
  }, []);

  // `hiddenCount` counts events with no visible trace: kinds set to `'hide'`
  // (dropped entirely) plus tool bodies suppressed by the `toolOutput` sub-filter.
  // Badged entries still show a badge, so they are deliberately NOT counted as
  // hidden — the badge keeps them present in the transcript.
  const hiddenCount = useMemo(
    () =>
      events.filter((e) => {
        if (e.kind === 'tool') {
          if (isTaskComplete(e.toolName)) return false;
          return visibility.tool === 'hide' || (visibility.toolOutput === false && Boolean(e.output));
        }
        if (e.kind === 'reasoning') return visibility.reasoning === 'hide';
        if (e.kind === 'notice') return visibility.notice === 'hide';
        return false;
      }).length,
    [events, visibility],
  );
  const anyHidden = FILTERABLE_KINDS.some((f) => visibility[f.kind] !== 'show') || !visibility.toolOutput;

  const respond = (
    requestId: string,
    decision: 'approve-once' | 'approve-for-session' | 'approve-all' | 'reject',
  ) => {
    send({ type: 'permission_response', requestId, decision });
    if (decision === 'approve-all') {
      // Optimistic: the server also broadcasts `allow_all` and drains the queue.
      setAllowAll(true);
      setPermissions([]);
      return;
    }
    setPermissions((prev) => prev.filter((p) => p.requestId !== requestId));
  };

  /** Toggle session-wide auto-approval, independent of the agent mode. */
  const toggleAllowAll = (enabled: boolean) => {
    setAllowAll(enabled);
    if (enabled) setPermissions([]);
    send({ type: 'set_allow_all', enabled });
  };

  const changeModel = (m: string) => {
    setModel(m);
    send({ type: 'set_model', model: m });
  };

  // Maps model ids to display names so the trigger shows "GPT-5.6 Sol"
  // rather than the raw id the session actually runs on.
  const modelItems = useMemo(
    () => models.map((m) => ({ value: m.id, label: m.name })),
    [models],
  );

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

  const respondAskUser = (requestId: string, answer: string) => {
    const trimmed = answer.trim();
    if (!trimmed) return;
    send({ type: 'ask_user_response', requestId, answer: trimmed });
    setQuestions((prev) => prev.filter((p) => p.requestId !== requestId));
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
    setHasEarlier(false);
    setLoadingEarlier(false);
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
    setHasEarlier(false);
    setLoadingEarlier(false);
    setPermissions([]);
    setExitPlans([]);
    setQueued([]);
    setQuestions([]);
    setConnError(null);
    onSessionId?.(id);
    switchTo(id);
  };

  const submit = () => {
    const trimmed = input.trim();
    if (!trimmed) return;
    // Sending ends the utterance; leaving the mic hot would dictate the next
    // message into an empty composer without the user asking.
    if (speech.listening) speech.stop();
    if (trimmed.startsWith('/')) {
      executeSlash(trimmed);
      setInput('');
      setSlashSel(0);
      return;
    }
    // A pending ask_user call is blocking the agent's turn, so a normal send
    // would queue behind a turn that can never end. Route the typed text to the
    // question instead: the buttons are a shortcut, never a gate on typing.
    const awaiting = questions[0];
    if (awaiting) {
      respondAskUser(awaiting.requestId, trimmed);
      setInput('');
      atBottomRef.current = true;
      return;
    }
    send({ type: 'send', prompt: trimmed });
    // Paint the user's bubble immediately instead of waiting for the server to
    // persist and echo it back (a visible lag on remote/loaded hosts). The
    // placeholder carries an optimistic id; `reconcileUserEvent` replaces it in
    // place when the authoritative `user.message` arrives, so it never dupes.
    upsert({ kind: 'user', id: mintOptimisticUserId(), ts: Date.now(), content: trimmed });
    // Only anchor the clock when this prompt starts a turn; a follow-up typed
    // mid-turn is queued server-side and must not restart the running timer.
    if (status !== 'busy') setTurnStartedAt(Date.now());
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

  // Ctrl/⌘+F opens the in-transcript search, matching the browser's own
  // find-in-page muscle memory (which cannot see virtualized/collapsed rows).
  useEffect(() => {
    if (!active) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key.toLowerCase() === 'f' && (e.ctrlKey || e.metaKey) && !e.altKey) {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [active]);

  const activeTool = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event.kind === 'tool' && event.status === 'running') {
        return event as Extract<AgentTranscriptEvent, { kind: 'tool' }>;
      }
    }
    return undefined;
  }, [events]);
  const busy = status === 'busy' || Boolean(activeTool) || permissions.length > 0 || exitPlans.length > 0;

  // `busy` can also be driven by a running tool or a pending prompt with no
  // status message of its own — anchor the turn clock in those cases too, and
  // release it the moment the turn completes.
  useEffect(() => {
    setTurnStartedAt((prev) => (busy ? (prev ?? Date.now()) : null));
  }, [busy]);

  // --- Escape-to-stop (terminal-style double press) ------------------------
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const disarmStop = useCallback(() => {
    if (stopTimerRef.current) {
      clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }
    setStopArmed(false);
  }, []);

  const confirmStop = useCallback(() => {
    disarmStop();
    send({ type: 'cancel' });
    pushNotice('Stopped by user.');
  }, [disarmStop, send, pushNotice]);

  const armStop = useCallback(() => {
    if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
    setStopArmed(true);
    stopTimerRef.current = setTimeout(() => {
      stopTimerRef.current = null;
      setStopArmed(false);
    }, ESCAPE_CONFIRM_MS);
  }, []);

  // Nothing to stop once the turn ends — drop the pending confirmation.
  useEffect(() => {
    if (!busy) disarmStop();
  }, [busy, disarmStop]);

  useEffect(() => () => {
    if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
  }, []);

  const anyOverlayOpen =
    Boolean(subcommandPrompt) ||
    Boolean(sessionList) ||
    Boolean(diffPanel) ||
    filterOpen ||
    shareOpen ||
    slashMatches.length > 0;

  useEffect(() => {
    if (!active) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Overlays and the slash menu own Escape while they are open.
      if (anyOverlayOpen) return;
      if (!busy) return;
      e.preventDefault();
      if (stopArmed) confirmStop();
      else armStop();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [active, anyOverlayOpen, busy, stopArmed, armStop, confirmStop]);

  const statusLabel = useMemo(() => {
    if (state !== 'open') return state === 'connecting' ? 'connecting…' : 'disconnected';
    if (permissions.length > 0) return 'waiting for permission…';
    if (exitPlans.length > 0) return 'waiting for plan decision…';
    if (activeTool) return `${activeTool.toolName} running…`;
    return busy ? 'working…' : 'ready';
  }, [state, busy, activeTool, permissions.length, exitPlans.length]);

  // An existing (reopened) session is "hydrating" until its first authoritative
  // replay lands. Drives the empty-state so a reopened session shows a loading
  // indicator instead of the new-session "Start a conversation…" text.
  const hydrating = Boolean(initialSessionIdRef.current) && !replayReceived;
  // We painted the cached transcript but the fresh replay hasn't reconciled yet.
  const showingCached = Boolean(cachedInitial) && !replayReceived;

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
        className="flex flex-wrap items-center gap-2 px-3 py-1.5 border-b shrink-0"
        style={{ borderColor: appearance.border, backgroundColor: appearance.surface }}
      >
        <span className="text-xs font-semibold shrink-0">Copilot Agent</span>
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${
            busy ? 'bg-amber-500/15 text-amber-600' : 'bg-emerald-500/15 text-emerald-600'
          }`}
        >
          {statusLabel}
        </span>
        {(state === 'closed' || state === 'error') && (
          <button
            type="button"
            onClick={reconnect}
            data-testid="agent-reconnect"
            title="Reconnect to this session. Agent sessions keep running while the server is unavailable."
            className="text-[10px] px-1.5 py-0.5 rounded border shrink-0"
            style={{ borderColor: appearance.border }}
          >
            Reconnect
          </button>
        )}
        <div className="flex-1" />
        {/* Search the conversation */}
        <button
          type="button"
          onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
          data-testid="agent-search-toggle"
          title="Search this conversation (Ctrl+F)"
          className="flex items-center h-6 px-1.5 rounded border shrink-0"
          style={{ borderColor: appearance.border, color: searchOpen ? appearance.fg : appearance.muted }}
        >
          <Search className="h-3 w-3" />
        </button>
        {/* Token + credit usage */}
        {usage && usage.requests > 0 && (
          <div className="relative shrink-0">
            <button
              type="button"
              onClick={() => setUsageOpen((o) => !o)}
              data-testid="agent-usage-button"
              title="Token and credit usage for this session"
              className="flex items-center gap-1 h-6 px-1.5 rounded border text-[10px] tabular-nums"
              style={{ borderColor: appearance.border, color: appearance.muted }}
            >
              <Coins className="h-3 w-3" />
              <span>{formatTokens(usage.inputTokens + usage.outputTokens)}</span>
              {usage.premiumRequests > 0 && <span>· {usage.premiumRequests.toFixed(2)}×</span>}
            </button>
            {usageOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setUsageOpen(false)} />
                <div
                  data-testid="agent-usage-panel"
                  className="absolute right-0 mt-1 z-20 w-64 rounded-md border shadow-xl p-2 space-y-1 text-[11px]"
                  style={{
                    borderColor: appearance.border,
                    backgroundColor: appearance.overlay,
                    color: appearance.fg,
                  }}
                >
                  <div className="text-[10px] uppercase tracking-wide" style={{ color: appearance.muted }}>
                    Session usage
                  </div>
                  <UsageRow label="Model calls" value={String(usage.requests)} />
                  <UsageRow label="Input tokens" value={formatTokens(usage.inputTokens)} />
                  <UsageRow label="Output tokens" value={formatTokens(usage.outputTokens)} />
                  {usage.reasoningTokens > 0 && (
                    <UsageRow label="Reasoning tokens" value={formatTokens(usage.reasoningTokens)} />
                  )}
                  {usage.cachedTokens > 0 && (
                    <UsageRow label="Cached tokens" value={formatTokens(usage.cachedTokens)} />
                  )}
                  {usage.premiumRequests > 0 && (
                    <UsageRow label="Premium requests" value={usage.premiumRequests.toFixed(2)} />
                  )}
                  {usage.nanoAiu > 0 && <UsageRow label="Cost (AIU)" value={formatAiu(usage.nanoAiu)} />}
                  {usage.contextTokens !== undefined && usage.contextLimit ? (
                    <UsageRow
                      label="Context"
                      value={`${formatTokens(usage.contextTokens)} / ${formatTokens(usage.contextLimit)}`}
                    />
                  ) : null}
                  <p className="pt-1 leading-snug" style={{ color: appearance.muted }}>
                    Estimated from the runtime&apos;s per-call usage reports. Token counts cover this
                    connection only; costs resume from the session&apos;s durable checkpoints.
                  </p>
                </div>
              </>
            )}
          </div>
        )}
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
        <button
          type="button"
          onClick={() => setOutline((o) => !o)}
          data-testid="agent-outline-toggle"
          aria-pressed={outline}
          title="Outline — just the requests and each turn's final response"
          className="flex items-center gap-1 h-6 px-1.5 rounded border text-[10px] shrink-0"
          style={{
            borderColor: outline ? appearance.accent : appearance.border,
            color: outline ? appearance.accent : appearance.muted,
          }}
        >
          <ListTree className="h-3 w-3" />
          <span>Outline</span>
        </button>
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
                className="absolute right-0 mt-1 z-20 w-60 rounded-md border shadow-xl py-1"
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
                  <div key={f.kind}>
                    <div className="flex items-center justify-between gap-2 px-2 py-1 text-xs" style={{ color: appearance.fg }}>
                      <span>{f.label}</span>
                      <div
                        role="group"
                        aria-label={`${f.label} view mode`}
                        className="inline-flex rounded border overflow-hidden"
                        style={{ borderColor: appearance.border }}
                      >
                        {VIEW_MODES.map((m) => {
                          const activeMode = visibility[f.kind] === m.mode;
                          return (
                            <button
                              key={m.mode}
                              type="button"
                              data-testid={`filter-${f.kind}-${m.mode}`}
                              aria-pressed={activeMode}
                              onClick={() => setViewMode(f.kind, m.mode)}
                              className="px-1.5 py-0.5 text-[10px] leading-none"
                              style={{
                                backgroundColor: activeMode ? appearance.accent : 'transparent',
                                color: activeMode ? appearance.bg : appearance.muted,
                              }}
                            >
                              {m.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    {f.kind === 'tool' && (
                      <label
                        className="flex items-center gap-2 pl-6 pr-2 py-1 text-xs cursor-pointer hover:bg-black/5 dark:hover:bg-white/5"
                        style={{ color: visibility.tool === 'show' ? appearance.fg : appearance.muted }}
                        title={
                          visibility.tool === 'show'
                            ? 'Show the result body of each tool call'
                            : 'Tool output is only available when tool calls are shown in full'
                        }
                      >
                        <input
                          type="checkbox"
                          data-testid="filter-tool-output"
                          checked={visibility.tool === 'show' && visibility.toolOutput}
                          disabled={visibility.tool !== 'show'}
                          onChange={() => toggleToolOutput()}
                        />
                        <span>Tool output</span>
                      </label>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
        <Select value={model} onValueChange={(value) => value && changeModel(value)} items={modelItems}>
          <SelectTrigger
            size="sm"
            className="h-6 max-w-[180px] shrink-0 gap-1 rounded px-1.5 text-[10px]"
            data-testid="agent-model-select"
            aria-label={`${sessionKind === 'project_lead' ? 'Project Lead' : sessionKind === 'chief_of_staff' ? 'Chief of Staff' : 'Agent'} model`}
            title="Select model"
          >
            <span className="shrink-0" style={{ color: appearance.muted }}>Model</span>
            <SelectValue className="min-w-0 truncate" />
          </SelectTrigger>
          <SelectContent align="end" className="min-w-56">
            {models.map((item) => (
              <SelectItem key={item.id} value={item.id} className="text-xs">
                {item.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {connError && (
        <div className="px-3 py-1.5 text-xs bg-destructive/10 text-destructive border-b">{connError}</div>
      )}

      {searchOpen && (
        <div
          data-testid="agent-search-bar"
          className="flex items-center gap-2 px-3 py-1.5 border-b shrink-0"
          style={{ borderColor: appearance.border, backgroundColor: appearance.surface }}
        >
          <Search className="h-3 w-3 shrink-0" style={{ color: appearance.muted }} />
          <input
            autoFocus
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                stepSearch(e.shiftKey ? -1 : 1);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                closeSearch();
              }
            }}
            placeholder="Search this conversation"
            data-testid="agent-search-input"
            className="flex-1 min-w-0 bg-transparent outline-none text-xs"
            style={{ color: appearance.fg }}
          />
          <span
            className="text-[10px] tabular-nums shrink-0"
            data-testid="agent-search-count"
            style={{ color: appearance.muted }}
          >
            {searchQuery.trim()
              ? searchMatches.length
                ? `${(searchIndex % searchMatches.length) + 1} of ${searchMatches.length}`
                : 'No matches'
              : ''}
          </span>
          <button
            type="button"
            onClick={() => stepSearch(-1)}
            disabled={searchMatches.length === 0}
            data-testid="agent-search-prev"
            title="Previous match (Shift+Enter)"
            className="shrink-0 disabled:opacity-40"
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => stepSearch(1)}
            disabled={searchMatches.length === 0}
            data-testid="agent-search-next"
            title="Next match (Enter)"
            className="shrink-0 disabled:opacity-40"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <button type="button" onClick={closeSearch} data-testid="agent-search-close" title="Close search"
            className="shrink-0">
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Transcript */}
      <div className="relative flex-1 min-h-0 flex">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto px-3 py-3 space-y-3"
        style={{ fontSize }}
      >
        {outline ? (
          <div data-testid="agent-outline" className="space-y-1">
            {outlineItems.length === 0 ? (
              <div className="text-center pt-10 text-xs" style={{ color: appearance.muted }}>
                Nothing to outline yet.
              </div>
            ) : (
              outlineItems.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  data-testid={`outline-item-${item.key}`}
                  onClick={() => jumpToOutlineItem(item.key)}
                  title="Jump to this message"
                  className="flex w-full items-baseline gap-2 rounded px-2 py-1.5 text-left hover:bg-black/5 dark:hover:bg-white/5"
                >
                  <span
                    className="text-[10px] uppercase tracking-wide shrink-0 w-14"
                    style={{ color: item.role === 'user' ? appearance.accent : MODE_META.interactive.color }}
                  >
                    {item.role === 'user' ? 'You' : 'Copilot'}
                  </span>
                  <span className="flex-1 min-w-0 truncate text-xs" style={{ color: appearance.fg }}>
                    {outlinePreview(item.text)}
                  </span>
                  <EntryTime ts={item.ts} />
                </button>
              ))
            )}
          </div>
        ) : (
          <>
        {showingCached && events.length > 0 && (
          <div className="flex justify-center pt-2 pb-1" data-testid="agent-updating">
            <span
              className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border"
              style={{ borderColor: appearance.border, color: appearance.muted }}
            >
              <Loader2 className="h-2.5 w-2.5 animate-spin" />
              Updating…
            </span>
          </div>
        )}
        {events.length === 0 &&
          (hydrating ? (
            <div
              className="flex flex-col items-center justify-center gap-2 pt-10"
              style={{ color: appearance.muted }}
              data-testid="agent-hydrating"
            >
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-xs">Loading conversation…</span>
            </div>
          ) : (
            <div className="text-center pt-10" style={{ color: appearance.muted }}>
              Start a conversation with the Copilot agent.
            </div>
          ))}
        {events.length > 0 && renderItems.length === 0 && (
          <div className="text-center pt-10 text-xs" style={{ color: appearance.muted }}>
            All output is hidden by the current filters.
          </div>
        )}
        {earlierCount > 0 ? (
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
        ) : hasEarlier ? (
          <div className="text-center">
            <button
              type="button"
              disabled={loadingEarlier}
              data-testid="agent-fetch-earlier"
              onClick={() => {
                setLoadingEarlier(true);
                send({ type: 'fetch_earlier', beforeId: events[0]?.id });
              }}
              className="text-xs px-3 py-1 rounded-full border disabled:opacity-50"
              style={{ borderColor: appearance.border, color: appearance.muted }}
            >
              {loadingEarlier ? 'Loading earlier…' : 'Load earlier messages'}
            </button>
          </div>
        ) : null}
        {windowedItems.map((item) => {
          const isMatch = searchMatches.includes(item.key);
          return (
            <div
              key={item.key}
              data-entry-key={item.key}
              className={
                item.key === jumpKey
                  ? 'rounded-lg ring-2 ring-sky-500/70'
                  : item.key === activeMatchKey
                    ? 'rounded-lg ring-2 ring-amber-500/70'
                    : isMatch
                      ? 'rounded-lg ring-1 ring-amber-500/30'
                      : undefined
              }
            >
              {item.type === 'event' ? (
                <TranscriptItem
                  event={item.event}
                  appearance={appearance}
                  codeSize={codeSize}
                  showToolOutput={visibility.toolOutput}
                  showReasoning={visibility.reasoning === 'show'}
                  noticeMode={visibility.notice}
                  projectId={projectId}
                  worktreeId={worktreeId}
                  sessionKind={sessionKind === 'server' || sessionKind === 'artifact' ? undefined : sessionKind}
                />
              ) : (
                <ToolBadgeStrip tools={item.tools} appearance={appearance} codeSize={codeSize} />
              )}
            </div>
          );
        })}

          </>
        )}

        {/* Prompts that block the turn sit outside the transcript branch: the
            Outline view would otherwise hide the very card the agent is
            waiting on, and the session would look hung for no visible reason. */}
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
              <Button
                size="sm"
                variant="secondary"
                className="h-7"
                data-testid="permission-allow-everything"
                title="Approve this and every future request in this session"
                onClick={() => respond(p.requestId, 'approve-all')}
              >
                Allow everything
              </Button>
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
            {p.reviewNote && <div className="text-xs text-amber-600">{p.reviewNote}</div>}
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

        {/* Click-to-answer questions from the agent's ask_user tool */}
        {questions.map((p) => (
          <AskUserCard
            key={p.requestId}
            prompt={p}
            onAnswer={respondAskUser}
            surface={appearance.surfaceStrong}
          />
        ))}
      </div>

        {!atBottom && !outline && (
          <button
            type="button"
            onClick={scrollToBottom}
            data-testid="agent-jump-to-bottom"
            title="Jump to the latest message"
            className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1 h-7 px-3 rounded-full border shadow-lg text-[11px] font-medium"
            style={{
              borderColor: appearance.accent,
              backgroundColor: appearance.accent,
              color: appearance.bg,
            }}
          >
            <ArrowDown className="h-3.5 w-3.5" />
            {busy ? 'New messages' : 'Jump to latest'}
          </button>
        )}

        {/* Says why the view is moving on its own while the agent writes. */}
        {atBottom && !outline && busy && (
          <div
            data-testid="agent-following"
            title="Scroll up to stop following"
            className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1 h-6 px-2.5 rounded-full border text-[10px] font-medium pointer-events-none"
            style={{
              borderColor: appearance.border,
              backgroundColor: appearance.surfaceStrong,
              color: appearance.muted,
            }}
          >
            <ArrowDown className="h-3 w-3" />
            Following
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="border-t p-2 shrink-0" style={{ borderColor: appearance.border }}>
        {busy && (
          <TurnProgress
            appearance={appearance}
            label={statusLabel}
            startedAt={turnStartedAt}
            toolName={activeTool?.toolName}
            toolProgress={activeTool?.progress}
          />
        )}
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
        {queued.length > 0 && (
          <div data-testid="agent-queued" className="mb-2 space-y-1">
            <div className="text-[11px]" style={{ color: appearance.muted }}>
              {queued.length} follow-up{queued.length === 1 ? '' : 's'} queued · sent when this turn ends
            </div>
            {queued.map((prompt, index) => (
              <div
                key={`${index}:${prompt}`}
                className="flex items-start gap-2 rounded border px-2 py-1 text-xs"
                style={{ borderColor: appearance.border }}
              >
                <span className="min-w-0 flex-1 truncate" title={prompt}>{prompt}</span>
                <button
                  type="button"
                  className="shrink-0 underline"
                  style={{ color: appearance.muted }}
                  title="Remove this queued follow-up"
                  onClick={() => send({ type: 'dequeue', index })}
                >
                  remove
                </button>
              </div>
            ))}
          </div>
        )}
        {speech.error && (
          <div className="px-1 pb-1 text-[11px] text-destructive" role="status">
            {speech.error}
          </div>
        )}
        <div className="flex gap-2 items-end">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={speech.listening
              ? 'Listening… speak now, then edit before sending'
              : questions.length > 0
              ? 'Click an option above, or type an answer / a new instruction'
              : busy
              ? 'Message Copilot… (queued and sent when the current turn ends)'
              : 'Message Copilot… (/ for commands, Enter to send, Shift+Enter for newline)'}
            rows={2}
            className="resize-none flex-1"
            style={{ fontFamily, fontSize }}
            disabled={!active && state !== 'open'}
          />
          {busy && (
            <Button variant="destructive" size="icon" onClick={() => send({ type: 'cancel' })} title="Stop">
              <Square className="h-4 w-4" />
            </Button>
          )}
          {speech.supported && (
            <Button
              variant={speech.listening ? 'destructive' : 'secondary'}
              size="icon"
              data-testid="agent-dictate"
              aria-pressed={speech.listening}
              onClick={toggleDictation}
              title={
                speech.error ??
                (speech.listening ? 'Stop dictating' : 'Dictate a message (speech to text)')
              }
            >
              {speech.listening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
            </Button>
          )}
          <Button
            onClick={submit}
            disabled={!input.trim()}
            size="icon"
            title={busy ? 'Queue this message for when the turn ends' : 'Send'}
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Mode indicator (bottom, like the CLI). Click or Shift+Tab to cycle.
          While a stop is armed, this row hosts the Esc-again confirmation. */}
      {stopArmed ? (
        <div
          data-testid="agent-stop-confirm"
          className="flex items-center gap-1.5 px-3 py-1 border-t text-[11px] shrink-0 select-none"
          style={{ borderColor: appearance.border, backgroundColor: appearance.surface }}
        >
          <Square className="h-3.5 w-3.5 text-destructive" />
          <span className="font-semibold text-destructive">Press Esc again to stop</span>
          <span style={{ color: appearance.muted }}>the current turn</span>
          <button
            type="button"
            className="ml-auto underline"
            style={{ color: appearance.muted }}
            onClick={disarmStop}
          >
            keep running
          </button>
        </div>
      ) : (
        <div
          className="flex items-center border-t shrink-0 text-[11px] select-none"
          style={{ borderColor: appearance.border, backgroundColor: appearance.surface }}
        >
          <button
            type="button"
            onClick={cycleMode}
            data-testid="agent-mode-indicator"
            className="flex items-center gap-1.5 px-3 py-1 flex-1 min-w-0"
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
            <span className="ml-auto truncate" style={{ color: appearance.muted }}>
              {busy ? 'esc to stop · ' : ''}shift+tab to change
            </span>
          </button>
          <button
            type="button"
            onClick={() => toggleAllowAll(!allowAll)}
            data-testid="agent-allow-all-toggle"
            className="px-3 py-1 shrink-0 border-l"
            style={{
              borderColor: appearance.border,
              color: allowAll ? MODE_META.autopilot.color : appearance.muted,
              fontWeight: allowAll ? 600 : 400,
            }}
            title={
              allowAll
                ? 'Every permission request is auto-approved. Click to start asking again.'
                : 'Approve every permission request for this session without prompting.'
            }
          >
            {allowAll ? 'allow all: on' : 'allow all: off'}
          </button>
        </div>
      )}
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

// Memoized: the transcript can hold thousands of entries in a long session and
// the parent re-renders on every composer keystroke. Without this, each
// keystroke would re-render (and re-parse the markdown of) the whole history.
const TranscriptItem = memo(function TranscriptItem({
  event,
  appearance,
  codeSize,
  showToolOutput,
  showReasoning,
  noticeMode,
  projectId,
  worktreeId,
  sessionKind,
}: {
  event: AgentTranscriptEvent;
  appearance: Appearance;
  codeSize: number;
  showToolOutput: boolean;
  showReasoning: boolean;
  noticeMode: ViewMode;
  projectId?: string;
  worktreeId?: string;
  sessionKind?: 'agent' | 'project_lead' | 'chief_of_staff';
}) {
  if (event.kind === 'user') {
    return (
      <div className="flex flex-col items-end gap-0.5">
        <span
          className="text-[10px] uppercase tracking-wide px-1 flex items-center gap-1"
          style={{ color: appearance.muted }}
        >
          You
          <EntryTime ts={event.ts} />
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
    return <AssistantItem event={event} appearance={appearance} projectId={projectId} worktreeId={worktreeId} sessionKind={sessionKind} />;
  }

  if (event.kind === 'reasoning') {
    return <ReasoningItem event={event} appearance={appearance} expanded={showReasoning} />;
  }

  if (event.kind === 'system') return null;

  if (event.kind === 'tool') {
    if (isTaskComplete(event.toolName)) {
      return <TaskCompleteItem event={event} appearance={appearance} />;
    }
    return <ToolItem event={event} appearance={appearance} codeSize={codeSize} showOutput={showToolOutput} />;
  }

  if (event.kind === 'error') {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive whitespace-pre-wrap break-words">
        <span className="text-[10px] uppercase tracking-wide block mb-0.5 opacity-70">Error</span>
        {event.message}
      </div>
    );
  }

  // notice — collapses to a compact badge when the notice view mode is `badge`.
  if (noticeMode === 'badge') {
    return (
      <div
        data-testid={`notice-badge-${event.id}`}
        title={event.message}
        className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] w-fit"
        style={{ color: appearance.muted, borderColor: appearance.border }}
      >
        <Info className="h-3 w-3" />
      </div>
    );
  }
  return (
    <div className="text-xs text-center italic" style={{ color: appearance.muted }}>
      {event.message}
    </div>
  );
});

/**
 * A single Copilot reply. Extracted from `TranscriptItem` so it can own a ref to
 * the rendered markdown (for "copy as text") and the copy-menu state without
 * tripping the rules of hooks in `TranscriptItem`'s branching render.
 */
const AssistantItem = memo(function AssistantItem({
  event,
  appearance,
  projectId,
  worktreeId,
  sessionKind,
}: {
  event: Extract<AgentTranscriptEvent, { kind: 'assistant' }>;
  appearance: Appearance;
  projectId?: string;
  worktreeId?: string;
  sessionKind?: 'agent' | 'project_lead' | 'chief_of_staff';
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  return (
    <div className="group flex flex-col items-start gap-0.5">
      <span
        className="text-[10px] uppercase tracking-wide px-1 flex items-center gap-1 w-full"
        style={{ color: MODE_META.interactive.color }}
      >
        <MessageSquare className="h-3 w-3" />
        Copilot
        <EntryTime ts={event.ts} durationMs={event.durationMs} />
        {event.content && (
          <AssistantCopyMenu markdown={event.content} contentRef={contentRef} appearance={appearance} />
        )}
      </span>
      <div
        ref={contentRef}
        className="max-w-[85%] rounded-2xl rounded-bl-sm px-4 py-2 overflow-hidden prose prose-sm dark:prose-invert max-w-none"
        style={{ backgroundColor: appearance.surface, color: appearance.fg }}
      >
        <RichMarkdown
          content={event.content || '…'}
          darkMode={isDarkHexColor(appearance.bg)}
          projectId={sessionKind === 'project_lead' ? projectId : undefined}
          worktreeId={sessionKind === 'project_lead' ? worktreeId : undefined}
        />
      </div>
    </div>
  );
});

/**
 * Copy control for a Copilot reply. "Markdown" copies the raw source verbatim;
 * "text" copies the rendered `innerText` (what the user actually sees, with the
 * markdown syntax stripped) and falls back to the source if the DOM node is
 * unavailable.
 */
function AssistantCopyMenu({
  markdown,
  contentRef,
  appearance,
}: {
  markdown: string;
  contentRef: React.RefObject<HTMLDivElement | null>;
  appearance: Appearance;
}) {
  const [copied, setCopied] = useState<'text' | 'markdown' | null>(null);

  const copy = (kind: 'text' | 'markdown') => {
    const value =
      kind === 'markdown' ? markdown : (contentRef.current?.innerText?.trim() || markdown);
    if (!navigator.clipboard) return;
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 1_500);
    });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="assistant-copy-button"
        title="Copy response"
        className="ml-auto flex items-center rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 data-[popup-open]:opacity-100"
        style={{ color: appearance.muted }}
      >
        {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[10rem]">
        <DropdownMenuItem data-testid="assistant-copy-text" onClick={() => copy('text')}>
          Copy as text
        </DropdownMenuItem>
        <DropdownMenuItem data-testid="assistant-copy-markdown" onClick={() => copy('markdown')}>
          Copy as Markdown
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Reasoning trace.
 *
 * Expanded by default. Unchecking "Reasoning" in the View menu does not hide it
 * outright — it collapses to a brain badge the user can still click to read.
 */
const ReasoningItem = memo(function ReasoningItem({
  event,
  appearance,
  expanded,
}: {
  event: Extract<AgentTranscriptEvent, { kind: 'reasoning' }>;
  appearance: Appearance;
  expanded: boolean;
}) {
  const [open, setOpen] = useState(expanded);
  useEffect(() => {
    setOpen(expanded);
  }, [expanded]);

  if (!open) {
    return (
      <button
        type="button"
        data-testid="agent-reasoning-badge"
        title="Reasoning"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] w-fit"
        style={{ color: appearance.muted, borderColor: appearance.border }}
      >
        <Brain className="h-3 w-3" />
      </button>
    );
  }

  return (
    <div className="text-xs" style={{ color: appearance.muted }}>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="cursor-pointer select-none flex items-center gap-1"
      >
        <Brain className="h-3 w-3" />
        Reasoning
      </button>
      <div
        className="mt-1 whitespace-pre-wrap break-words pl-2 border-l"
        style={{ borderColor: appearance.border }}
      >
        {event.content}
      </div>
    </div>
  );
});

/** One label/value line in the usage popover. */
function UsageRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="opacity-70">{label}</span>
      <span className="tabular-nums font-medium">{value}</span>
    </div>
  );
}

/**
 * The agent's closing summary, rendered as prose.
 *
 * `task_complete` arrives as a tool call, but its payload is the agent's final
 * word on the turn — collapsing it behind a badge hides the one thing the user
 * most wants to read, so it always renders expanded regardless of the tool
 * visibility filters.
 */
const TaskCompleteItem = memo(function TaskCompleteItem({
  event,
  appearance,
}: {
  event: Extract<AgentTranscriptEvent, { kind: 'tool' }>;
  appearance: Appearance;
}) {
  const summary = useMemo(() => {
    const record = parseToolArgs(event.args);
    const fromArgs = typeof record?.summary === 'string' ? record.summary : undefined;
    return (fromArgs || event.output || '').trim();
  }, [event.args, event.output]);
  return (
    <div className="flex flex-col items-start gap-0.5">
      <span
        className="text-[10px] uppercase tracking-wide px-1 flex items-center gap-1 text-emerald-600"
      >
        <Check className="h-3 w-3" />
        Task complete
        <EntryTime ts={event.ts} durationMs={event.durationMs} />
      </span>
      <div
        data-testid={`task-complete-${event.toolCallId}`}
        className="max-w-[85%] rounded-2xl rounded-bl-sm px-4 py-2 overflow-hidden border border-emerald-500/40 prose prose-sm dark:prose-invert"
        style={{ backgroundColor: appearance.surface, color: appearance.fg }}
      >
        <RichMarkdown content={summary || 'Task complete.'} darkMode={isDarkHexColor(appearance.bg)} />
      </div>
    </div>
  );
});

const ToolItem = memo(function ToolItem({
  event,
  appearance,
  codeSize,
  showOutput,
}: {
  event: Extract<AgentTranscriptEvent, { kind: 'tool' }>;
  appearance: Appearance;
  codeSize: number;
  showOutput: boolean;
}) {
  const [open, setOpen] = useState(event.status === 'running');
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (event.status !== 'running') return;
    setOpen(true);
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [event.status]);

  const argsText = useMemo(() => {
    if (event.args === undefined) return '';
    try {
      return typeof event.args === 'string' ? event.args : JSON.stringify(event.args, null, 2);
    } catch {
      return String(event.args);
    }
  }, [event.args]);
  const elapsedSeconds = Math.max(0, Math.floor((now - event.ts) / 1_000));
  const elapsed = formatElapsed(elapsedSeconds);
  const toolDetail = useMemo(() => describeToolCall(event.toolName, event.args), [event.toolName, event.args]);

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
        {toolDetail && (
          <span className="truncate" style={{ color: appearance.muted }}>
            {toolDetail}
          </span>
        )}
        {event.status === 'running' && (
          <span className="truncate shrink-0" style={{ color: appearance.muted }}>
            {event.progress || `running ${elapsed}`}
          </span>
        )}
        <div className="flex-1" />
        {event.status !== 'running' && event.durationMs !== undefined && (
          <span
            className="text-[10px] tabular-nums"
            style={{ color: appearance.muted }}
            title={`Started ${formatFullTime(event.ts)}`}
          >
            {formatDurationMs(event.durationMs)}
          </span>
        )}
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
          {event.status === 'running' && (
            <div
              data-testid={`tool-progress-${event.toolCallId}`}
              className="rounded p-1.5 font-sans"
              style={{ backgroundColor: appearance.surfaceStrong, color: appearance.muted }}
            >
              <div>{event.progress || 'Waiting for the tool to return output…'}</div>
              <div className="mt-0.5 text-[10px]">
                Running for {elapsed}
                {elapsedSeconds >= 10 ? ' · Use Stop below to cancel this turn.' : ''}
              </div>
            </div>
          )}
          {event.output && showOutput && (
            <pre
              className="whitespace-pre-wrap break-words rounded p-1.5 max-h-64 overflow-auto"
              style={{ backgroundColor: appearance.surfaceStrong, fontSize: codeSize }}
            >
              {event.output}
            </pre>
          )}
          {event.output && !showOutput && (
            <div
              data-testid={`tool-output-hidden-${event.toolCallId}`}
              className="rounded p-1.5 font-sans text-[10px]"
              style={{ backgroundColor: appearance.surfaceStrong, color: appearance.muted }}
            >
              Output hidden by the View filter.
            </div>
          )}
        </div>
      )}
    </div>
  );
});

/**
 * A short, specific detail for a tool call — what this particular invocation is
 * doing. Returns undefined when the arguments say nothing useful.
 *
 * This is only ever shown *alongside* the tool name, never instead of it: a
 * bare "src/shared/agent-bridge.ts" badge tells you nothing about whether the
 * file was read, written, or searched.
 */
function describeToolCall(toolName: string, args: unknown): string | undefined {
  const record = parseToolArgs(args);
  if (!record) return undefined;
  const candidates = [
    record.description,
    record.query,
    record.command,
    record.pattern,
    record.path,
    record.file_path,
    record.filePath,
    record.url,
    record.prompt,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const label = firstLine(candidate);
    if (label && label !== toolName) return label;
  }
  return undefined;
}

/**
 * Shell tools ("powershell", "bash", …) all look identical on a badge, so the
 * name alone is useless in a long run. Append a short prefix of the actual
 * command so the strip reads "powershell npx tsc…" instead of five "powershell".
 */
const SHELL_TOOL_NAMES = new Set([
  'powershell',
  'pwsh',
  'bash',
  'sh',
  'zsh',
  'shell',
  'cmd',
  'terminal',
  'run_in_terminal',
  'execute_command',
]);

const SHELL_SUFFIX_MAX = 10;

function shellCommandSuffix(toolName: string, args: unknown): string | undefined {
  if (!SHELL_TOOL_NAMES.has(toolName.trim().toLowerCase())) return undefined;
  const record = parseToolArgs(args);
  if (!record) return undefined;
  const raw = record.command ?? record.script ?? record.cmd ?? record.description;
  if (typeof raw !== 'string') return undefined;
  const line = raw.trim().split('\n')[0]?.trim() ?? '';
  if (!line) return undefined;
  return line.length <= SHELL_SUFFIX_MAX ? line : `${line.slice(0, SHELL_SUFFIX_MAX)}…`;
}

function parseToolArgs(args: unknown): Record<string, unknown> | undefined {
  if (args && typeof args === 'object' && !Array.isArray(args)) return args as Record<string, unknown>;
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Not JSON — the raw string is the best label we have.
      const label = firstLine(args);
      return label ? { description: label } : undefined;
    }
  }
  return undefined;
}

const MAX_TOOL_LABEL = 64;

function firstLine(value: string): string {
  const line = value.trim().split('\n')[0]?.trim() ?? '';
  if (line.length <= MAX_TOOL_LABEL) return line;
  return `${line.slice(0, MAX_TOOL_LABEL - 1)}…`;
}

/**
 * Compact stand-in for tool calls when the "Tool calls" filter is off. Each
 * call keeps a badge so in-flight work stays visible (otherwise a long tool
 * call looks like the agent has hung), labelled with what it is actually doing
 * and how long it took. Clicking a badge opens the full call in a dialog.
 */
const ToolBadgeStrip = memo(function ToolBadgeStrip({
  tools,
  appearance,
  codeSize,
}: {
  tools: Extract<AgentTranscriptEvent, { kind: 'tool' }>[];
  appearance: Appearance;
  codeSize: number;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const hasRunning = tools.some((t) => t.status === 'running');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!hasRunning) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [hasRunning]);

  const selected = tools.find((t) => t.toolCallId === selectedId) ?? null;

  return (
    <div data-testid="tool-badges" className="flex flex-wrap items-center gap-1">
      {tools.map((t) => {
        const detail = describeToolCall(t.toolName, t.args);
        const cmd = shellCommandSuffix(t.toolName, t.args);
        const timing =
          t.status === 'running'
            ? formatElapsed(Math.max(0, Math.floor((now - t.ts) / 1_000)))
            : t.durationMs !== undefined
              ? formatDurationMs(t.durationMs)
              : '';
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => setSelectedId(t.toolCallId)}
            data-testid={`tool-badge-${t.toolCallId}`}
            title={`${t.toolName}${detail ? ` — ${detail}` : ''}${
              t.status === 'running' ? ' — running…' : t.status === 'error' ? ' — failed' : ''
            }\nClick for details`}
            className="inline-flex items-center gap-1 h-5 px-1.5 rounded border text-[10px] leading-none hover:opacity-80"
            style={{ borderColor: appearance.border, backgroundColor: appearance.surface }}
          >
            {t.status === 'running' ? (
              <Loader2 className="h-3 w-3 shrink-0 animate-spin text-amber-600" />
            ) : t.status === 'error' ? (
              <XIcon className="h-3 w-3 shrink-0 text-destructive" />
            ) : (
              <Wrench className="h-3 w-3 shrink-0" style={{ color: appearance.muted }} />
            )}
            <span className="font-semibold" style={{ color: appearance.fg }}>
              {t.toolName}
            </span>
            {cmd && (
              <span className="font-mono shrink-0" style={{ color: appearance.muted }}>
                {cmd}
              </span>
            )}
            {timing && (
              <span className="tabular-nums shrink-0" style={{ color: appearance.muted }}>
                {timing}
              </span>
            )}
          </button>
        );
      })}
      <ToolDetailDialog
        tool={selected}
        appearance={appearance}
        codeSize={codeSize}
        onClose={() => setSelectedId(null)}
      />
    </div>
  );
});

/** Full detail of a single tool call, opened from a collapsed tool badge. */
function ToolDetailDialog({
  tool,
  appearance,
  codeSize,
  onClose,
}: {
  tool: Extract<AgentTranscriptEvent, { kind: 'tool' }> | null;
  appearance: Appearance;
  codeSize: number;
  onClose: () => void;
}) {
  const argsText = useMemo(() => {
    if (!tool || tool.args === undefined) return '';
    try {
      return typeof tool.args === 'string' ? tool.args : JSON.stringify(tool.args, null, 2);
    } catch {
      return String(tool.args);
    }
  }, [tool]);

  if (!tool) return null;
  const detail = describeToolCall(tool.toolName, tool.args);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="sm:max-w-2xl max-h-[85vh] overflow-hidden grid-rows-[auto_minmax(0,1fr)]"
        data-testid="tool-detail-dialog"
      >
        <DialogHeader className="min-w-0">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Wrench className="h-4 w-4 shrink-0" />
            <span className="truncate">{tool.toolName}</span>
          </DialogTitle>
          <DialogDescription className="break-words line-clamp-2">{detail ?? 'Tool call'}</DialogDescription>
        </DialogHeader>
        <div className="text-xs space-y-2 min-w-0 overflow-y-auto">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
            <span>Status: {tool.status}</span>
            <span title={formatFullTime(tool.ts)}>Started {formatClock(tool.ts)}</span>
            {tool.durationMs !== undefined && <span>Took {formatDurationMs(tool.durationMs)}</span>}
          </div>
          {tool.progress && <div className="text-muted-foreground break-words">{tool.progress}</div>}
          {argsText && (
            <div className="min-w-0">
              <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Arguments</div>
              <pre
                className="whitespace-pre-wrap break-all rounded p-2 max-h-52 overflow-auto font-mono"
                style={{ backgroundColor: appearance.surfaceStrong, fontSize: codeSize }}
              >
                {argsText}
              </pre>
            </div>
          )}
          {tool.output && (
            <div className="min-w-0">
              <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Output</div>
              <pre
                data-testid="tool-detail-output"
                className="whitespace-pre-wrap break-all rounded p-2 max-h-80 overflow-auto font-mono"
                style={{ backgroundColor: appearance.surfaceStrong, fontSize: codeSize }}
              >
                {tool.output}
              </pre>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}


function formatElapsed(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  if (safe < 60) return `${safe}s`;
  const minutes = Math.floor(safe / 60);
  const remainder = safe % 60;
  return `${minutes}m ${String(remainder).padStart(2, '0')}s`;
}

/**
 * Live counter for the in-flight turn. Ticks once a second from `startedAt`,
 * which is the moment the user submitted the request.
 */
function useElapsedSeconds(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [startedAt]);
  if (startedAt === null) return 0;
  return Math.max(0, Math.floor((now - startedAt) / 1_000));
}

/**
 * Progress banner shown above the composer for as long as the agent is working.
 * It reports what the agent is doing plus how long the user has been waiting,
 * measured from their own request rather than from the model's first token.
 */
function TurnProgress({
  appearance,
  label,
  startedAt,
  toolName,
  toolProgress,
}: {
  appearance: Appearance;
  label: string;
  startedAt: number | null;
  toolName?: string;
  toolProgress?: string;
}) {
  const seconds = useElapsedSeconds(startedAt);
  const detail = toolProgress || (toolName ? `${toolName}…` : '');

  return (
    <div
      data-testid="agent-turn-progress"
      role="status"
      aria-live="polite"
      className="mb-1 rounded-md border overflow-hidden"
      style={{ borderColor: appearance.border, backgroundColor: appearance.surface }}
    >
      <div className="flex items-center gap-1.5 px-2 py-1 text-[11px]">
        <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0 text-amber-600" />
        <span className="font-semibold shrink-0" style={{ color: appearance.fg }}>
          {label}
        </span>
        {detail && (
          <span className="truncate" style={{ color: appearance.muted }}>
            {detail}
          </span>
        )}
        <span
          data-testid="agent-turn-elapsed"
          className="ml-auto shrink-0 tabular-nums"
          style={{ color: appearance.muted }}
          title="Elapsed since you sent this request"
        >
          {formatElapsed(seconds)}
        </span>
      </div>
      {/* Indeterminate bar — the runtime reports no percentage, so this conveys
          liveness rather than a completion ratio. */}
      <div className="h-0.5 w-full overflow-hidden" style={{ backgroundColor: appearance.surfaceStrong }}>
        <div className="h-full w-1/3 animate-agent-progress" style={{ backgroundColor: appearance.accent }} />
      </div>
    </div>
  );
}

/** Short wall-clock label for a transcript entry, e.g. `14:32`. */
function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Full date+time, used as the hover title behind the short clock label. */
function formatFullTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

/**
 * Durations are always reported in minutes/seconds so the agent chat reads the
 * same way everywhere — sub-second work simply rounds to `0s`.
 */
function formatDurationMs(ms: number): string {
  return formatElapsed(Math.round(Math.max(0, ms) / 1_000));
}

/**
 * Wall-clock stamp shown next to a message's author label. Values come from the
 * runtime's own event timestamps, so a replayed session shows when it actually
 * happened rather than when it was reloaded.
 */
function EntryTime({ ts, durationMs }: { ts: number; durationMs?: number }) {
  return (
    <span title={formatFullTime(ts)} className="tabular-nums opacity-70">
      {formatClock(ts)}
      {durationMs !== undefined && durationMs > 0 ? ` · ${formatDurationMs(durationMs)}` : ''}
    </span>
  );
}
