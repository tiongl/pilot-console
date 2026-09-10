export interface User {
  id: string;
  githubId: string;
  githubLogin: string | null;
  email: string | null;
  displayName: string | null;
  role: 'admin' | 'user';
  createdAt: string;
}

export interface Project {
  id: string;
  name: string;
  repoPath: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export type SkillType = 'mcp_server' | 'custom_instructions' | 'repo_context';

export interface ProjectSkill {
  id: string;
  projectId: string;
  type: SkillType;
  name: string;
  config: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
}

export interface CliSession {
  id: string;
  userId: string;
  projectId: string | null;
  copilotSessionId: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface SessionWithUser extends CliSession {
  userDisplayName: string | null;
  userEmail: string | null;
}

export interface SessionWithProject extends CliSession {
  projectName: string | null;
}

// WebSocket message types (Client → Server)
export type WsClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'ping' }
  | { type: 'perf-pong'; ts: number }
  | { type: 'replay' };

// WebSocket message types (Server → Client)
export type WsServerMessage =
  | { type: 'output'; data: string }
  | { type: 'error'; data: string }
  | { type: 'exit'; code: number }
  | { type: 'ready'; sessionId: string }
  | { type: 'pong' }
  | { type: 'perf-ping'; ts: number }
  | { type: 'git-changed'; projectId: string; worktreeId: string | null }
  | { type: 'report-ready'; runId: string; scheduleId: string; scheduleName: string; status: string }
  | { type: 'schedule-changed'; action: 'created' | 'updated' | 'deleted' | 'imported'; scheduleId?: string };

// ---------------------------------------------------------------------------
// Agent (SDK) mode — structured protocol
//
// Unlike the terminal modes above (which stream raw PTY bytes), the SDK-based
// "agent" mode streams *structured* events derived from the Copilot SDK. The
// server normalizes SDK session events into `AgentTranscriptEvent` entries that
// are buffered for replay and rendered as a hybrid chat + tool-activity UI.
// ---------------------------------------------------------------------------

export type AgentStatus = 'idle' | 'busy';

/** Agent UI mode, mirroring the Copilot CLI (Shift+Tab cycles these). */
export type AgentMode = 'interactive' | 'plan' | 'autopilot';

export type AgentToolStatus = 'running' | 'success' | 'error';

/** A single, upsert-by-id entry in an agent session's transcript. */
export type AgentTranscriptEvent =
  | { kind: 'user'; id: string; ts: number; content: string }
  | { kind: 'assistant'; id: string; ts: number; content: string; durationMs?: number }
  | { kind: 'reasoning'; id: string; ts: number; content: string }
  | { kind: 'system'; id: string; ts: number; content: string }
  | {
      kind: 'tool';
      id: string;
      ts: number;
      toolCallId: string;
      toolName: string;
      args?: unknown;
      status: AgentToolStatus;
      progress?: string;
      output?: string;
      /** Wall-clock execution time, set once the tool completes. */
      durationMs?: number;
    }
  | { kind: 'notice'; id: string; ts: number; message: string }
  | { kind: 'error'; id: string; ts: number; message: string };

/**
 * A slash command discovered from the Copilot SDK session (`commands.list`).
 * The catalog is dynamic — it reflects the runtime built-ins plus whatever
 * skills / plugins the session currently has enabled, so it stays correct as
 * the user installs or removes plugins.
 */
export interface AgentSlashCommand {
  name: string;
  aliases?: string[];
  description: string;
  /** 'builtin' | 'skill' | 'client' — 'client' is a locally-handled command. */
  kind: 'builtin' | 'skill' | 'client';
  /** Hint for the argument text, when the command accepts input. */
  argHint?: string;
  /** Literal choices the argument accepts (rendered as suggestions). */
  argChoices?: { name: string; description: string }[];
  /** Whether the command requires non-empty input. */
  argRequired?: boolean;
  /** Whether the command may run while an agent turn is active. */
  allowDuringExecution?: boolean;
}

/** An option offered when a command needs a subcommand selection. */
export interface AgentCommandOption {
  name: string;
  description: string;
  group?: string;
}

/**
 * Accumulated token and billing usage for one agent session.
 *
 * Everything here is summed from the SDK's `assistant.usage` events, which the
 * runtime emits once per model call. `nanoAiu` is GitHub's own billing unit
 * (nano-AI units) as reported by CAPI, and `premiumRequests` is the sum of the
 * per-call model multipliers — the number a Copilot plan's premium-request
 * allowance is drawn down by.
 */
export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  /** Number of model calls counted. */
  requests: number;
  /** Sum of per-call model multipliers ("premium request" equivalents). */
  premiumRequests: number;
  /** Accumulated cost in nano-AI units (1e-9 AIU), when CAPI reports it. */
  nanoAiu: number;
  /** Context-window occupancy for the live session, when known. */
  contextTokens?: number;
  contextLimit?: number;
}

