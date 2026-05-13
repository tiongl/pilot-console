import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useParams } from 'react-router';
import { useCliSocket } from '../hooks/useCliSocket';
import TerminalPane, { type TerminalPaneAPI, TERMINAL_FONTS } from '../components/terminal/TerminalPane';
import { Button } from '../components/ui/button';
import { Square, Minus, Plus, Palette, Type, X as XIcon, Terminal, Bot, GitCommitHorizontal, GitBranch, FolderOpen } from 'lucide-react';
import { THEMES } from '../lib/terminal-themes';
import GitLogTab from '../components/project/GitLogTab';
import GitPanel from '../components/project/GitPanel';
import FileExplorer from '../components/project/FileExplorer';

interface TabMeta {
  id: string;
  label: string;
  mode: 'cli' | 'shell' | 'powershell' | 'git' | 'git-status' | 'files';
  themeName: string;
  fontFamily: string;
  sessionId?: string;
}

let tabCounter = 0;

/** Persists tab state per project across route changes (component remounts). */
interface ProjectTabState {
  tabs: TabMeta[];
  activeTabId: string;
  fontSize: number;
}
const projectTabStates = new Map<string, ProjectTabState>();

const MAX_HIDDEN_BUFFER = 100_000; // chars to retain for hidden terminals

/**
 * Each tab owns its own WS connection and TerminalPane.
 * Output is written directly to xterm (no React state accumulation).
 */
