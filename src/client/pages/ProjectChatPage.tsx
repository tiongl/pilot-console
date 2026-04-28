import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { useCliSocket } from '../../../hooks/useCliSocket';
import TerminalPane, { type TerminalPaneAPI, TERMINAL_FONTS } from '../../../components/terminal/TerminalPane';
import { Button } from '../../../components/ui/button';
import { Square, Minus, Plus, Palette, Type, X as XIcon } from 'lucide-react';
import { THEMES } from '../../../lib/terminal-themes';

interface TabMeta {
  id: string;
  label: string;
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

/**
 * Each tab owns its own WS connection and TerminalPane.
 * Output is written directly to xterm (no React state accumulation).
 */
function TerminalTab({
  projectId, fontSize, fontFamily, themeName, active, forceNew, sessionId: initialSessionId, onStatusChange, onKill, onSessionId,
}: {
  projectId?: string;
  fontSize: number;
  fontFamily: string;
  themeName: string;
  active: boolean;
  forceNew: boolean;
  sessionId?: string;
  onStatusChange: (status: string) => void;
  onKill: (sessionId: string | null) => void;
  onSessionId?: (sessionId: string) => void;
}) {
  const sessionIdRef = useRef<string | null>(initialSessionId ?? null);
  const termApiRef = useRef<TerminalPaneAPI | null>(null);
  const pendingOutput = useRef<string[]>([]);

  const writeToTerm = useCallback((data: string) => {
    if (termApiRef.current) {
      termApiRef.current.write(data);
    } else {
      pendingOutput.current.push(data);
      console.log(`[TerminalTab] buffered ${data.length} chars (terminal not ready)`);
    }
  }, []);

  const { state, send } = useCliSocket({
    projectId,
    sessionId: initialSessionId,
    forceNew: !initialSessionId && forceNew,
    onOutput: (data) => {
      console.log(`[TerminalTab] onOutput: ${data.length} chars, termApi=${!!termApiRef.current}`);
      writeToTerm(data);
    },
    onError: (data) => {
      console.warn(`[TerminalTab] onError:`, data);
      writeToTerm(`\x1b[31m${data}\x1b[0m`);
    },
    onExit: (code) => {
      console.log(`[TerminalTab] onExit: code=${code}`);
      writeToTerm(`\r\n\x1b[33m[Process exited with code ${code}]\x1b[0m\r\n`);
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
      zIndex: active ? 1 : 0,
      visibility: active ? 'visible' : 'hidden',
    }}>
      <TerminalPane
        onInput={(data) => {
          console.log(`[TerminalTab] onInput: ${JSON.stringify(data)}, wsState=${state}`);
          send({ type: 'input', data });
        }}
        onResize={(cols, rows) => {
          console.log(`[TerminalTab] onResize: ${cols}x${rows}`);
          send({ type: 'resize', cols, rows });
        }}
        fontSize={fontSize}
        fontFamily={fontFamily}
        themeName={themeName}
        onReady={handleTermReady}
      />
    </div>
  );
}

export default function ProjectChatPage() {
  const { id: projectId } = useParams<{ id: string }>();

  const defaultTheme = localStorage.getItem('gcclippy-theme') || 'Catppuccin';
  const defaultFont = localStorage.getItem('gcclippy-font') || TERMINAL_FONTS[0].family;

  // Restore persisted tab state for this project, or create fresh
  const [tabs, setTabs] = useState<TabMeta[]>(() => {
    const saved = projectId ? projectTabStates.get(projectId) : null;
    if (saved && saved.tabs.length > 0) return saved.tabs;
    tabCounter++;
    return [{ id: `tab-${tabCounter}`, label: 'Terminal 1', themeName: defaultTheme, fontFamily: defaultFont }];
  });
  const [activeTabId, setActiveTabId] = useState(() => {
    const saved = projectId ? projectTabStates.get(projectId) : null;
    return saved?.activeTabId ?? tabs[0].id;
  });
  const [fontSize, setFontSize] = useState(() => {
    const saved = projectId ? projectTabStates.get(projectId) : null;
    return saved?.fontSize ?? 14;
  });
  const [tabStatuses, setTabStatuses] = useState<Record<string, string>>({});

  const firstTabId = useRef(tabs[0].id);
  const killCallbacksRef = useRef<Record<string, (sessionId: string | null) => void>>({});
  const statusCallbacksRef = useRef<Record<string, (status: string) => void>>({});

  // Persist tab state whenever it changes
  useEffect(() => {
    if (projectId) {
      projectTabStates.set(projectId, { tabs, activeTabId, fontSize });
    }
  }, [projectId, tabs, activeTabId, fontSize]);

  const addTab = useCallback(() => {
    tabCounter++;
    const newTab: TabMeta = { id: `tab-${tabCounter}`, label: `Terminal ${tabCounter}`, themeName: defaultTheme, fontFamily: defaultFont };
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTab.id);
  }, [defaultTheme, defaultFont]);

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