/** Summary of a resumable Copilot session (for the `/resume` switcher). */
export interface AgentSessionSummary {
  id: string;
  summary: string | null;
  startTime: string;
  modifiedTime: string;
  isRemote: boolean;
  /** True for the session currently attached to this socket. */
  current: boolean;
}

/**
 * GitHub session-sharing state, mirroring the SDK's remote-control mode.
 * - `off`    — not shared.
 * - `export` — session events published to GitHub (read-only, appears in the
 *   GitHub agents tab).
 * - `on`     — published *and* steerable from GitHub.
 */
export type AgentShareMode = 'off' | 'export' | 'on';

export interface AgentShareStatus {
  mode: AgentShareMode;
  /** GitHub frontend URL for the shared session, when shared. */
  url?: string;
  /** Whether GitHub may steer (write to) this session. */
  steerable: boolean;
  /** Set when the last share attempt failed. */
  error?: string;
}

/** Client → Server messages for the `/ws/agent` socket. */
export type AgentClientMessage =
  | { type: 'send'; prompt: string }
  | { type: 'cancel' }
  // 'approve-all' additionally puts the session into "allow everything" mode so
  // no further permission prompts are shown, whatever the agent mode.
  | {
      type: 'permission_response';
      requestId: string;
      decision: 'approve-once' | 'approve-for-session' | 'approve-all' | 'reject';
    }
  // Turn "allow everything" on/off without answering a specific prompt.
  | { type: 'set_allow_all'; enabled: boolean }
  | { type: 'set_mode'; mode: AgentMode }
  | { type: 'exit_plan_response'; requestId: string; action: string }
  | { type: 'set_model'; model: string }
  // Discover the current slash-command catalog (dynamic; plugin-aware).
  | { type: 'list_commands' }
  // Invoke a runtime/skill/plugin slash command by name with raw argument text.
  | { type: 'run_command'; name: string; input?: string }
  // List resumable sessions for this project (native `/resume` switcher).
  | { type: 'list_sessions' }
  // Fetch the working-tree diff (native `/diff` panel).
  | { type: 'get_diff' }
  // Share this session to GitHub (mode: 'export' read-only, or 'on' steerable).
  | { type: 'share_session'; mode: AgentShareMode }
  // Report the current GitHub share status.
  | { type: 'get_share_status' }
  | { type: 'replay' };

