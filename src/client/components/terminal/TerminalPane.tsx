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
  /** Whether this terminal is currently visible on screen.
   *  When false, focus/auto-focus and resize notifications are suppressed. */
  visible?: boolean;
  onReady?: (api: TerminalPaneAPI) => void;
}

export interface TerminalPaneAPI {
  write: (data: string) => void;
  /** Coalesces multiple writes into a single xterm render per animation frame */
  writeBatched: (data: string) => void;
  fit: () => void;
  focus: () => void;
  /** Force a full canvas redraw (fixes corruption after re-mount/visibility change) */
  refresh: () => void;
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

export default function TerminalPane({ onInput, onResize, fontSize = 14, fontFamily, themeName, visible = true, onReady }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const onInputRef = useRef(onInput);
  const onResizeRef = useRef(onResize);
  const lastSentDimsRef = useRef({ cols: 0, rows: 0 });
  const visibleRef = useRef(visible);
  onInputRef.current = onInput;
  onResizeRef.current = onResize;
  visibleRef.current = visible;

  /** Only notify when dimensions actually changed to avoid flooding the PTY
   *  with redundant WINDOW_BUFFER_SIZE events that can crash TUI programs. */
  const resizeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notifyResizeIfChanged = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    const { cols, rows } = term;
    const last = lastSentDimsRef.current;
    if (cols !== last.cols || rows !== last.rows) {
      last.cols = cols;
      last.rows = rows;
      // Debounce resize events during rapid font size changes to avoid
      // the shell redrawing its prompt on every intermediate step
      if (resizeDebounceRef.current) clearTimeout(resizeDebounceRef.current);
      resizeDebounceRef.current = setTimeout(() => {
        resizeDebounceRef.current = null;
        // Re-check dims in case they changed during debounce
        const t = termRef.current;
        if (!t) return;
        onResizeRef.current?.(t.cols, t.rows);
        lastSentDimsRef.current = { cols: t.cols, rows: t.rows };
      }, 300);
    }
  }, []);

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

    // Track last-sent dimensions so we never send redundant resize events.
    // Redundant resizes flood the PTY child process with WINDOW_BUFFER_SIZE
    // events, which can trigger bugs in interactive TUI programs like gh copilot.

    term.onData((data) => onInputRef.current(data));

    termRef.current = term;
    fitRef.current = fit;

    const api: TerminalPaneAPI = {
      write: (data: string) => {
        term.write(data);
      },
      /** Batch multiple write calls into a single xterm render frame.
       *  Prevents rapid WS messages from each triggering a separate
       *  canvas repaint, which is the main source of typing lag during
       *  heavy output. */
      writeBatched: (() => {
        let buf: string[] = [];
        let raf = 0;
        return (data: string) => {
          buf.push(data);
          if (!raf) {
            raf = requestAnimationFrame(() => {
              const chunk = buf.join('');
              buf = [];
              raf = 0;
              term.write(chunk);
            });
          }
        };
      })(),
      fit: () => {
        fit.fit();
        notifyResizeIfChanged();
      },
      focus: () => term.focus(),
      refresh: () => term.refresh(0, term.rows - 1),
    };

    // Defer initial fit to ensure the container has been laid out.
    // xterm renders to a canvas, so opening into a zero-sized container
    // leaves it in a broken state where keyboard input doesn't work.
    // onReady must fire AFTER fit so callers flushing buffered output
    // write into a properly-sized terminal (avoids cursor corruption).
    requestAnimationFrame(() => {
      fit.fit();
      term.focus();
      notifyResizeIfChanged();
      onReady?.(api);
    });

    // Safety refit after a short delay in case the initial rAF ran
    // before CSS transitions or panel animations finished.
    const safetyRefit = setTimeout(() => {
      fit.fit();
      term.focus();
      notifyResizeIfChanged();
    }, 150);

    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (!visibleRef.current) return; // skip resize while hidden
      if (resizeTimeout) clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        fit.fit();
        notifyResizeIfChanged();
      }, 100);
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      if (resizeTimeout) clearTimeout(resizeTimeout);
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
    // Defer fit to next frame so xterm finishes re-measuring glyphs
    requestAnimationFrame(() => {
      if (!termRef.current || !fitRef.current) return;
      fitRef.current.fit();
      termRef.current.refresh(0, termRef.current.rows - 1);
      notifyResizeIfChanged();
    });
  }, [fontSize, notifyResizeIfChanged]);

  // Apply font family changes
  useEffect(() => {
    if (!termRef.current || !fitRef.current) return;
    termRef.current.options.fontFamily = fontFamily || TERMINAL_FONTS[0].family;
    requestAnimationFrame(() => {
      if (!termRef.current || !fitRef.current) return;
      fitRef.current.fit();
      termRef.current.refresh(0, termRef.current.rows - 1);
      notifyResizeIfChanged();
    });
  }, [fontFamily, notifyResizeIfChanged]);

  const handleClick = useCallback(() => {
    if (termRef.current) {
      termRef.current.focus();
    }
  }, []);

  // Refit and focus when this terminal becomes visible (e.g. project switch)
  useEffect(() => {
    if (visible && termRef.current && fitRef.current) {
      // Defer to next frame so container has its final layout after CSS changes
      const fit = fitRef.current;
      const term = termRef.current;
      const raf = requestAnimationFrame(() => {
        fit.fit();
        term.refresh(0, term.rows - 1);
        term.focus();
        notifyResizeIfChanged();
      });
      return () => cancelAnimationFrame(raf);
    }
  }, [visible, notifyResizeIfChanged]);

  // Refresh terminal when the browser tab or window regains visibility.
  // xterm's canvas rendering can get corrupted when the compositor skips
  // paint cycles (minimised window, background tab, sleep/wake, etc.).
  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;

    const refresh = () => {
      if (!visibleRef.current) return;
      fit.fit();
      term.refresh(0, term.rows - 1);
      notifyResizeIfChanged();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        // Small delay to let the browser finish compositing
        setTimeout(refresh, 100);
      }
    };

    const onWindowFocus = () => {
      setTimeout(refresh, 100);
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', onWindowFocus);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', onWindowFocus);
    };
  }, [notifyResizeIfChanged]);

  // Auto-focus the terminal when user types and focus isn't in a form element.
  // This recovers from focus loss after clicking tab bar, dropdowns, etc.
  // Only registered while the terminal is visible to avoid N hidden listeners.
  useEffect(() => {
    if (!visible) return; // don't register for hidden terminals

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
  }, [visible]);

  const theme = getThemeByName(themeName ?? 'Catppuccin');

  return <div ref={containerRef} className="h-full w-full" style={{ backgroundColor: theme.theme.background }} onClick={handleClick} />;
}