const TerminalTab = React.memo(function TerminalTab({
  projectId, worktreeId, fontSize, fontFamily, themeName, active, forceNew, mode, sessionId: initialSessionId, onStatusChange, onKill, onSessionId, visible = true,
}: {
  projectId?: string;
  worktreeId?: string;
  fontSize: number;
  fontFamily: string;
  themeName: string;
  active: boolean;
  forceNew: boolean;
  mode: 'cli' | 'shell' | 'powershell';
  sessionId?: string;
  onStatusChange: (status: string) => void;
  onKill: (sessionId: string | null) => void;
  onSessionId?: (sessionId: string) => void;
  /** Whether this terminal's project is currently visible on screen */
  visible?: boolean;
}) {
  const sessionIdRef = useRef<string | null>(initialSessionId ?? null);
  const termApiRef = useRef<TerminalPaneAPI | null>(null);
  const pendingOutput = useRef<string[]>([]);

  const visibleAndActiveRef = useRef(visible && active);
  visibleAndActiveRef.current = visible && active;

  const pendingLen = useRef(0);

  const writeToTerm = useCallback((data: string) => {
    if (termApiRef.current) {
      // Buffer output for hidden/inactive terminals to avoid xterm rendering
      // work on the main thread while the user is typing in another tab.
      if (!visibleAndActiveRef.current) {
        pendingOutput.current.push(data);
        pendingLen.current += data.length;
        // Cap hidden buffer to prevent unbounded memory growth.
        // When over limit, compact to the tail (most recent output).
        if (pendingLen.current > MAX_HIDDEN_BUFFER) {
          const joined = pendingOutput.current.join('');
          const trimmed = joined.slice(-MAX_HIDDEN_BUFFER);
          pendingOutput.current = [trimmed];
          pendingLen.current = trimmed.length;
        }
        return;
      }
      // Use batched writes so rapid WS messages coalesce into one render frame
      termApiRef.current.writeBatched(data);
    } else {
      pendingOutput.current.push(data);
      pendingLen.current += data.length;
    }
  }, []);

  // Flush buffered output when this tab becomes visible & active
  useEffect(() => {
    if (visible && active && termApiRef.current && pendingOutput.current.length > 0) {
      const flushed = pendingOutput.current.join('');
      pendingOutput.current = [];
      pendingLen.current = 0;
      termApiRef.current.write(flushed);
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
    // Flush any output that arrived before the terminal was ready
    if (pendingOutput.current.length > 0) {
      for (const chunk of pendingOutput.current) {
        api.write(chunk);
      }
      pendingOutput.current = [];
    }
    api.fit();
  }, []);

  // Log state transitions
  useEffect(() => {
    console.log(`[TerminalTab] WS state: ${state}`);
    onStatusChange(state);
  }, [state, onStatusChange]);

  useEffect(() => {
    if (active && termApiRef.current) {
      termApiRef.current.fit();
      termApiRef.current.focus();
    }
  }, [active]);

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

export default function ProjectChatPage({ worktreeId, projectId: projectIdProp, visible = true }: { worktreeId?: string; projectId?: string; visible?: boolean }) {
  const { id: routeProjectId } = useParams<{ id: string }>();
  const projectId = projectIdProp || routeProjectId;

  const defaultTheme = localStorage.getItem('pilot-console-theme') || 'Catppuccin';
  const defaultFont = localStorage.getItem('pilot-console-font') || TERMINAL_FONTS[0].family;

  // Restore persisted tab state for this project, or create fresh
  const [tabs, setTabs] = useState<TabMeta[]>(() => {
    const saved = projectId ? projectTabStates.get(projectId) : null;
    if (saved && saved.tabs.length > 0) return saved.tabs;
    tabCounter++;
    return [{ id: `tab-${tabCounter}`, label: 'Copilot 1', mode: 'cli' as const, themeName: defaultTheme, fontFamily: defaultFont }];
  });
  const [activeTabId, setActiveTabId] = useState(() => {
    const saved = projectId ? projectTabStates.get(projectId) : null;
    return saved?.activeTabId ?? tabs[0].id;
  });
  const [fontSize, setFontSize] = useState(() => {
    const saved = localStorage.getItem('pilot-console-font-size');
    return saved ? Math.max(10, Math.min(24, parseInt(saved, 10) || 14)) : 14;
  });
  const [tabStatuses, setTabStatuses] = useState<Record<string, string>>({});
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [dragOverTabId, setDragOverTabId] = useState<string | null>(null);

  const firstTabId = useRef(tabs[0].id);
  const killCallbacksRef = useRef<Record<string, (sessionId: string | null) => void>>({});
  const statusCallbacksRef = useRef<Record<string, (status: string) => void>>({});
  const sessionIdCallbacksRef = useRef<Record<string, (sid: string) => void>>({});

  // Persist tab state whenever it changes (in-memory for cross-route survival)
  useEffect(() => {
    if (projectId) {
      projectTabStates.set(projectId, { tabs, activeTabId, fontSize });
    }
  }, [projectId, tabs, activeTabId, fontSize]);

  // Persist font size to localStorage (survives page refresh)
  useEffect(() => {
    localStorage.setItem('pilot-console-font-size', String(fontSize));
  }, [fontSize]);

  const [showNewMenu, setShowNewMenu] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const plusBtnRef = useRef<HTMLDivElement>(null);

  // Position the portal menu relative to the + button
  useEffect(() => {
    if (showNewMenu && plusBtnRef.current) {
      const rect = plusBtnRef.current.getBoundingClientRect();
      setMenuPos({ top: rect.bottom + 2, left: rect.left });
    }
  }, [showNewMenu]);

  // Close new-tab menu on outside click
  useEffect(() => {
    if (!showNewMenu) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-new-tab-menu]')) setShowNewMenu(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showNewMenu]);

  const addTab = useCallback((mode: 'cli' | 'shell' | 'powershell' | 'git' | 'git-status' | 'files' = 'cli') => {
    tabCounter++;
    const label = mode === 'shell' ? `Shell ${tabCounter}` : mode === 'powershell' ? `PS ${tabCounter}` : mode === 'git' ? `Git Log ${tabCounter}` : mode === 'git-status' ? `Git Status ${tabCounter}` : mode === 'files' ? `Files ${tabCounter}` : `Copilot ${tabCounter}`;
    const newTab: TabMeta = { id: `tab-${tabCounter}`, label, mode, themeName: defaultTheme, fontFamily: defaultFont };
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTab.id);
  }, [defaultTheme, defaultFont]);

  const moveTab = useCallback((sourceId: string, targetId: string) => {
    if (sourceId === targetId) return;
    setTabs(prev => {
      const sourceIndex = prev.findIndex(t => t.id === sourceId);
      const targetIndex = prev.findIndex(t => t.id === targetId);
      if (sourceIndex < 0 || targetIndex < 0) return prev;
      const next = [...prev];
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
  }, []);

  const closeTab = useCallback((tabId: string) => {
    // Prevent closing the last tab — always keep at least one open
    if (tabs.length <= 1) return;

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

    setTabs(prev => {
      const next = prev.filter(t => t.id !== tabId);
      return next;
    });
    setActiveTabId(prev => {
      if (prev !== tabId) return prev;
      const idx = tabs.findIndex(t => t.id === tabId);
      const remaining = tabs.filter(t => t.id !== tabId);
      if (remaining.length === 0) return '';
      return remaining[Math.min(idx, remaining.length - 1)].id;
    });
  }, [projectId, tabs]);

  const handleKillActive = useCallback(async () => {
    const killCb = killCallbacksRef.current[activeTabId];
    if (!killCb || !projectId) return;
    const getSessionId = (killCb as unknown as { _getSessionId?: () => string | null })._getSessionId;
    const sid = getSessionId?.();
    if (sid) {
      try {
        await fetch(`/api/projects/${encodeURIComponent(projectId)}/session?sessionId=${sid}`, { method: 'DELETE' });
      } catch { /* WS close handles reconnect */ }
    }
  }, [activeTabId, projectId]);

  useEffect(() => {
    if (!visible) return; // don't register shortcuts for hidden project pages
    function handler(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      const tag = target?.tagName;
      const isXterm = target?.classList?.contains('xterm-helper-textarea');
      if ((tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') && !isXterm) return;
      if (e.ctrlKey && !e.shiftKey) {
        if (e.key === '=' || e.key === '+') { e.preventDefault(); setFontSize(s => Math.min(24, s + 1)); }
        if (e.key === '-') { e.preventDefault(); setFontSize(s => Math.max(10, s - 1)); }
      }
      if (e.ctrlKey && e.shiftKey) {
        if (e.key === 'K') { e.preventDefault(); handleKillActive(); }
        if (e.key === 'T') { e.preventDefault(); addTab(); }
      }
    }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleKillActive, addTab, visible]);

  const activeTab = tabs.find(t => t.id === activeTabId);
  const activeThemeName = activeTab?.themeName ?? defaultTheme;
  const activeFontFamily = activeTab?.fontFamily ?? defaultFont;

  const setActiveTheme = useCallback((name: string) => {
    setTabs(prev => prev.map(t => t.id === activeTabId ? { ...t, themeName: name } : t));
    localStorage.setItem('pilot-console-theme', name);
  }, [activeTabId]);

  const setActiveFont = useCallback((family: string) => {
    setTabs(prev => prev.map(t => t.id === activeTabId ? { ...t, fontFamily: family } : t));
    localStorage.setItem('pilot-console-font', family);
  }, [activeTabId]);

  if (!projectId) return <div className="p-6 text-muted-foreground">Project not found</div>;

  return (
    <div className="flex h-full flex-col">
      {/* Tab bar + controls */}
      <div className="flex items-center border-b bg-muted/30">
        <div className="flex items-center flex-1 overflow-x-auto min-w-0">
          {tabs.map(tab => {
            const isUtilTab = tab.mode === 'git' || tab.mode === 'git-status' || tab.mode === 'files';
            const st = tabStatuses[tab.id] || 'closed';
            const stColor = { open: 'bg-green-500', connecting: 'bg-yellow-500', closed: 'bg-gray-400', error: 'bg-red-500', exited: 'bg-red-500' }[st] ?? 'bg-gray-400';
            const tabIcon = tab.mode === 'powershell'
              ? <span className="h-3 w-3 text-[9px] font-bold leading-3 text-center shrink-0">PS</span>
              : tab.mode === 'shell' ? <Terminal className="h-3 w-3 shrink-0" />
              : tab.mode === 'git' ? <GitCommitHorizontal className="h-3 w-3 shrink-0" />
              : tab.mode === 'git-status' ? <GitBranch className="h-3 w-3 shrink-0" />
              : tab.mode === 'files' ? <FolderOpen className="h-3 w-3 shrink-0" />
              : <Bot className="h-3 w-3 shrink-0" />;
            return (
              <div
                key={tab.id}
                draggable
                className={`group flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer border-r shrink-0 transition-opacity ${
                  tab.id === activeTabId
                    ? 'bg-accent text-foreground font-semibold border-b-2 border-b-primary'
                    : 'text-muted-foreground hover:text-foreground hover:bg-background/50'
                } ${draggingTabId === tab.id ? 'opacity-50' : ''} ${dragOverTabId === tab.id && draggingTabId !== tab.id ? 'ring-1 ring-primary ring-inset' : ''}`}
                onClick={() => setActiveTabId(tab.id)}
                onDragStart={(e) => {
                  setDraggingTabId(tab.id);
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', tab.id);
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
                  if (sourceId) moveTab(sourceId, tab.id);
                  setDraggingTabId(null);
                  setDragOverTabId(null);
                }}
                onDragEnd={() => {
                  setDraggingTabId(null);
                  setDragOverTabId(null);
                }}
                title="Drag to rearrange tab"
              >
                {!isUtilTab && <div className={`h-1.5 w-1.5 rounded-full ${stColor}`} />}
                {tabIcon}
                <span className="truncate max-w-[100px]">{tab.label}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
                  className={`h-4 w-4 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:bg-muted ${tabs.length <= 1 ? 'invisible' : ''}`}
                  disabled={tabs.length <= 1}
                >
                  <XIcon className="h-3 w-3" />
                </button>
              </div>
            );
          })}
          <div className="shrink-0" data-new-tab-menu ref={plusBtnRef}>
            <button
              onClick={(e) => { e.stopPropagation(); setShowNewMenu(v => !v); }}
              className="px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-background/50"
              title="New tab"
            >
              +
            </button>
          </div>
        </div>
        {/* Terminal controls — only shown when a terminal tab is active */}
        {activeTab && activeTab.mode !== 'git' && activeTab.mode !== 'git-status' && activeTab.mode !== 'files' && (
          <div className="flex items-center shrink-0 border-l gap-1 px-1.5">
            <div className="flex items-center gap-0.5 border rounded px-1">
              <Type className="h-3 w-3 text-muted-foreground" />
              <select
                value={activeFontFamily}
                onChange={(e) => setActiveFont(e.target.value)}
                className="h-6 text-xs bg-transparent border-none outline-none px-0.5 text-foreground"
              >
                {TERMINAL_FONTS.map(f => <option key={f.id} value={f.family}>{f.label}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-0.5 border rounded px-1">
              <Palette className="h-3 w-3 text-muted-foreground" />
              <select
                value={activeThemeName}
                onChange={(e) => setActiveTheme(e.target.value)}
                className="h-6 text-xs bg-transparent border-none outline-none px-0.5 text-foreground"
              >
                {THEMES.map(t => <option key={t.name} value={t.name}>{t.name}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-0.5 border rounded px-1">
              <Button variant="ghost" size="icon" className="h-5 w-5" onClick={() => setFontSize(s => Math.max(10, s - 1))} disabled={fontSize <= 10}>
                <Minus className="h-3 w-3" />
              </Button>
              <span className="text-xs w-5 text-center tabular-nums">{fontSize}</span>
              <Button variant="ghost" size="icon" className="h-5 w-5" onClick={() => setFontSize(s => Math.min(24, s + 1))} disabled={fontSize >= 24}>
                <Plus className="h-3 w-3" />
              </Button>
            </div>
          </div>
        )}
        {/* Permanent icon buttons for Git Log, Git Status, Files */}
        <div className="flex items-center shrink-0 border-l gap-0.5 px-1">
          {([
            { mode: 'git' as const, icon: GitCommitHorizontal, title: 'New Git Log tab' },
            { mode: 'git-status' as const, icon: GitBranch, title: 'New Git Status tab' },
            { mode: 'files' as const, icon: FolderOpen, title: 'New Files tab' },
          ]).map(({ mode, icon: Icon, title }) => (
              <button
                key={mode}
                onClick={() => addTab(mode)}
                className="p-1.5 rounded transition-colors text-muted-foreground hover:text-foreground hover:bg-background/50"
                title={title}
              >
                <Icon className="h-3.5 w-3.5" />
              </button>
          ))}
        </div>
        {showNewMenu && createPortal(
          <div
            className="fixed z-50 rounded-md border bg-popover p-1 shadow-md text-xs min-w-[140px]"
            style={menuPos}
            data-new-tab-menu
          >
            <button
              onClick={() => { addTab('cli'); setShowNewMenu(false); }}
              className="flex items-center gap-2 w-full rounded px-2 py-1.5 hover:bg-accent text-left"
            >
              <Bot className="h-3.5 w-3.5" /> Copilot CLI
            </button>
            <button
              onClick={() => { addTab('shell'); setShowNewMenu(false); }}
              className="flex items-center gap-2 w-full rounded px-2 py-1.5 hover:bg-accent text-left"
            >
              <Terminal className="h-3.5 w-3.5" /> Terminal
            </button>
            <button
              onClick={() => { addTab('powershell'); setShowNewMenu(false); }}
              className="flex items-center gap-2 w-full rounded px-2 py-1.5 hover:bg-accent text-left"
            >
              <span className="h-3.5 w-3.5 text-[10px] font-bold leading-[14px] text-center">PS</span> PowerShell
            </button>
          </div>,
          document.body
        )}
      </div>

      {/* Terminal content — all tabs stay mounted, hidden via CSS */}
      <div className="flex-1 overflow-hidden relative">
        {tabs.length === 0 && (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            Click <Plus className="h-4 w-4 mx-1 inline" /> to open a terminal
          </div>
        )}
        {tabs.map(tab => {
          // Git tab renders GitLogTab instead of a terminal
          if (tab.mode === 'git') {
            return (
              <div key={tab.id} className="absolute inset-0" style={{
                zIndex: tab.id === activeTabId ? 2 : 0,
                display: tab.id === activeTabId ? 'block' : 'none',
              }}>
                <GitLogTab projectId={projectId} worktreeId={worktreeId} />
              </div>
            );
          }

          // Git Status tab renders GitPanel
          if (tab.mode === 'git-status') {
            return (
              <div key={tab.id} className="absolute inset-0" style={{
                zIndex: tab.id === activeTabId ? 2 : 0,
                display: tab.id === activeTabId ? 'block' : 'none',
              }}>
                <GitPanel projectId={projectId} worktreeId={worktreeId} />
              </div>
            );
          }

          // Files tab renders FileExplorer embedded
          if (tab.mode === 'files') {
            return (
              <div key={tab.id} className="absolute inset-0" style={{
                zIndex: tab.id === activeTabId ? 2 : 0,
                display: tab.id === activeTabId ? 'block' : 'none',
              }}>
                <FileExplorer projectId={projectId} worktreeId={worktreeId} embedded />
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
              fontFamily={tab.fontFamily || defaultFont}
              themeName={tab.themeName || defaultTheme}
              active={tab.id === activeTabId}
              forceNew={tab.mode !== 'cli' || tab.id !== firstTabId.current}
              mode={tab.mode || 'cli'}
              sessionId={tab.sessionId}
              visible={visible}
              onStatusChange={statusCallbacksRef.current[tab.id]}
              onKill={killCallbacksRef.current[tab.id]}
              onSessionId={sessionIdCallbacksRef.current[tab.id]}
            />
          );
        })}
      </div>
    </div>
  );
}