/** Server → Client messages for the `/ws/agent` socket. */
export type AgentServerMessage =
  | { type: 'ready'; sessionId: string; model: string; mode: AgentMode; status: AgentStatus }
  | { type: 'replay'; events: AgentTranscriptEvent[] }
  // Upsert (create or update) a transcript entry, keyed by `event.id`.
  | { type: 'event'; event: AgentTranscriptEvent }
  // Streaming text deltas appended to an existing entry (live-only, not replayed).
  | { type: 'assistant_delta'; id: string; delta: string }
  | { type: 'tool_delta'; id: string; delta: string }
  | { type: 'permission_request'; requestId: string; title: string; detail: string; canSession: boolean }
  | { type: 'permission_resolved'; requestId: string }
  // Whether the session auto-approves every permission request.
  | { type: 'allow_all'; enabled: boolean }
  // Agent finished planning and is asking whether/how to exit plan mode.
  | {
      type: 'exit_plan_request';
      requestId: string;
      summary: string;
      planContent?: string;
      actions: string[];
      recommended: string;
    }
  | { type: 'exit_plan_resolved'; requestId: string }
  | { type: 'status'; status: AgentStatus }
  | { type: 'model'; model: string }
  | { type: 'mode'; mode: AgentMode }
  // The dynamic slash-command catalog for this session.
  | { type: 'commands'; commands: AgentSlashCommand[] }
  // A command needs the user to pick a subcommand before it can run.
  | { type: 'command_subcommands'; command: string; title: string; options: AgentCommandOption[] }
  // Resumable sessions for the `/resume` switcher.
  | { type: 'sessions'; sessions: AgentSessionSummary[] }
  // Working-tree diff for the `/diff` panel.
  | { type: 'diff'; content: string; truncated: boolean }
  // Current GitHub share status for this session.
  | { type: 'share_status'; status: AgentShareStatus }
  // Accumulated token/billing usage for this session.
  | { type: 'usage'; usage: AgentUsage }
  | { type: 'error'; message: string };

export interface AgentModelOption {
  id: string;
  name: string;
}

export type WorktreeType = 'worktree' | 'directory';

export interface Worktree {
  id: string;
  projectId: string;
  name: string;
  branch: string;
  worktreePath: string;
  isManaged: boolean;
  type: WorktreeType;
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// GitHub project-oriented views (Projects V2, Milestones, Issues, PRs)
// ---------------------------------------------------------------------------

/** Owner/repo resolved from a console project's git remote, plus scope status. */
export interface GitHubRepoInfo {
  owner: string;
  repo: string;
  nameWithOwner: string;
  /** True when the server `gh` token carries the `project` (Projects V2) scope. */
  hasProjectScope: boolean;
}

/** A stored link between a console project and a GitHub Projects V2 board. */
export interface GitHubProjectLink {
  id: string;
  projectId: string;
  ghProjectId: string;
  ghProjectNumber: number;
  title: string;
  isDefault: boolean;
  createdAt: string;
}

/** A Projects V2 board discovered as linked to the repo (for the settings picker). */
export interface GitHubProjectV2Summary {
  id: string;
  number: number;
  title: string;
  url: string;
  closed: boolean;
  ownerLogin: string;
}

export interface GitHubMilestone {
  number: number;
  title: string;
  description: string | null;
  state: 'open' | 'closed';
  openIssues: number;
  closedIssues: number;
  dueOn: string | null;
  url: string;
}

export interface GitHubUserRef {
  login: string;
  avatarUrl: string;
}

export interface GitHubLabel {
  name: string;
  color: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  state: 'open' | 'closed';
  url: string;
  author: GitHubUserRef | null;
  assignees: GitHubUserRef[];
  labels: GitHubLabel[];
  milestone: string | null;
  comments: number;
  createdAt: string;
  updatedAt: string;
}

export interface GitHubPullRequest {
  number: number;
  title: string;
  state: 'open' | 'closed' | 'merged';
  isDraft: boolean;
  url: string;
  author: GitHubUserRef | null;
  labels: GitHubLabel[];
  milestone: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A single Projects V2 board item (card): its content plus its Status column. */
export interface GitHubBoardItem {
  itemId: string;
  contentType: 'Issue' | 'PullRequest' | 'DraftIssue';
  title: string;
  number: number | null;
  url: string | null;
  state: string | null;
  status: string | null;
  assignees: GitHubUserRef[];
  labels: GitHubLabel[];
  /** PRs linked to this item (the item itself if a PR, or PRs closing its issue). */
  linkedPullRequests: GitHubPullRequest[];
}

/** A Status field option = a board column. */
export interface GitHubBoardColumn {
  id: string;
  name: string;
}

/** A Projects V2 board: its Status field id, columns, and items. */
export interface GitHubBoard {
  projectId: string;
  projectNumber: number;
  title: string;
  statusFieldId: string | null;
  columns: GitHubBoardColumn[];
  items: GitHubBoardItem[];
}
