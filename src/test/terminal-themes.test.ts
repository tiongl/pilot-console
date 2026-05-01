import { describe, it, expect } from 'vitest';
import { THEMES, getThemeByName } from '../shared/terminal-themes';

describe('terminal-themes', () => {
  it('exports a non-empty array of themes', () => {
    expect(THEMES.length).toBeGreaterThan(0);
  });

  it('every theme has a name and required color fields', () => {
    for (const t of THEMES) {
      expect(t.name).toBeTruthy();
      expect(t.theme.background).toBeTruthy();
      expect(t.theme.foreground).toBeTruthy();
      expect(t.theme.cursor).toBeTruthy();
    }
  });

  it('getThemeByName returns the correct theme', () => {
    const cat = getThemeByName('Catppuccin');
    expect(cat.name).toBe('Catppuccin');
    expect(cat.theme.background).toBe('#1e1e2e');
  });

  it('getThemeByName falls back to first theme for unknown name', () => {
    const fallback = getThemeByName('NonExistentTheme');
    expect(fallback.name).toBe(THEMES[0].name);
  });

  it('all theme names are unique', () => {
    const names = THEMES.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
