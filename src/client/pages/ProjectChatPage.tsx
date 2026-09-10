import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useParams } from 'react-router';
import { useCliSocket } from '../hooks/useCliSocket';
import TerminalPane, { type TerminalPaneAPI, TERMINAL_FONTS } from '../components/terminal/TerminalPane';
import NewTabMenu from '../components/terminal/NewTabMenu';
import AgentPane from '../components/terminal/AgentPane';
import { Button } from '../components/ui/button';
import { Square, Minus, Plus, Palette, Type, X as XIcon, Terminal, SquareTerminal, Bot, GitCommitHorizontal, GitBranch, FolderOpen, RotateCcw, Sparkles, ExternalLink } from 'lucide-react';
import { THEMES } from '../lib/terminal-themes';
import GitLogTab from '../components/project/GitLogTab';
import GitPanel from '../components/project/GitPanel';
import { OutputFilter, DEFAULT_FILTER_PATTERNS } from '../lib/output-filter';
import FileExplorer from '../components/project/FileExplorer';
import { useProjectSplit, splitGroupCount } from '../lib/project-split-context';

interface TabMeta {
  id: string;
  label: string;
  mode: 'cli' | 'cli-classic' | 'shell' | 'powershell' | 'agent' | 'git' | 'git-status' | 'files';
  themeName: string;
  fontFamily: string;
  sessionId?: string;
  group: number;
}

interface DetachedTabConfig {
  mode: TabMeta['mode'];
  sessionId?: string;
  label?: string;
}

let tabCounter = 0;

/** Persists tab state per project across route changes (component remounts). */
interface ProjectTabState {
  tabs: TabMeta[];
  activeTabId: string;
  fontSize: number;
  themeName?: string;
  fontFamily?: string;
}
const projectTabStates = new Map<string, ProjectTabState>();

// --- localStorage persistence helpers ---
const TAB_STATE_VERSION = 1;
interface PersistedTabState {
  version: number;
  tabs: TabMeta[];
  activeTabId: string;
  fontSize: number;
  themeName?: string;
  fontFamily?: string;
}

function lsTabKey(stateKey: string) {
  return `pilot-console-tabs:${stateKey}`;
}

