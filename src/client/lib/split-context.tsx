import React, { createContext, useContext, useState, ReactNode } from 'react';

export type SplitContent =
  | { type: 'project'; projectId: string }
  | { type: 'automation'; path: string }
  | null;

interface SplitContextType {
  splitMode: boolean;
  splitContent: SplitContent;
  activePane: 'left' | 'right';
  toggleSplit: () => void;
  setSplitContent: (content: SplitContent) => void;
  setActivePane: (pane: 'left' | 'right') => void;
}

const SplitContext = createContext<SplitContextType | undefined>(undefined);

export function SplitProvider({ children }: { children: ReactNode }) {
  const [splitMode, setSplitMode] = useState(false);
  const [splitContent, setSplitContent] = useState<SplitContent>(null);
  const [activePane, setActivePane] = useState<'left' | 'right'>('left');

  const toggleSplit = () => {
    setSplitMode((prev) => {
      const next = !prev;
      if (!next) {
        setSplitContent(null);
        setActivePane('left');
      }
      return next;
    });
  };

  React.useEffect(() => {
    if (splitMode && splitContent === null) {
      setActivePane('right');
    }
  }, [splitMode, splitContent]);

  return (
    <SplitContext.Provider value={{ splitMode, splitContent, activePane, toggleSplit, setSplitContent, setActivePane }}>
      {children}
    </SplitContext.Provider>
  );
}

export function useSplit(): SplitContextType {
  const context = useContext(SplitContext);
  if (!context) throw new Error('useSplit must be used within a SplitProvider');
  return context;
}
