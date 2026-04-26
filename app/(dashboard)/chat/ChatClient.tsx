'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useCliSocket } from '@/hooks/useCliSocket';
import TerminalPane from '@/components/terminal/TerminalPane';
import { Button } from '@/components/ui/button';
import { Square, Minus, Plus, Palette, X as XIcon } from 'lucide-react';
import { THEMES } from '@/lib/terminal-themes';

interface Props {
  userName: string | null;
  projectId?: string;
}

interface TabMeta {
  id: string;
  label: string;
}

let tabCounter = 0;

/**
 * Each tab owns its own WS connection, output state, and TerminalPane.
 * Parent only manages tab list and active tab — no output flows through parent state.
 */
function TerminalTab({
  projectId, fontSize, themeName, active, forceNew, onStatusChange, onKill,
}: {
  projectId?: string;
  fontSize: number;
  themeName: string;
  active: boolean;
  forceNew: boolean;
  onStatusChange: (status: string) => void;
  onKill: (sessionId: string | null) => void;
}) {
  const [output, setOutput] = useState('');
  const sessionIdRef = useRef<string | null>(null);
  const fitTermRef = useRef<(() => void) | null>(null);

  const appendOutput = useCallback((data: string) => {
    setOutput(prev => prev + data);
  }, []);

  const { state, send } = useCliSocket({
    projectId,
    forceNew,
    onOutput: appendOutput,
    onError: (data) => appendOutput(`\x1b[31m${data}\x1b[0m`),
    onExit: (code) => {
      appendOutput(`\r\n\x1b[33m[Process exited with code ${code}]\x1b[0m\r\n`);
    },
    onReady: (sessionId) => {
      sessionIdRef.current = sessionId;
    },
  });

  // Report status changes to parent for tab indicator
  useEffect(() => { onStatusChange(state); }, [state, onStatusChange]);

  // Re-fit terminal when tab becomes active (ensures proper dimensions)
  useEffect(() => {
    if (active && fitTermRef.current) {
      fitTermRef.current();
    }
  }, [active]);

  // Expose kill for parent
  useEffect(() => {
    (onKill as unknown as { _getSessionId?: () => string | null })._getSessionId = () => sessionIdRef.current;
  });

  return (
    <div className="absolute inset-0" style={{
      zIndex: active ? 1 : 0,
      visibility: active ? 'visible' : 'hidden',
    }}>
      <TerminalPane
        output={output}
        onInput={(data) => send({ type: 'input', data })}
        onResize={(cols, rows) => send({ type: 'resize', cols, rows })}
        fontSize={fontSize}
        themeName={themeName}
        onFitRef={(fn) => { fitTermRef.current = fn; }}
      />
    </div>
  );
}

export default function ChatClient({ userName: _userName, projectId }: Props) {
  const [tabs, setTabs] = useState<TabMeta[]>(() => {
    tabCounter++;
    return [{ id: `tab-${tabCounter}`, label: 'Terminal 1' }];
  });
  const [activeTabId, setActiveTabId] = useState(tabs[0].id);
  const [fontSize, setFontSize] = useState(14);
  const [themeName, setThemeName] = useState(() =>
    typeof window !== 'undefined' ? localStorage.getItem('gcclippy-theme') || 'Catppuccin' : 'Catppuccin'
  );
  const [tabStatuses, setTabStatuses] = useState<Record<string, string>>({});

  // Track which tabs need forceNew (all except the first one which uses find-or-create)
  const firstTabId = useRef(tabs[0].id);

  // Per-tab kill callbacks (store refs to session IDs)
  const killCallbacksRef = useRef<Record<string, (sessionId: string | null) => void>>({});
  const statusCallbacksRef = useRef<Record<string, (status: string) => void>>({});

  const addTab = useCallback(() => {
    tabCounter++;
    const newTab: TabMeta = { id: `tab-${tabCounter}`, label: `Terminal ${tabCounter}` };
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTab.id);
  }, []);

  const closeTab = useCallback((tabId: string) => {
    // Kill the session for this tab
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
        return [{ id: `tab-${tabCounter}`, label: `Terminal ${tabCounter}` }];
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

  // Keyboard shortcuts
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
            <Palette className="h-3 w-3 text-muted-foreground ml-1" />
            <select
              value={themeName}
              onChange={(e) => { setThemeName(e.target.value); localStorage.setItem('gcclippy-theme', e.target.value); }}
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
          {projectId && (
            <Button variant="ghost" size="sm" className="h-6 text-xs text-destructive hover:text-destructive" onClick={handleKillActive} disabled={activeStatus !== 'open'} title="Kill active session (Ctrl+Shift+K)">
              <Square className="h-3 w-3 mr-1" />
              Kill
            </Button>
          )}
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
              themeName={themeName}
              active={tab.id === activeTabId}
              forceNew={tab.id !== firstTabId.current}
              onStatusChange={statusCallbacksRef.current[tab.id]}
              onKill={killCallbacksRef.current[tab.id]}
            />
          );
        })}
      </div>
    </div>
  );
}
