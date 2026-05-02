import React, { createContext, useContext, useState, ReactNode } from 'react';

interface SplitContextType {
  splitMode: boolean;
  splitProjectId: string | null;
  activePane: 'left' | 'right';
  toggleSplit: () => void;
  setSplitProjectId: (id: string | null) => void;
  setActivePane: (pane: 'left' | 'right') => void;
}

const SplitContext = createContext<SplitContextType | undefined>(undefined);

interface SplitProviderProps {
  children: ReactNode;
}

export function SplitProvider({ children }: SplitProviderProps) {
  const [splitMode, setSplitMode] = useState(false);
  const [splitProjectId, setSplitProjectId] = useState<string | null>(null);
  const [activePane, setActivePane] = useState<'left' | 'right'>('left');

  const toggleSplit = () => {
    setSplitMode((prev) => {
      const newSplitMode = !prev;
      if (!newSplitMode) {
        // When turning off split mode, reset related state
        setSplitProjectId(null);
        setActivePane('left');
      }
      return newSplitMode;
    });
  };

  const handleSetSplitProjectId = (id: string | null) => {
    setSplitProjectId(id);
  };

  const handleSetActivePane = (pane: 'left' | 'right') => {
    setActivePane(pane);
  };

  // When splitMode is turned on and splitProjectId is null, set activePane to 'right'
  React.useEffect(() => {
    if (splitMode && splitProjectId === null) {
      setActivePane('right');
    }
  }, [splitMode, splitProjectId]);

  const value: SplitContextType = {
    splitMode,
    splitProjectId,
    activePane,
    toggleSplit,
    setSplitProjectId: handleSetSplitProjectId,
    setActivePane: handleSetActivePane,
  };

  return (
    <SplitContext.Provider value={value}>
      {children}
    </SplitContext.Provider>
  );
}

export function useSplit(): SplitContextType {
  const context = useContext(SplitContext);
  if (context === undefined) {
    throw new Error('useSplit must be used within a SplitProvider');
  }
  return context;
}
