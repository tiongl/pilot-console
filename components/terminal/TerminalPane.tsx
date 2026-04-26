'use client';

import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

interface Props {
  output: string;
  onInput: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
}

export default function TerminalPane({ output, onInput, onResize }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const prevOutputLen = useRef(0);

  useEffect(() => {
    if (!containerRef.current || termRef.current) return;

    const term = new Terminal({
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 14,
      theme: {
        background: '#1e1e2e',
        foreground: '#cdd6f4',
        cursor: '#cdd6f4',
      },
      cursorBlink: true,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();

    term.onData((data) => onInput(data));

    termRef.current = term;
    fitRef.current = fit;

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
