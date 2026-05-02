import { createContext, useContext } from 'react';
import { useAutomationBadge } from '../hooks/useAutomationBadge';

interface AutomationContextValue {
  badgeCount: number;
  refreshBadge: () => Promise<void>;
  markSeen: (latestCompletedAt?: string) => void;
  incrementBadge: () => void;
}

const AutomationContext = createContext<AutomationContextValue>({
  badgeCount: 0,
  refreshBadge: async () => {},
  markSeen: () => {},
  incrementBadge: () => {},
});

export function AutomationProvider({ children }: { children: React.ReactNode }) {
  const { count, refresh, markSeen, increment } = useAutomationBadge();
  return (
    <AutomationContext.Provider value={{ badgeCount: count, refreshBadge: refresh, markSeen, incrementBadge: increment }}>
      {children}
    </AutomationContext.Provider>
  );
}

export function useAutomation() {
  return useContext(AutomationContext);
}
