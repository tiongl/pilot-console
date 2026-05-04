import { createContext, useCallback, useContext, useEffect, useState } from 'react';

export const THEMES = [
  { id: 'light', label: 'Light', dark: false },
  { id: 'dark', label: 'Dark', dark: true },
  { id: 'system', label: 'System', dark: false },
  { id: 'midnight', label: 'Midnight', dark: true },
  { id: 'nord', label: 'Nord', dark: true },
  { id: 'solarized-light', label: 'Solarized Light', dark: false },
  { id: 'solarized-dark', label: 'Solarized Dark', dark: true },
  { id: 'catppuccin', label: 'Catppuccin Mocha', dark: true },
  { id: 'github-dark', label: 'GitHub Dark', dark: true },
] as const;

export type ThemeId = (typeof THEMES)[number]['id'];

interface ThemeContextValue {
  theme: ThemeId;
  setTheme: (theme: ThemeId) => void;
  resolvedDark: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const STORAGE_KEY = 'pilot-console-ui-theme';

function getSystemDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<ThemeId>(() =>
    (localStorage.getItem(STORAGE_KEY) as ThemeId) || 'system'
  );
  const [systemDark, setSystemDark] = useState(getSystemDark);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const themeDef = THEMES.find(t => t.id === theme) ?? THEMES[0];
  const resolvedDark = theme === 'system' ? systemDark : themeDef.dark;

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', resolvedDark);
    // Remove all theme data attrs, then set the active one
    root.removeAttribute('data-theme');
    root.removeAttribute('data-accent');
    if (theme !== 'light' && theme !== 'dark' && theme !== 'system') {
      root.setAttribute('data-theme', theme);
    }
  }, [theme, resolvedDark]);

  const setTheme = useCallback((t: ThemeId) => {
    setThemeState(t);
    localStorage.setItem(STORAGE_KEY, t);
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, resolvedDark }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
