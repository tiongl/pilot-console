import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useAutomationBadge } from '../hooks/useAutomationBadge';

interface AutomationNavSchedule {
  id: string;
  name: string;
}

interface AutomationContextValue {
  badgeCount: number;
  schedules: AutomationNavSchedule[];
  refreshBadge: () => Promise<void>;
  refreshSchedules: () => Promise<void>;
  markSeen: (latestCompletedAt?: string) => void;
  incrementBadge: () => void;
}

const AutomationContext = createContext<AutomationContextValue>({
  badgeCount: 0,
  schedules: [],
  refreshBadge: async () => {},
  refreshSchedules: async () => {},
  markSeen: () => {},
  incrementBadge: () => {},
});

export function AutomationProvider({ children }: { children: React.ReactNode }) {
  const { count, refresh, markSeen, increment } = useAutomationBadge();
  const [schedules, setSchedules] = useState<AutomationNavSchedule[]>([]);

  const refreshSchedules = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/schedules');
      if (!res.ok) return;
      const data = await res.json();
      setSchedules((data.schedules || []).map((s: AutomationNavSchedule) => ({ id: s.id, name: s.name })));
    } catch {}
  }, []);

  useEffect(() => {
    refreshSchedules();
  }, [refreshSchedules]);

  return (
    <AutomationContext.Provider
      value={{
        badgeCount: count,
        schedules,
        refreshBadge: refresh,
        refreshSchedules,
        markSeen,
        incrementBadge: increment,
      }}
    >
      {children}
    </AutomationContext.Provider>
  );
}

export function useAutomation() {
  return useContext(AutomationContext);
}
