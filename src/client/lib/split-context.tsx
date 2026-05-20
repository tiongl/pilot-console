import React, { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react';
import { isValidSplitLayout, type SplitLayout } from './project-split-context';

export type SplitDirection = 'vertical' | 'horizontal';

export type SplitContent =
  | { type: 'project'; projectId: string }
  | { type: 'worktree'; projectId: string; worktreeId: string }
  | { type: 'automation'; path: string }
  | null;

interface SplitContextType {
  paneCount: number;
  panes: SplitContent[];
  activePaneIndex: number;
  layout: SplitLayout;
  setPaneCount: (n: number) => void;
  setPaneContent: (index: number, content: SplitContent) => void;
  setActivePaneIndex: (index: number) => void;
  setLayout: (layout: SplitLayout) => void;
}

const SplitContext = createContext<SplitContextType | undefined>(undefined);

const SPLIT_LS_KEY = 'pilot-console-split';
const SPLIT_VERSION = 2;

interface PersistedSplit {
  version: number;
  panes: SplitContent[];
  activePaneIndex: number;
  layout: SplitLayout;
}

function loadSplitState(): PersistedSplit | null {
  try {
    const raw = localStorage.getItem(SPLIT_LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Migrate v1 → v2
    if (parsed?.version === 1) {
      const pc = Math.max(1, Math.min(4, parsed.paneCount ?? 1));
      const dir: SplitDirection = parsed.splitDirection === 'horizontal' ? 'horizontal' : 'vertical';
      const rows = dir === 'horizontal' ? pc : 1;
      const cols = dir === 'vertical' ? pc : 1;
      const layout: SplitLayout = isValidSplitLayout(rows, cols) ? { rows, cols } : { rows: 1, cols: pc > 4 ? 4 : pc };
      const panes = Array.isArray(parsed.panes) ? parsed.panes.slice(0, pc - 1) : [];
      while (panes.length < pc - 1) panes.push(null);
      return { version: SPLIT_VERSION, panes, activePaneIndex: Math.max(0, Math.min(pc - 1, parsed.activePaneIndex ?? 0)), layout };
    }
    if (parsed?.version !== SPLIT_VERSION) return null;
    const layout = parsed.layout && isValidSplitLayout(parsed.layout.rows, parsed.layout.cols)
      ? parsed.layout
      : { rows: 1, cols: 1 };
    const pc = layout.rows * layout.cols;
    const panes = Array.isArray(parsed.panes) ? parsed.panes.slice(0, pc - 1) : [];
    while (panes.length < pc - 1) panes.push(null);
    const api = Math.max(0, Math.min(pc - 1, parsed.activePaneIndex ?? 0));
    return { version: SPLIT_VERSION, panes, activePaneIndex: api, layout };
  } catch {
    return null;
  }
}

function saveSplitState(layout: SplitLayout, panes: SplitContent[], activePaneIndex: number) {
  try {
    const data: PersistedSplit = { version: SPLIT_VERSION, layout, panes, activePaneIndex };
    localStorage.setItem(SPLIT_LS_KEY, JSON.stringify(data));
  } catch { /* ignore */ }
}

export function SplitProvider({ children }: { children: ReactNode }) {
  const [layout, setLayoutRaw] = useState<SplitLayout>(() => {
    return loadSplitState()?.layout ?? { rows: 1, cols: 1 };
  });
  const [panes, setPanes] = useState<SplitContent[]>(() => {
    return loadSplitState()?.panes ?? [];
  });
  const [activePaneIndex, setActivePaneIndex] = useState(() => {
    return loadSplitState()?.activePaneIndex ?? 0;
  });

  const paneCount = layout.rows * layout.cols;

  // Persist whenever split state changes
  useEffect(() => {
    saveSplitState(layout, panes, activePaneIndex);
  }, [layout, panes, activePaneIndex]);

  const setLayout = useCallback((newLayout: SplitLayout) => {
    if (!isValidSplitLayout(newLayout.rows, newLayout.cols)) return;
    setLayoutRaw(newLayout);
    const newCount = newLayout.rows * newLayout.cols;
    setPanes(prev => {
      const extraCount = newCount - 1;
      if (extraCount <= 0) return [];
      const next = prev.slice(0, extraCount);
      while (next.length < extraCount) next.push(null);
      return next;
    });
    setActivePaneIndex(prev => Math.min(prev, newCount - 1));
  }, []);

  const setPaneCount = useCallback((n: number) => {
    const clamped = Math.max(1, Math.min(4, n));
    // Map pane count to a 1×N layout by default
    setLayout({ rows: 1, cols: clamped });
  }, [setLayout]);

  const setPaneContent = useCallback((index: number, content: SplitContent) => {
    if (index < 1) return;
    setPanes(prev => {
      const next = [...prev];
      next[index - 1] = content;
      return next;
    });
  }, []);

  return (
    <SplitContext.Provider value={{ paneCount, panes, activePaneIndex, layout, setPaneCount, setPaneContent, setActivePaneIndex, setLayout }}>
      {children}
    </SplitContext.Provider>
  );
}

export function useSplit(): SplitContextType {
  const context = useContext(SplitContext);
  if (!context) throw new Error('useSplit must be used within a SplitProvider');
  return context;
}