function loadTabState(stateKey: string): PersistedTabState | null {
  try {
    const raw = localStorage.getItem(lsTabKey(stateKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.version !== TAB_STATE_VERSION || !Array.isArray(parsed.tabs)) return null;
    return parsed as PersistedTabState;
  } catch {
    return null;
  }
}

function saveTabState(stateKey: string, state: ProjectTabState) {
  try {
    const data: PersistedTabState = { version: TAB_STATE_VERSION, ...state };
    localStorage.setItem(lsTabKey(stateKey), JSON.stringify(data));
  } catch { /* quota exceeded — ignore */ }
}

/** Reassign fresh IDs to restored tabs to avoid collisions with tabCounter */
function rehydrateTabs(tabs: TabMeta[]): TabMeta[] {
  return tabs.map(t => {
    tabCounter++;
    return { ...t, id: `tab-${tabCounter}`, group: typeof t.group === 'number' && t.group >= 1 ? t.group : 1 };
  });
}

function defaultTabLabel(mode: TabMeta['mode'], n: number): string {
  if (mode === 'shell') return `Shell ${n}`;
  if (mode === 'powershell') return `PS ${n}`;
  if (mode === 'agent') return `Agent ${n}`;
  if (mode === 'git') return `Git Log ${n}`;
  if (mode === 'git-status') return `Git Status ${n}`;
  if (mode === 'files') return `Files ${n}`;
  if (mode === 'cli-classic') return `Copilot (classic) ${n}`;
  return `Copilot ${n}`;
}

function parseDetachedTabConfig(search: string): DetachedTabConfig | null {
  const params = new URLSearchParams(search);
  if (params.get('detachedTab') !== '1') return null;
  const mode = params.get('mode');
  if (
    mode !== 'cli' &&
    mode !== 'cli-classic' &&
    mode !== 'shell' &&
    mode !== 'powershell' &&
    mode !== 'agent' &&
    mode !== 'git' &&
    mode !== 'git-status' &&
    mode !== 'files'
  ) {
    return null;
  }
  const sessionId = params.get('sessionId')?.trim() || undefined;
  const label = params.get('label')?.trim() || undefined;
  return { mode, sessionId, label };
}

const MAX_HIDDEN_BUFFER = 100_000; // chars to retain for hidden terminals

/**
 * Find a safe cut point that doesn't split an ANSI escape sequence.
 * Scans backwards from `pos` to avoid slicing mid-escape, which would
 * inject garbage bytes into the terminal stream and cause corruption.
 */
function findSafeSlicePoint(str: string, pos: number): number {
  // Scan backwards up to 32 chars (longest plausible ANSI sequence)
  const limit = Math.max(0, pos - 32);
  for (let i = pos; i >= limit; i--) {
    if (str.charCodeAt(i) === 0x1b) {
      // Found an ESC — the sequence starting here may extend past `pos`,
      // so cut just before it to avoid splitting it.
      return i;
    }
  }
  return pos;
}

/**
 * Each tab owns its own WS connection and TerminalPane.
 * Output is written directly to xterm (no React state accumulation).
 */
const TerminalTab = React.memo(function TerminalTab({
  projectId, worktreeId, fontSize, fontFamily, themeName, active, forceNew, mode, sessionId: initialSessionId, onStatusChange, onKill, onSessionId, onTermApi, visible = true,
}: {
  projectId?: string;
  worktreeId?: string;
  fontSize: number;
  fontFamily: string;
  themeName: string;
  active: boolean;
  forceNew: boolean;
  mode: 'cli' | 'cli-classic' | 'shell' | 'powershell';
  sessionId?: string;
  onStatusChange: (status: string) => void;
  onKill: (sessionId: string | null) => void;
  onSessionId?: (sessionId: string) => void;
  onTermApi?: (api: TerminalPaneAPI) => void;
  /** Whether this terminal's project is currently visible on screen */
  visible?: boolean;
}) {
  const sessionIdRef = useRef<string | null>(initialSessionId ?? null);
  const termApiRef = useRef<TerminalPaneAPI | null>(null);
  const pendingOutput = useRef<string[]>([]);

  const visibleAndActiveRef = useRef(visible && active);
  visibleAndActiveRef.current = visible && active;

  const pendingLen = useRef(0);

  // Output filter — strips known Copilot CLI internal errors from the stream
  const filterRef = useRef<OutputFilter | null>(null);
  if (!filterRef.current) {
    filterRef.current = new OutputFilter({ patterns: DEFAULT_FILTER_PATTERNS });
  }

  const rawWriteToTerm = useCallback((data: string) => {
    if (termApiRef.current) {
      if (!visibleAndActiveRef.current) {
        pendingOutput.current.push(data);
        pendingLen.current += data.length;
        if (pendingLen.current > MAX_HIDDEN_BUFFER) {
          const joined = pendingOutput.current.join('');
          const cutPos = findSafeSlicePoint(joined, joined.length - MAX_HIDDEN_BUFFER);
          const trimmed = joined.slice(cutPos);
          pendingOutput.current = [trimmed];
          pendingLen.current = trimmed.length;
        }
        return;
      }
      termApiRef.current.writeBatched(data);
    } else {
      pendingOutput.current.push(data);
      pendingLen.current += data.length;
    }
  }, []);

  // Wire filter output to rawWriteToTerm on mount
  useEffect(() => {
    filterRef.current!.setOutput(rawWriteToTerm);
    return () => filterRef.current!.dispose();
  }, [rawWriteToTerm]);

  const writeToTerm = useCallback((data: string) => {
    filterRef.current!.push(data);
  }, []);

  // Flush buffered output when this tab becomes visible & active
  useEffect(() => {
    if (visible && active && termApiRef.current && pendingOutput.current.length > 0) {
      const flushed = pendingOutput.current.join('');
      pendingOutput.current = [];
      pendingLen.current = 0;
      termApiRef.current.write(flushed);
      // Force a full redraw after flushing — the bulk write can leave
      // the canvas in a dirty state, especially after long background buffering.
      // Use a short delay instead of a single rAF so this runs AFTER
      // TerminalPane's visibility fit+refresh cycle has settled the layout.
      const timer = setTimeout(() => {
        termApiRef.current?.refresh();
      }, 200);
      return () => clearTimeout(timer);
    }
  }, [visible, active]);

  const { state, send } = useCliSocket({
    projectId,
    worktreeId,
    sessionId: initialSessionId,
    forceNew: !initialSessionId && forceNew,
    mode,
    onOutput: (data) => {
      writeToTerm(data);
    },
    onError: (data) => {
      console.warn(`[TerminalTab] onError:`, data);
      writeToTerm(`\x1b[31m${data}\x1b[0m`);
    },
    onExit: (code) => {
      console.log(`[TerminalTab] onExit: code=${code}`);
      writeToTerm(`\r\n\x1b[33m[Process exited with code ${code}]\x1b[0m\r\n`);
      onStatusChange('exited');
    },
    onReady: (sid) => {
      console.log(`[TerminalTab] onReady: sessionId=${sid}`);
      sessionIdRef.current = sid;
      onSessionId?.(sid);
      if (termApiRef.current) termApiRef.current.fit();
    },
  });

  const handleTermReady = useCallback((api: TerminalPaneAPI) => {
    console.log(`[TerminalTab] handleTermReady called, pending=${pendingOutput.current.length}`);
    termApiRef.current = api;
    onTermApi?.(api);
    // Flush any output that arrived before the terminal was ready
    if (pendingOutput.current.length > 0) {
      for (const chunk of pendingOutput.current) {
        api.write(chunk);
      }
      pendingOutput.current = [];
    }
    api.fit();
  }, [onTermApi]);

  // Log state transitions
  useEffect(() => {
    console.log(`[TerminalTab] WS state: ${state}`);
    onStatusChange(state);
  }, [state, onStatusChange]);

  useEffect(() => {
    if (active && visible && termApiRef.current) {
      requestAnimationFrame(() => {
        termApiRef.current?.fit();
        termApiRef.current?.focus();
      });
    }
  }, [active, visible]);

  useEffect(() => {
    (onKill as unknown as { _getSessionId?: () => string | null })._getSessionId = () => sessionIdRef.current;
  });

  return (
    <div className="absolute inset-0" style={{
      zIndex: active ? 2 : 0,
      display: active ? 'block' : 'none',
    }}>
      <TerminalPane
        onInput={(data) => {
          send({ type: 'input', data });
        }}
        onResize={(cols, rows) => {
          send({ type: 'resize', cols, rows });
        }}
        fontSize={fontSize}
        fontFamily={fontFamily}
        themeName={themeName}
        visible={visible && active}
        onReady={handleTermReady}
      />
    </div>
  );
});

export default function ProjectChatPage({ worktreeId, projectId: projectIdProp, cwd, visible = true }: { worktreeId?: string; projectId?: string; cwd?: string; visible?: boolean }) {
  const { id: routeProjectId } = useParams<{ id: string }>();
  const location = useLocation();
  const projectId = projectIdProp || routeProjectId;
  const detachedTabConfig = useMemo(() => parseDetachedTabConfig(location.search), [location.search]);
  const isDetachedTabView = Boolean(detachedTabConfig);

  // Use cwd as the tab state key for clean directory-based separation;
  // falls back to projectId if cwd is not available
  const tabStateKey = cwd || projectId || '';

  const defaultTheme = localStorage.getItem('pilot-console-theme') || 'Catppuccin';
  const defaultFont = localStorage.getItem('pilot-console-font') || TERMINAL_FONTS[0].family;

  // Restore persisted tab state for this context, or create fresh
  const [tabs, setTabs] = useState<TabMeta[]>(() => {
    if (detachedTabConfig) {
      tabCounter++;
      return [{
        id: `tab-${tabCounter}`,
        label: detachedTabConfig.label || defaultTabLabel(detachedTabConfig.mode, tabCounter),
        mode: detachedTabConfig.mode,
        themeName: defaultTheme,
        fontFamily: defaultFont,
        sessionId: detachedTabConfig.sessionId,
        group: 1,
      }];
    }
    // 1. In-memory cache (fastest — survives route changes)
    const mem = tabStateKey ? projectTabStates.get(tabStateKey) : null;
    if (mem && mem.tabs.length > 0) return mem.tabs;
    // 2. localStorage (survives page refresh)
    if (tabStateKey) {
      const ls = loadTabState(tabStateKey);
      if (ls && ls.tabs.length > 0) {
        const hydrated = rehydrateTabs(ls.tabs);
        return hydrated;
      }
    }
    // 3. Worktree nodes auto-start with a Copilot CLI tab; project nodes start empty
    if (worktreeId) {
      tabCounter++;
      return [{ id: `tab-${tabCounter}`, label: 'Copilot 1', mode: 'cli' as const, themeName: defaultTheme, fontFamily: defaultFont, group: 1 as const }];
    }
    return [];
  });
  const [fontSize, setFontSize] = useState(() => {
    // Per-project font size, fallback to global, fallback to default
    if (tabStateKey) {
      const ls = loadTabState(tabStateKey);
      if (ls?.fontSize) return Math.max(8, Math.min(24, ls.fontSize));
    }
    const saved = localStorage.getItem('pilot-console-font-size');
    return saved ? Math.max(8, Math.min(24, parseInt(saved, 10) || 14)) : 14;
  });
  // Per-project terminal theme (applies to all terminals in this project)
  const [projectThemeName, setProjectThemeName] = useState<string>(() => {
    if (tabStateKey) {
      const mem = projectTabStates.get(tabStateKey);
      if (mem?.themeName) return mem.themeName;
      const ls = loadTabState(tabStateKey);
      if (ls?.themeName) return ls.themeName;
    }
    return defaultTheme;
  });
  // Per-project terminal font family (applies to all terminals in this project)
  const [projectFontFamily, setProjectFontFamily] = useState<string>(() => {
    if (tabStateKey) {
      const mem = projectTabStates.get(tabStateKey);
      if (mem?.fontFamily) return mem.fontFamily;
      const ls = loadTabState(tabStateKey);
      if (ls?.fontFamily) return ls.fontFamily;
    }
    return defaultFont;
  });
  const [tabStatuses, setTabStatuses] = useState<Record<string, string>>({});
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [dragOverTabId, setDragOverTabId] = useState<string | null>(null);
  const { layout, isSplit, groupCount } = useProjectSplit();
  // Active tab per group: Record<groupNumber, tabId>
  const [activeTabIds, setActiveTabIds] = useState<Record<number, string>>(() => {
    const result: Record<number, string> = {};
    if (detachedTabConfig) {
      result[1] = tabs[0]?.id ?? '';
      return result;
    }
    // Try to restore active tab from persistence for group 1
    const mem = tabStateKey ? projectTabStates.get(tabStateKey) : null;
    if (mem?.activeTabId) {
      result[1] = mem.activeTabId;
    } else if (tabStateKey) {
      const ls = loadTabState(tabStateKey);
      if (ls && ls.tabs.length > 0) {
        const origIdx = ls.tabs.findIndex(t => t.id === ls.activeTabId);
        const idx = origIdx >= 0 ? Math.min(origIdx, tabs.length - 1) : 0;
        result[1] = tabs[idx]?.id ?? '';
      } else {
        result[1] = tabs[0]?.id ?? '';
      }
    } else {
      result[1] = tabs[0]?.id ?? '';
    }
    return result;
  });
  const [focusedGroup, setFocusedGroup] = useState(1);

  const firstTabId = useRef(tabs[0]?.id ?? '');
  const killCallbacksRef = useRef<Record<string, (sessionId: string | null) => void>>({});
  const termApiRefsMap = useRef<Record<string, TerminalPaneAPI>>({});
  const statusCallbacksRef = useRef<Record<string, (status: string) => void>>({});
  const sessionIdCallbacksRef = useRef<Record<string, (sid: string) => void>>({});

  // Persist tab state whenever it changes (in-memory + localStorage)
  useEffect(() => {
    if (isDetachedTabView) return;
    if (tabStateKey) {
      const state = { tabs, activeTabId: activeTabIds[1] || '', fontSize, themeName: projectThemeName, fontFamily: projectFontFamily };
      projectTabStates.set(tabStateKey, state);
      saveTabState(tabStateKey, state);
    }
  }, [isDetachedTabView, tabStateKey, tabs, activeTabIds, fontSize, projectThemeName, projectFontFamily]);

  // Also persist global font size for migration/fallback
  useEffect(() => {
    localStorage.setItem('pilot-console-font-size', String(fontSize));
  }, [fontSize]);

  // When layout changes (group count shrinks), remap tabs from removed groups
  const prevGroupCount = useRef(groupCount);
  const prevLayout = useRef(layout);
  useEffect(() => {
    if (prevGroupCount.current > groupCount) {
      const oldLayout = prevLayout.current;
      setTabs(prev => {
        return prev.map(t => {
          if (t.group <= groupCount) return t;
          // Remap: project old group's (row,col) into new grid
          const oldRow = Math.ceil(t.group / oldLayout.cols);
          const oldCol = ((t.group - 1) % oldLayout.cols) + 1;
          const newRow = Math.min(oldRow, layout.rows);
          const newCol = Math.min(oldCol, layout.cols);
          const newGroup = (newRow - 1) * layout.cols + newCol;
          return { ...t, group: newGroup };
        });
      });
      // Clean up active tab IDs for removed groups
      setActiveTabIds(prev => {
        const next: Record<number, string> = {};
        for (let g = 1; g <= groupCount; g++) {
          next[g] = prev[g] || '';
        }
        return next;
      });
      if (focusedGroup > groupCount) setFocusedGroup(1);
    }
    prevGroupCount.current = groupCount;
    prevLayout.current = layout;
  }, [groupCount, layout, focusedGroup]);

  // On mount, reconcile tabs with active daemon sessions.
  // When tabs are restored from localStorage, validate their sessionIds
  // against the server. When no tabs exist, create tabs from active sessions.
  const resumeCheckedRef = useRef(false);
  useEffect(() => {
    if (isDetachedTabView) return;
    if (resumeCheckedRef.current) return;
    if (!projectId) return;
    // Skip if tabs came from in-memory cache (sessions are already live)
    const mem = tabStateKey ? projectTabStates.get(tabStateKey) : null;
    if (mem && mem.tabs.length > 0 && mem.tabs.some(t => t.sessionId)) return;

    resumeCheckedRef.current = true;
    fetch('/api/sessions/active')
      .then(r => r.ok ? r.json() : { sessions: [] })
      .then((data: { sessions: Array<{ projectId: string; worktreeId: string | null; sessionId: string; mode: string; status: string }> }) => {
        const matching = data.sessions.filter(s =>
          s.projectId === projectId &&
          (worktreeId ? s.worktreeId === worktreeId : !s.worktreeId) &&
          s.status !== 'exited'
        );

        setTabs(prev => {
          if (prev.length > 0) {
            // Tabs restored from localStorage — reconcile sessionIds
            const usedSessionIds = new Set<string>();
            const reconciled = prev.map(tab => {
              // Agent (SDK) sessions aren't tracked by /api/sessions/active
              // (that only lists PTY sessions). The agent WS layer resumes them
              // from disk on connect, so keep their id untouched here.
              if (tab.mode === 'agent') return tab;
              if (tab.sessionId) {
                // Validate: is this sessionId still active?
                const stillActive = matching.find(s => s.sessionId === tab.sessionId);
                if (stillActive) {
                  usedSessionIds.add(tab.sessionId);
                  return tab;
                }
                // Session gone — clear the stale ID so a new one is created
                return { ...tab, sessionId: undefined };
              }
              // No sessionId — try to match by mode
              const match = matching.find(s => {
                const sMode = (s.mode === 'shell' || s.mode === 'powershell' || s.mode === 'cli-classic') ? s.mode : 'cli';
                return sMode === tab.mode && !usedSessionIds.has(s.sessionId);
              });
              if (match) {
                usedSessionIds.add(match.sessionId);
                return { ...tab, sessionId: match.sessionId };
              }
              return tab;
            });
            return reconciled;
          }
          // No tabs at all — create from active sessions
          if (matching.length === 0) return prev;
          const newTabs: TabMeta[] = matching.map(s => {
            tabCounter++;
            const mode = (s.mode === 'shell' || s.mode === 'powershell' || s.mode === 'cli-classic') ? s.mode : 'cli';
            const label = defaultTabLabel(mode, tabCounter);
            return { id: `tab-${tabCounter}`, label, mode, themeName: defaultTheme, fontFamily: defaultFont, sessionId: s.sessionId, group: 1 as const };
          });
          return newTabs;
        });
        setActiveTabIds(prev => {
          if (prev[1]) return prev;
          return { ...prev, [1]: '' };
        });
      })
      .catch(() => {});
  }, [isDetachedTabView, projectId, worktreeId, tabStateKey, defaultTheme, defaultFont]);

  const addTab = useCallback((mode: TabMeta['mode'] = 'cli', targetGroup: number = 1) => {
    tabCounter++;
    const label = defaultTabLabel(mode, tabCounter);
    const newTab: TabMeta = { id: `tab-${tabCounter}`, label, mode, themeName: defaultTheme, fontFamily: defaultFont, group: targetGroup };
    setTabs(prev => [...prev, newTab]);
    setActiveTabIds(prev => ({ ...prev, [targetGroup]: newTab.id }));
  }, [defaultTheme, defaultFont]);

  const openTabInBrowserTab = useCallback((tab: TabMeta) => {
    if (!projectId) return;
    const basePath = worktreeId
      ? `/projects/${projectId}/worktrees/${worktreeId}/chat`
      : `/projects/${projectId}/chat`;
    const params = new URLSearchParams();
    params.set('detachedTab', '1');
    params.set('mode', tab.mode);
    if (tab.sessionId) params.set('sessionId', tab.sessionId);
    if (tab.label) params.set('label', tab.label);
    window.open(`${basePath}?${params.toString()}`, '_blank', 'noopener,noreferrer');
  }, [projectId, worktreeId]);

  const moveTab = useCallback((sourceId: string, targetId: string) => {
    if (sourceId === targetId) return;
    setTabs(prev => {
      const sourceIndex = prev.findIndex(t => t.id === sourceId);
      const targetIndex = prev.findIndex(t => t.id === targetId);
      if (sourceIndex < 0 || targetIndex < 0) return prev;
      const next = [...prev];
      const [moved] = next.splice(sourceIndex, 1);
      // Inherit the target tab's group
      moved.group = prev[targetIndex].group;
      next.splice(targetIndex, 0, moved);
      return next;
    });
  }, []);

  const moveTabToGroup = useCallback((tabId: string, targetGroup: number) => {
    setTabs(prev => {
      const tab = prev.find(t => t.id === tabId);
      if (!tab || tab.group === targetGroup) return prev;
      const sourceGroup = tab.group;
      const updated = prev.map(t => t.id === tabId ? { ...t, group: targetGroup } : t);
      // Update active tabs for both groups
      setTimeout(() => {
        setActiveTabIds(prevActive => {
          const next = { ...prevActive, [targetGroup]: tabId };
          // If this was the active tab in source group, select next there
          if (prevActive[sourceGroup] === tabId) {
            const remaining = updated.filter(t => t.group === sourceGroup && t.id !== tabId);
            next[sourceGroup] = remaining[0]?.id ?? '';
          }
          return next;
        });
      }, 0);
      return updated;
    });
  }, []);

  const closeTab = useCallback((tabId: string) => {
    const killCb = killCallbacksRef.current[tabId];
    if (killCb && projectId) {
      const getSessionId = (killCb as unknown as { _getSessionId?: () => string | null })._getSessionId;
      const sid = getSessionId?.();
      if (sid) {
        fetch(`/api/projects/${encodeURIComponent(projectId)}/session?sessionId=${sid}`, { method: 'DELETE' }).catch(() => {});
      }
    }
    delete killCallbacksRef.current[tabId];
    delete statusCallbacksRef.current[tabId];

    const closedTab = tabs.find(t => t.id === tabId);
    const closedGroup = closedTab?.group ?? 1;
    setTabs(prev => prev.filter(t => t.id !== tabId));

    setActiveTabIds(prev => {
      if (prev[closedGroup] !== tabId) return prev;
      const remaining = tabs.filter(t => t.group === closedGroup && t.id !== tabId);
      if (remaining.length === 0) return { ...prev, [closedGroup]: '' };
      const idx = tabs.filter(t => t.group === closedGroup).findIndex(t => t.id === tabId);
      return { ...prev, [closedGroup]: remaining[Math.min(idx, remaining.length - 1)].id };
    });
  }, [projectId, tabs]);

  const handleKillActive = useCallback(async () => {
    const focusedActiveTabId = activeTabIds[focusedGroup] || '';
    const killCb = killCallbacksRef.current[focusedActiveTabId];
    if (!killCb || !projectId) return;
    const getSessionId = (killCb as unknown as { _getSessionId?: () => string | null })._getSessionId;
    const sid = getSessionId?.();
    if (sid) {
      try {
        await fetch(`/api/projects/${encodeURIComponent(projectId)}/session?sessionId=${sid}`, { method: 'DELETE' });
      } catch { /* WS close handles reconnect */ }
    }
  }, [activeTabIds, focusedGroup, projectId]);

  useEffect(() => {
    if (!visible) return; // don't register shortcuts for hidden project pages
    function handler(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      const tag = target?.tagName;
      const isXterm = target?.classList?.contains('xterm-helper-textarea');
      if ((tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') && !isXterm) return;
      if (e.ctrlKey && !e.shiftKey) {
        if (e.key === '=' || e.key === '+') { e.preventDefault(); setFontSize(s => Math.min(24, s + 1)); }
        if (e.key === '-') { e.preventDefault(); setFontSize(s => Math.max(8, s - 1)); }
      }
      if (e.ctrlKey && e.shiftKey) {
        if (e.key === 'K') { e.preventDefault(); handleKillActive(); }
        if (e.key === 'T') { e.preventDefault(); addTab(); }
      }
    }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleKillActive, addTab, visible]);

  if (!projectId) return <div className="p-6 text-muted-foreground">Project not found</div>;

  const renderTabBar = (groupTabs: TabMeta[], groupId: number) => {
    const groupActiveTabId = activeTabIds[groupId] || '';
    const groupActiveTab = groupTabs.find(t => t.id === groupActiveTabId);
    const isFocused = focusedGroup === groupId;

    const showTerminalControls = !!groupActiveTab && groupActiveTab.mode !== 'git' && groupActiveTab.mode !== 'git-status' && groupActiveTab.mode !== 'files';
    const isAgentTab = groupActiveTab?.mode === 'agent';

    return (
      <div className={`border-b bg-muted/30 ${isFocused ? '' : 'opacity-70'}`} onClick={() => setFocusedGroup(groupId)}>
      <div className="flex items-center">
        <div className="flex items-center flex-1 overflow-x-auto min-w-0"
          onDragOver={(e) => {
            // Allow dropping on the empty tab bar area
            if (groupTabs.length === 0) {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
            }
          }}
          onDrop={(e) => {
            if (groupTabs.length === 0) {
              e.preventDefault();
              const sourceId = e.dataTransfer.getData('text/plain') || draggingTabId;
              if (sourceId) moveTabToGroup(sourceId, groupId);
              setDraggingTabId(null);
              setDragOverTabId(null);
            }
          }}
        >
          {groupTabs.length === 0 && (
            <div className="px-3 py-1.5 text-xs text-muted-foreground italic">Drop tab here</div>
          )}
          {groupTabs.map(tab => {
            const isUtilTab = tab.mode === 'git' || tab.mode === 'git-status' || tab.mode === 'files';
            const st = tabStatuses[tab.id] || 'closed';
            const stColor = { open: 'bg-green-500', connecting: 'bg-yellow-500', closed: 'bg-gray-400', error: 'bg-red-500', exited: 'bg-red-500' }[st] ?? 'bg-gray-400';
            const tabIcon = tab.mode === 'powershell'
              ? <span className="h-3 w-3 text-[9px] font-bold leading-3 text-center shrink-0">PS</span>
              : tab.mode === 'shell' ? <Terminal className="h-3 w-3 shrink-0" />
              : tab.mode === 'cli-classic' ? <SquareTerminal className="h-3 w-3 shrink-0" />
              : tab.mode === 'git' ? <GitCommitHorizontal className="h-3 w-3 shrink-0" />
              : tab.mode === 'git-status' ? <GitBranch className="h-3 w-3 shrink-0" />
              : tab.mode === 'files' ? <FolderOpen className="h-3 w-3 shrink-0" />
              : tab.mode === 'agent' ? <Sparkles className="h-3 w-3 shrink-0" />
              : <Bot className="h-3 w-3 shrink-0" />;
            return (
              <div
                key={tab.id}
                draggable
                className={`group flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer border-r shrink-0 transition-opacity ${
                  tab.id === groupActiveTabId
                    ? 'bg-accent text-foreground font-semibold border-b-2 border-b-primary'
                    : 'text-muted-foreground hover:text-foreground hover:bg-background/50'
                } ${draggingTabId === tab.id ? 'opacity-50' : ''} ${dragOverTabId === tab.id && draggingTabId !== tab.id ? 'ring-1 ring-primary ring-inset' : ''}`}
                onClick={() => {
                  setFocusedGroup(groupId);
                  setActiveTabIds(prev => ({ ...prev, [groupId]: tab.id }));
                }}
                onDragStart={(e) => {
                  setDraggingTabId(tab.id);
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', tab.id);
                  e.dataTransfer.setData('application/x-tab-group', String(groupId));
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  setDragOverTabId(tab.id);
                }}
                onDragLeave={() => setDragOverTabId(prev => prev === tab.id ? null : prev)}
                onDrop={(e) => {
                  e.preventDefault();
                  const sourceId = e.dataTransfer.getData('text/plain') || draggingTabId;
                  const sourceGroup = e.dataTransfer.getData('application/x-tab-group');
                  if (sourceId) {
                    const srcGroup = sourceGroup ? parseInt(sourceGroup) : tab.group;
                    if (srcGroup !== groupId) {
                      // Cross-group: move tab to this group
                      moveTabToGroup(sourceId, groupId);
                    } else {
                      // Same group: reorder
                      moveTab(sourceId, tab.id);
                    }
                  }
                  setDraggingTabId(null);
                  setDragOverTabId(null);
                }}
                onDragEnd={() => {
                  setDraggingTabId(null);
                  setDragOverTabId(null);
                }}
                title="Drag to rearrange or move to other pane"
              >
                {!isUtilTab && <div className={`h-1.5 w-1.5 rounded-full ${stColor}`} />}
                {tabIcon}
                <span className="truncate max-w-[100px]">{tab.label}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    openTabInBrowserTab(tab);
                  }}
                  className="h-4 w-4 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:bg-muted"
                  title="Open this tab in a new browser tab"
                >
                  <ExternalLink className="h-3 w-3" />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
                  className={`h-4 w-4 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:bg-muted`}
                >
                  <XIcon className="h-3 w-3" />
                </button>
              </div>
            );
          })}
          <NewTabMenu onSelect={(mode) => addTab(mode, groupId)} />
        </div>
        {/* Terminal controls — only shown when a terminal tab is active */}
        {/* Permanent icon buttons for Git Log, Git Status, Files */}
        <div className="flex items-center shrink-0 border-l gap-0.5 px-1">
          {([
            { mode: 'git' as const, icon: GitCommitHorizontal, title: 'New Git Log tab' },
            { mode: 'git-status' as const, icon: GitBranch, title: 'New Git Status tab' },
            { mode: 'files' as const, icon: FolderOpen, title: 'New Files tab' },
          ]).map(({ mode, icon: Icon, title }) => (
              <button
                key={mode}
                onClick={() => addTab(mode, groupId)}
                className="p-1.5 rounded transition-colors text-muted-foreground hover:text-foreground hover:bg-background/50"
                title={title}
              >
                <Icon className="h-3.5 w-3.5" />
              </button>
          ))}
        </div>
      </div>
      {showTerminalControls && (
        <div className="flex items-center gap-1 px-1.5 py-1 border-t bg-muted/20">
          <div className="flex items-center gap-0.5 border rounded px-1">
            <Type className="h-3 w-3 text-muted-foreground" />
            <select
                value={projectFontFamily}
                onChange={(e) => {
                  const family = e.target.value;
                  setProjectFontFamily(family);
                  localStorage.setItem('pilot-console-font', family);
                }}
                className="h-6 text-xs bg-transparent border-none outline-none px-0.5 text-foreground"
            >
                {TERMINAL_FONTS.map(f => <option key={f.id} value={f.family}>{f.label}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-0.5 border rounded px-1">
            <Palette className="h-3 w-3 text-muted-foreground" />
            <select
                value={projectThemeName}
                onChange={(e) => {
                  const name = e.target.value;
                  setProjectThemeName(name);
                  localStorage.setItem('pilot-console-theme', name);
                }}
                className="h-6 text-xs bg-transparent border-none outline-none px-0.5 text-foreground"
            >
                {THEMES.map(t => <option key={t.name} value={t.name}>{t.name}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-0.5 border rounded px-1">
            <Button variant="ghost" size="icon" className="h-5 w-5" onClick={() => setFontSize(s => Math.max(8, s - 1))} disabled={fontSize <= 8}>
                <Minus className="h-3 w-3" />
            </Button>
            <span className="text-xs w-5 text-center tabular-nums">{fontSize}</span>
            <Button variant="ghost" size="icon" className="h-5 w-5" onClick={() => setFontSize(s => Math.min(24, s + 1))} disabled={fontSize >= 24}>
                <Plus className="h-3 w-3" />
            </Button>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            title="Refresh terminal display (fix rendering corruption)"
            hidden={isAgentTab}
            style={isAgentTab ? { display: 'none' } : undefined}
            onClick={() => {
                const api = termApiRefsMap.current[groupActiveTabId];
                if (!api) return;
                // Mirror what the font-size change does: fit + redraw, which
                // reliably recovers from canvas corruption without clearing
                // the user's scrollback.
                api.fit();
                api.refresh();
            }}
          >
            <RotateCcw className="h-3 w-3" />
          </Button>
        </div>
      )}
      </div>
    );
  };

  const renderPaneContent = (groupId: number) => {
    const groupActiveTabId = activeTabIds[groupId] || '';
    const groupTabs = tabs.filter(t => t.group === groupId);

    return (
      <div className="flex-1 overflow-hidden relative">
        {groupTabs.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <div className="text-center space-y-4">
              <p className="text-sm text-muted-foreground">Drop a tab here or click + to create one</p>
            </div>
          </div>
        )}
        {groupTabs.map(tab => {
          const isActive = tab.id === groupActiveTabId;

          if (tab.mode === 'git') {
            return (
              <div key={tab.id} className="absolute inset-0" style={{ zIndex: isActive ? 2 : 0, display: isActive ? 'block' : 'none' }}>
                <GitLogTab projectId={projectId} worktreeId={worktreeId} />
              </div>
            );
          }
          if (tab.mode === 'git-status') {
            return (
              <div key={tab.id} className="absolute inset-0" style={{ zIndex: isActive ? 2 : 0, display: isActive ? 'block' : 'none' }}>
                <GitPanel projectId={projectId} worktreeId={worktreeId} />
              </div>
            );
          }
          if (tab.mode === 'files') {
            return (
              <div key={tab.id} className="absolute inset-0" style={{ zIndex: isActive ? 2 : 0, display: isActive ? 'block' : 'none' }}>
                <FileExplorer projectId={projectId} worktreeId={worktreeId} embedded />
              </div>
            );
          }
          if (tab.mode === 'agent') {
            if (!statusCallbacksRef.current[tab.id]) {
              statusCallbacksRef.current[tab.id] = (s: string) => setTabStatuses(prev => prev[tab.id] === s ? prev : { ...prev, [tab.id]: s });
            }
            if (!sessionIdCallbacksRef.current[tab.id]) {
              const tabId = tab.id;
              sessionIdCallbacksRef.current[tabId] = (sid: string) => setTabs(prev => prev.map(t => t.id === tabId ? { ...t, sessionId: sid } : t));
            }
            return (
              <div key={tab.id} className="absolute inset-0" style={{ zIndex: isActive ? 2 : 0, display: isActive ? 'block' : 'none' }}>
                <AgentPane
                  projectId={projectId}
                  worktreeId={worktreeId}
                  sessionId={tab.sessionId}
                  active={isActive}
                  themeName={projectThemeName}
                  fontFamily={projectFontFamily}
                  fontSize={fontSize}
                  onSessionId={sessionIdCallbacksRef.current[tab.id]}
                  onStatusChange={statusCallbacksRef.current[tab.id]}
                />
              </div>
            );
          }

          if (!killCallbacksRef.current[tab.id]) {
            killCallbacksRef.current[tab.id] = (() => {}) as (sid: string | null) => void;
          }
          if (!statusCallbacksRef.current[tab.id]) {
            statusCallbacksRef.current[tab.id] = (s: string) => setTabStatuses(prev => prev[tab.id] === s ? prev : { ...prev, [tab.id]: s });
          }
          if (!sessionIdCallbacksRef.current[tab.id]) {
            const tabId = tab.id;
            sessionIdCallbacksRef.current[tabId] = (sid: string) => setTabs(prev => prev.map(t => t.id === tabId ? { ...t, sessionId: sid } : t));
          }
          return (
            <TerminalTab
              key={tab.id}
              projectId={projectId}
              worktreeId={worktreeId}
              fontSize={fontSize}
              fontFamily={projectFontFamily}
              themeName={projectThemeName}
              active={isActive}
              forceNew={tab.mode !== 'cli' || tab.id !== firstTabId.current}
              mode={tab.mode || 'cli'}
              sessionId={tab.sessionId}
              visible={visible}
              onStatusChange={statusCallbacksRef.current[tab.id]}
              onKill={killCallbacksRef.current[tab.id]}
              onSessionId={sessionIdCallbacksRef.current[tab.id]}
              onTermApi={(api) => { termApiRefsMap.current[tab.id] = api; }}
            />
          );
        })}
      </div>
    );
  };

  // Landing page when no tabs exist at all
  const renderLanding = () => (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center space-y-6 max-w-md">
        <div className="space-y-2">
          <h2 className="text-lg font-semibold text-foreground">No active sessions</h2>
          <p className="text-sm text-muted-foreground">
            Start a new session to begin working with this project.
            {cwd && <span className="block mt-1 font-mono text-xs opacity-70">{cwd}</span>}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => addTab('cli')}
            className="flex flex-col items-center gap-2 rounded-lg border p-4 hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <Bot className="h-6 w-6" />
            <div>
              <div className="text-sm font-medium">Copilot CLI</div>
              <div className="text-[10px] text-muted-foreground">AI-powered terminal</div>
            </div>
          </button>
          <button
            onClick={() => addTab('cli-classic')}
            className="flex flex-col items-center gap-2 rounded-lg border p-4 hover:bg-accent hover:text-accent-foreground transition-colors"
            title="Same Copilot CLI, but reports an accurate terminal identity (TERM=xterm-256color) — fixes scrollback glitches at the cost of re-exposing any TUI rendering bugs the default was working around."
          >
            <SquareTerminal className="h-6 w-6" />
            <div>
              <div className="text-sm font-medium">Copilot CLI (classic)</div>
              <div className="text-[10px] text-muted-foreground">True TTY identity</div>
            </div>
          </button>
          <button
            onClick={() => addTab('agent')}
            className="flex flex-col items-center gap-2 rounded-lg border p-4 hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <Sparkles className="h-6 w-6" />
            <div>
              <div className="text-sm font-medium">Copilot Agent</div>
              <div className="text-[10px] text-muted-foreground">SDK chat session</div>
            </div>
          </button>
          <button
            onClick={() => addTab('shell')}
            className="flex flex-col items-center gap-2 rounded-lg border p-4 hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <Terminal className="h-6 w-6" />
            <div>
              <div className="text-sm font-medium">Terminal</div>
              <div className="text-[10px] text-muted-foreground">Plain shell</div>
            </div>
          </button>
          <button
            onClick={() => addTab('powershell')}
            className="flex flex-col items-center gap-2 rounded-lg border p-4 hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <span className="text-lg font-bold leading-6">PS</span>
            <div>
              <div className="text-sm font-medium">PowerShell</div>
              <div className="text-[10px] text-muted-foreground">PowerShell session</div>
            </div>
          </button>
          <button
            onClick={() => addTab('files')}
            className="flex flex-col items-center gap-2 rounded-lg border p-4 hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <FolderOpen className="h-6 w-6" />
            <div>
              <div className="text-sm font-medium">Files</div>
              <div className="text-[10px] text-muted-foreground">Browse project files</div>
            </div>
          </button>
        </div>
        <div className="flex items-center justify-center gap-2 pt-2">
          <button
            onClick={() => addTab('git')}
            className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <GitCommitHorizontal className="h-3.5 w-3.5" /> Git Log
          </button>
          <button
            onClick={() => addTab('git-status')}
            className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <GitBranch className="h-3.5 w-3.5" /> Git Status
          </button>
        </div>
      </div>
    </div>
  );

  // Ensure every visible group has an active tab set
  for (let g = 1; g <= groupCount; g++) {
    if (!activeTabIds[g]) {
      const groupTabs = tabs.filter(t => t.group === g);
      if (groupTabs.length > 0 && activeTabIds[g] !== groupTabs[0].id) {
        // Defer to avoid setting state during render
        const firstId = groupTabs[0].id;
        setTimeout(() => setActiveTabIds(prev => prev[g] ? prev : { ...prev, [g]: firstId }), 0);
      }
    }
  }

  return (
    <div className="flex h-full flex-col">
      {tabs.length === 0 ? renderLanding() : isSplit ? (
        <div
          className="flex-1 overflow-hidden"
          style={{
            display: 'grid',
            gridTemplateRows: `repeat(${layout.rows}, 1fr)`,
            gridTemplateColumns: `repeat(${layout.cols}, 1fr)`,
            gap: '2px',
          }}
        >
          {Array.from({ length: groupCount }, (_, i) => {
            const groupId = i + 1;
            const groupTabs = tabs.filter(t => t.group === groupId);
            return (
              <div key={groupId} className="flex flex-col overflow-hidden bg-background" style={{ minWidth: 0, minHeight: 0 }}>
                {renderTabBar(groupTabs, groupId)}
                {renderPaneContent(groupId)}
              </div>
            );
          })}
        </div>
      ) : (
        <>
          {renderTabBar(tabs.filter(t => t.group === 1 || !isSplit), 1)}
          {renderPaneContent(1)}
        </>
      )}
    </div>
  );
}
