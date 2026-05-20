import { createContext, useContext, useState, useCallback, ReactNode, useEffect } from 'react';

export interface SplitLayout {
  rows: number;
  cols: number;
}

/** Valid layouts: one dimension is 1, or 2×2. */
export function isValidSplitLayout(rows: number, cols: number): boolean {
  if (rows < 1 || cols < 1 || rows > 4 || cols > 4) return false;
  return rows === 1 || cols === 1 || (rows === 2 && cols === 2);
}

export function splitGroupCount(layout: SplitLayout): number {
  return layout.rows * layout.cols;
}

interface ProjectSplitContextType {
  layout: SplitLayout;
  isSplit: boolean;
  groupCount: number;
  setLayout: (layout: SplitLayout) => void;
}

const ProjectSplitContext = createContext<ProjectSplitContextType | undefined>(undefined);

function lsSplitKey(stateKey: string) {
  return `pilot-console-split-layout:${stateKey}`;
}

function loadLayout(stateKey: string): SplitLayout | null {
  try {
    const raw = localStorage.getItem(lsSplitKey(stateKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed.rows === 'number' && typeof parsed.cols === 'number' && isValidSplitLayout(parsed.rows, parsed.cols)) {
      return { rows: parsed.rows, cols: parsed.cols };
    }
    return null;
  } catch {
    return null;
  }
}

function saveLayout(stateKey: string, layout: SplitLayout) {
  try {
    localStorage.setItem(lsSplitKey(stateKey), JSON.stringify(layout));
  } catch { /* quota exceeded */ }
}

export function ProjectSplitProvider({ stateKey, children }: { stateKey: string; children: ReactNode }) {
  const [layout, setLayoutState] = useState<SplitLayout>(() => {
    if (stateKey) {
      const saved = loadLayout(stateKey);
      if (saved) return saved;
    }
    return { rows: 1, cols: 1 };
  });

  const setLayout = useCallback((newLayout: SplitLayout) => {
    if (!isValidSplitLayout(newLayout.rows, newLayout.cols)) return;
    setLayoutState(newLayout);
  }, []);

  // Persist layout changes
  useEffect(() => {
    if (stateKey) saveLayout(stateKey, layout);
  }, [stateKey, layout]);

  const groupCount = splitGroupCount(layout);
  const isSplit = groupCount > 1;

  return (
    <ProjectSplitContext.Provider value={{ layout, isSplit, groupCount, setLayout }}>
      {children}
    </ProjectSplitContext.Provider>
  );
}

export function useProjectSplit(): ProjectSplitContextType {
  const ctx = useContext(ProjectSplitContext);
  if (!ctx) throw new Error('useProjectSplit must be used within ProjectSplitProvider');
  return ctx;
}