    setTabs(prev => {
      const next = prev.filter(t => t.id !== tabId);
      if (next.length === 0) {
        tabCounter++;
        return [{ id: `tab-${tabCounter}`, label: `Terminal ${tabCounter}`, themeName: defaultTheme, fontFamily: defaultFont }];
      }
      return next;
    });
    setActiveTabId(prev => {
      if (prev !== tabId) return prev;
      const idx = tabs.findIndex(t => t.id === tabId);
      const remaining = tabs.filter(t => t.id !== tabId);
      if (remaining.length === 0) return `tab-${tabCounter}`;
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
    function handler(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
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
  }, [handleKillActive, addTab]);

  const activeStatus = tabStatuses[activeTabId] || 'closed';
  const statusColor = { open: 'bg-green-500', connecting: 'bg-yellow-500', closed: 'bg-gray-400', error: 'bg-red-500' }[activeStatus] ?? 'bg-gray-400';
  const activeTab = tabs.find(t => t.id === activeTabId);
  const activeThemeName = activeTab?.themeName ?? defaultTheme;
  const activeFontFamily = activeTab?.fontFamily ?? defaultFont;

  const setActiveTheme = useCallback((name: string) => {
    setTabs(prev => prev.map(t => t.id === activeTabId ? { ...t, themeName: name } : t));
    localStorage.setItem('gcclippy-theme', name);
  }, [activeTabId]);

  const setActiveFont = useCallback((family: string) => {
    setTabs(prev => prev.map(t => t.id === activeTabId ? { ...t, fontFamily: family } : t));
    localStorage.setItem('gcclippy-font', family);
  }, [activeTabId]);

  if (!projectId) return <div className="p-6 text-muted-foreground">Project not found</div>;

  return (
    <div className="flex h-full flex-col">
      {/* Tab bar + controls */}
      <div className="flex items-center border-b bg-muted/30">
        <div className="flex items-center flex-1 overflow-x-auto min-w-0">
          {tabs.map(tab => {
            const st = tabStatuses[tab.id] || 'closed';
            const stColor = { open: 'bg-green-500', connecting: 'bg-yellow-500', closed: 'bg-gray-400', error: 'bg-red-500' }[st] ?? 'bg-gray-400';
            return (
              <div
                key={tab.id}
                className={`group flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer border-r shrink-0 ${
                  tab.id === activeTabId
                    ? 'bg-background text-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-background/50'
                }`}
                onClick={() => setActiveTabId(tab.id)}
              >
                <div className={`h-1.5 w-1.5 rounded-full ${stColor}`} />
                <span className="truncate max-w-[100px]">{tab.label}</span>
                {tabs.length > 1 && (
                  <button
                    onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
                    className="h-4 w-4 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:bg-muted"
                  >
                    <XIcon className="h-3 w-3" />
                  </button>
                )}
              </div>
            );
          })}
          <button
            onClick={addTab}
            className="px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-background/50 shrink-0"
            title="New terminal (Ctrl+Shift+T)"
          >
            +
          </button>
        </div>
        <div className="flex items-center gap-2 px-3 shrink-0 border-l">
          <div className="flex items-center gap-1 border rounded-md px-1">
            <Type className="h-3 w-3 text-muted-foreground ml-1" />
            <select
              value={activeFontFamily}
              onChange={(e) => setActiveFont(e.target.value)}
              className="h-6 text-xs bg-transparent border-none outline-none px-1 text-foreground"
            >
              {TERMINAL_FONTS.map(f => <option key={f.id} value={f.family}>{f.label}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-1 border rounded-md px-1">
            <Palette className="h-3 w-3 text-muted-foreground ml-1" />
            <select
              value={activeThemeName}
              onChange={(e) => setActiveTheme(e.target.value)}
              className="h-6 text-xs bg-transparent border-none outline-none px-1 text-foreground"
            >
              {THEMES.map(t => <option key={t.name} value={t.name}>{t.name}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-1 border rounded-md px-1">
            <Button variant="ghost" size="icon" className="h-5 w-5" onClick={() => setFontSize(s => Math.max(10, s - 1))} disabled={fontSize <= 10}>
              <Minus className="h-3 w-3" />
            </Button>
            <span className="text-xs w-5 text-center tabular-nums">{fontSize}</span>
            <Button variant="ghost" size="icon" className="h-5 w-5" onClick={() => setFontSize(s => Math.min(24, s + 1))} disabled={fontSize >= 24}>
              <Plus className="h-3 w-3" />
            </Button>
          </div>
          <Button variant="ghost" size="sm" className="h-6 text-xs text-destructive hover:text-destructive" onClick={handleKillActive} disabled={activeStatus !== 'open'} title="Kill active session (Ctrl+Shift+K)">
            <Square className="h-3 w-3 mr-1" />
            Kill
          </Button>
        </div>
      </div>

      {/* Terminal content — all tabs stay mounted, hidden via CSS */}
      <div className="flex-1 overflow-hidden relative">
        {tabs.map(tab => {
          if (!killCallbacksRef.current[tab.id]) {
            killCallbacksRef.current[tab.id] = (() => {}) as (sid: string | null) => void;
          }
          if (!statusCallbacksRef.current[tab.id]) {
            statusCallbacksRef.current[tab.id] = (s: string) => setTabStatuses(prev => ({ ...prev, [tab.id]: s }));
          }
          return (
            <TerminalTab
              key={tab.id}
              projectId={projectId}
              fontSize={fontSize}
              fontFamily={tab.fontFamily || defaultFont}
              themeName={tab.themeName || defaultTheme}
              active={tab.id === activeTabId}
              forceNew={tab.id !== firstTabId.current}
              sessionId={tab.sessionId}
              onStatusChange={statusCallbacksRef.current[tab.id]}
              onKill={killCallbacksRef.current[tab.id]}
              onSessionId={(sid) => setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, sessionId: sid } : t))}
            />
          );
        })}
      </div>
    </div>
  );
}
