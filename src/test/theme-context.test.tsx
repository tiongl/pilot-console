import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider, useTheme, THEMES } from '@/src/client/lib/theme-context';

// Helper component to expose theme context values
function ThemeDisplay() {
  const { theme, setTheme, resolvedDark } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <span data-testid="dark">{String(resolvedDark)}</span>
      {THEMES.map(t => (
        <button key={t.id} data-testid={`set-${t.id}`} onClick={() => setTheme(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

describe('ThemeProvider', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
    document.documentElement.removeAttribute('data-theme');
  });

  it('defaults to system theme', () => {
    render(
      <ThemeProvider>
        <ThemeDisplay />
      </ThemeProvider>
    );
    expect(screen.getByTestId('theme').textContent).toBe('system');
  });

  it('persists theme to localStorage', async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <ThemeDisplay />
      </ThemeProvider>
    );

    await user.click(screen.getByTestId('set-dark'));
    expect(localStorage.getItem('clippy-ui-theme')).toBe('dark');
    expect(screen.getByTestId('theme').textContent).toBe('dark');
  });

  it('applies dark class for dark themes', async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <ThemeDisplay />
      </ThemeProvider>
    );

    await user.click(screen.getByTestId('set-dark'));
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(screen.getByTestId('dark').textContent).toBe('true');
  });

  it('removes dark class for light theme', async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <ThemeDisplay />
      </ThemeProvider>
    );

    await user.click(screen.getByTestId('set-dark'));
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    await user.click(screen.getByTestId('set-light'));
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(screen.getByTestId('dark').textContent).toBe('false');
  });

  it('sets data-theme attribute for named themes', async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <ThemeDisplay />
      </ThemeProvider>
    );

    await user.click(screen.getByTestId('set-nord'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('nord');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('does not set data-theme for light/dark/system', async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <ThemeDisplay />
      </ThemeProvider>
    );

    await user.click(screen.getByTestId('set-light'));
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
  });

  it('reads initial theme from localStorage', () => {
    localStorage.setItem('clippy-ui-theme', 'catppuccin');
    render(
      <ThemeProvider>
        <ThemeDisplay />
      </ThemeProvider>
    );
    expect(screen.getByTestId('theme').textContent).toBe('catppuccin');
  });

  it('throws when useTheme is used outside ThemeProvider', () => {
    // Suppress React error boundary console output
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<ThemeDisplay />)).toThrow('useTheme must be used within ThemeProvider');
    spy.mockRestore();
  });
});

describe('THEMES constant', () => {
  it('has unique ids', () => {
    const ids = THEMES.map(t => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('includes light, dark, and system', () => {
    const ids = THEMES.map(t => t.id);
    expect(ids).toContain('light');
    expect(ids).toContain('dark');
    expect(ids).toContain('system');
  });

  it('marks dark themes correctly', () => {
    const light = THEMES.find(t => t.id === 'light')!;
    const dark = THEMES.find(t => t.id === 'dark')!;
    expect(light.dark).toBe(false);
    expect(dark.dark).toBe(true);
  });
});
