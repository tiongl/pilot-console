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
  | { kind: 'assistant'; id: string; ts: number; content: string }
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
      output?: string;
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
  | { type: 'permission_response'; requestId: string; decision: 'approve-once' | 'approve-for-session' | 'reject' }
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
