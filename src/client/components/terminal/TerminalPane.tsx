'use client';

import { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { getThemeByName } from '@/lib/terminal-themes';

interface Props {
  onInput: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  fontSize?: number;
  fontFamily?: string;
  themeName?: string;
  onReady?: (api: TerminalPaneAPI) => void;
}

export interface TerminalPaneAPI {
  write: (data: string) => void;
  fit: () => void;
  focus: () => void;
}

export const TERMINAL_FONTS = [
  { id: 'default', label: 'Default', family: 'Menlo, Monaco, "Courier New", monospace' },
  { id: 'jetbrains', label: 'JetBrains Mono', family: '"JetBrains Mono", monospace' },
  { id: 'fira', label: 'Fira Code', family: '"Fira Code", monospace' },
  { id: 'cascadia', label: 'Cascadia Code', family: '"Cascadia Code", "Cascadia Mono", monospace' },
  { id: 'consolas', label: 'Consolas', family: 'Consolas, monospace' },
  { id: 'source', label: 'Source Code Pro', family: '"Source Code Pro", monospace' },
  { id: 'ubuntu', label: 'Ubuntu Mono', family: '"Ubuntu Mono", monospace' },
  { id: 'courier', label: 'Courier New', family: '"Courier New", monospace' },
] as const;

export type TerminalFontId = (typeof TERMINAL_FONTS)[number]['id'];

export default function TerminalPane({ onInput, onResize, fontSize = 14, fontFamily, themeName, onReady }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const onInputRef = useRef(onInput);
  const onResizeRef = useRef(onResize);
  onInputRef.current = onInput;
  onResizeRef.current = onResize;

  useEffect(() => {
    if (!containerRef.current || termRef.current) return;

    const term = new Terminal({
      fontFamily: fontFamily || TERMINAL_FONTS[0].family,
      fontSize,
      theme: getThemeByName(themeName ?? 'Catppuccin').theme,
      cursorBlink: true,
    });

    // Prevent browser from intercepting Tab/Shift+Tab for focus navigation
    // and manually send the correct escape sequences
    term.attachCustomKeyEventHandler((e) => {
      // Let Ctrl+Shift shortcuts pass through to app-level handlers
      if (e.ctrlKey && e.shiftKey && e.type === 'keydown') {
        return false;
      }
      if (e.key === 'Tab' && e.shiftKey && e.type === 'keydown') {
        // Shift+Tab = backtab, send CSI Z
        onInputRef.current('\x1b[Z');
        e.preventDefault();
        return false;
      }
      if (e.key === 'Tab' && !e.shiftKey && e.type === 'keydown') {
        e.preventDefault();
        return true;
      }
      return true;
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);

    // Defer initial fit to ensure the container has been laid out.
    // xterm renders to a canvas, so opening into a zero-sized container
    // leaves it in a broken state where keyboard input doesn't work.
    requestAnimationFrame(() => {
      fit.fit();
      term.focus();
      onResizeRef.current?.(term.cols, term.rows);
    });

    term.onData((data) => onInputRef.current(data));

    termRef.current = term;
    fitRef.current = fit;

    const api: TerminalPaneAPI = {
      write: (data: string) => {
        term.write(data);
        // After output settles, re-sync dimensions in case they drifted
        scheduleResync();
      },
      fit: () => {
        fit.fit();
        onResizeRef.current?.(term.cols, term.rows);
      },
      focus: () => term.focus(),
    };
    onReady?.(api);

    // Safety refit after a short delay in case the initial rAF ran
    // before CSS transitions or panel animations finished.
    const safetyRefit = setTimeout(() => {
      fit.fit();
      term.focus();
      onResizeRef.current?.(term.cols, term.rows);
    }, 150);

    // Re-sync dimensions after output bursts settle (debounced 500ms)
    let resyncTimeout: ReturnType<typeof setTimeout> | null = null;
    function scheduleResync() {
      if (resyncTimeout) clearTimeout(resyncTimeout);
      resyncTimeout = setTimeout(() => {
        fit.fit();
        onResizeRef.current?.(term.cols, term.rows);
      }, 500);
    }

    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimeout) clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        fit.fit();
        onResizeRef.current?.(term.cols, term.rows);
      }, 50);
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      if (resizeTimeout) clearTimeout(resizeTimeout);
      if (resyncTimeout) clearTimeout(resyncTimeout);
      clearTimeout(safetyRefit);
      resizeObserver.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apply theme changes
  useEffect(() => {
    if (!termRef.current) return;
    termRef.current.options.theme = getThemeByName(themeName ?? 'Catppuccin').theme;
  }, [themeName]);

  // Apply font size changes
  useEffect(() => {
    if (!termRef.current || !fitRef.current) return;
    termRef.current.options.fontSize = fontSize;
    fitRef.current.fit();
    onResizeRef.current?.(termRef.current.cols, termRef.current.rows);
  }, [fontSize]);

  // Apply font family changes
  useEffect(() => {
    if (!termRef.current || !fitRef.current) return;
    termRef.current.options.fontFamily = fontFamily || TERMINAL_FONTS[0].family;
    fitRef.current.fit();
    onResizeRef.current?.(termRef.current.cols, termRef.current.rows);
  }, [fontFamily]);

  const handleClick = useCallback(() => {
    if (termRef.current && fitRef.current) {
      termRef.current.focus();
      fitRef.current.fit();
      onResizeRef.current?.(termRef.current.cols, termRef.current.rows);
    }
  }, []);

  // Auto-focus the terminal when user types and focus isn't in a form element.
  // This recovers from focus loss after clicking tab bar, dropdowns, etc.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      // Ignore modifier-only keys and browser shortcuts
      if (e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt' || e.key === 'Meta') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const term = termRef.current;
      if (!term) return;
      const termEl = containerRef.current?.querySelector('.xterm-helper-textarea') as HTMLElement | null;
      if (termEl && document.activeElement !== termEl) {
        term.focus();
      }
    }
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, []);

  const theme = getThemeByName(themeName ?? 'Catppuccin');

  return <div ref={containerRef} className="h-full w-full" style={{ backgroundColor: theme.theme.background }} onClick={handleClick} />;
}
