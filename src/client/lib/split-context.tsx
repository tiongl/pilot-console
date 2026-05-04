import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react';

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

export function SplitProvider({ children }: { children: ReactNode }) {
  const [paneCount, setPaneCountRaw] = useState(1);
  const [panes, setPanes] = useState<SplitContent[]>([]);
  const [activePaneIndex, setActivePaneIndex] = useState(0);

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
