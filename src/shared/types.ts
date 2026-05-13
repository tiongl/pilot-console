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
  | { type: 'perf-pong'; ts: number };

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

export interface Worktree {
  id: string;
  projectId: string;
  name: string;
  branch: string;
  worktreePath: string;
  isManaged: boolean;
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}
