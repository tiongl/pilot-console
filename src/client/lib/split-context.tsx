import React, { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react';

export type SplitContent =
  | { type: 'project'; projectId: string }
  | { type: 'worktree'; projectId: string; worktreeId: string }
  | { type: 'automation'; path: string }
  | null;

interface SplitContextType {
  paneCount: number;
  panes: SplitContent[];
  activePaneIndex: number;
  setPaneCount: (n: number) => void;
  setPaneContent: (index: number, content: SplitContent) => void;
  setActivePaneIndex: (index: number) => void;
}

const SplitContext = createContext<SplitContextType | undefined>(undefined);

const SPLIT_LS_KEY = 'pilot-console-split';
const SPLIT_VERSION = 1;

interface PersistedSplit {
  version: number;
  paneCount: number;
  panes: SplitContent[];
  activePaneIndex: number;
}

function loadSplitState(): PersistedSplit | null {
  try {
    const raw = localStorage.getItem(SPLIT_LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.version !== SPLIT_VERSION) return null;
    const pc = Math.max(1, Math.min(4, parsed.paneCount ?? 1));
    const panes = Array.isArray(parsed.panes) ? parsed.panes.slice(0, pc - 1) : [];
    while (panes.length < pc - 1) panes.push(null);
    const api = Math.max(0, Math.min(pc - 1, parsed.activePaneIndex ?? 0));
    return { version: SPLIT_VERSION, paneCount: pc, panes, activePaneIndex: api };
  } catch {
    return null;
  }
}

function saveSplitState(paneCount: number, panes: SplitContent[], activePaneIndex: number) {
  try {
    const data: PersistedSplit = { version: SPLIT_VERSION, paneCount, panes, activePaneIndex };
    localStorage.setItem(SPLIT_LS_KEY, JSON.stringify(data));
  } catch { /* ignore */ }
}

export function SplitProvider({ children }: { children: ReactNode }) {
  const [paneCount, setPaneCountRaw] = useState(() => {
    return loadSplitState()?.paneCount ?? 1;
  });
  const [panes, setPanes] = useState<SplitContent[]>(() => {
    return loadSplitState()?.panes ?? [];
  });
  const [activePaneIndex, setActivePaneIndex] = useState(() => {
    return loadSplitState()?.activePaneIndex ?? 0;
  });

  // Persist whenever split state changes
  useEffect(() => {
    saveSplitState(paneCount, panes, activePaneIndex);
  }, [paneCount, panes, activePaneIndex]);

  const setPaneCount = useCallback((n: number) => {
    const clamped = Math.max(1, Math.min(4, n));
    setPaneCountRaw(clamped);
    setPanes(prev => {
      const extraCount = clamped - 1;
      if (extraCount <= 0) return [];
      const next = prev.slice(0, extraCount);
      while (next.length < extraCount) next.push(null);
      return next;
    });
    setActivePaneIndex(prev => Math.min(prev, clamped - 1));
  }, []);

  const setPaneContent = useCallback((index: number, content: SplitContent) => {
    if (index < 1) return;
    setPanes(prev => {
      const next = [...prev];
      next[index - 1] = content;
      return next;
    });
  }, []);

  return (
    <SplitContext.Provider value={{ paneCount, panes, activePaneIndex, setPaneCount, setPaneContent, setActivePaneIndex }}>
      {children}
    </SplitContext.Provider>
  );
}

export function useSplit(): SplitContextType {
  const context = useContext(SplitContext);
  if (!context) throw new Error('useSplit must be used within a SplitProvider');
  return context;
}
