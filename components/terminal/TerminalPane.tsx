'use client';

import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { getThemeByName } from '@/lib/terminal-themes';

interface Props {
  output: string;
  onInput: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  fontSize?: number;
  themeName?: string;
  onFitRef?: (fit: () => void) => void;
}

export default function TerminalPane({ output, onInput, onResize, fontSize = 14, themeName, onFitRef }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const prevOutputLen = useRef(0);

  useEffect(() => {
    if (!containerRef.current || termRef.current) return;

    const term = new Terminal({
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 14,
      theme: getThemeByName(themeName ?? 'Catppuccin').theme,
      cursorBlink: true,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();

    term.onData((data) => onInput(data));

    termRef.current = term;
    fitRef.current = fit;

    // Expose fit function for parent (e.g., when tab becomes visible)
    onFitRef?.(() => {
      fit.fit();
      onResize?.(term.cols, term.rows);
    });

    const resizeObserver = new ResizeObserver(() => {
      fit.fit();
      onResize?.(term.cols, term.rows);
    });
    resizeObserver.observe(containerRef.current);

    // Send initial size
    onResize?.(term.cols, term.rows);

    return () => {
      resizeObserver.disconnect();
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apply theme changes
  useEffect(() => {
    if (!termRef.current) return;
    const t = getThemeByName(themeName ?? 'Catppuccin');
    termRef.current.options.theme = t.theme;
  }, [themeName]);

  // Apply font size changes
  useEffect(() => {
    if (!termRef.current || !fitRef.current) return;
    termRef.current.options.fontSize = fontSize;
    fitRef.current.fit();
  }, [fontSize]);

  // Write only new output chunks to xterm
  useEffect(() => {
    if (!termRef.current) return;
    const newPart = output.slice(prevOutputLen.current);
    if (newPart) {
      termRef.current.write(newPart);
      prevOutputLen.current = output.length;
    }
  }, [output]);

  return <div ref={containerRef} className="h-full w-full" />;
}
