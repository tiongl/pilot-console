import React, { useEffect, useRef, useState } from 'react';
import { Bot, Terminal } from 'lucide-react';

export type TabMode = 'cli' | 'shell' | 'powershell';

interface NewTabMenuProps {
  onSelect: (mode: TabMode) => void;
}

export default function NewTabMenu({ onSelect }: NewTabMenuProps) {
  const [open, setOpen] = useState(false);
  const posRef = useRef<{ top: number; left: number }>({ top: 0, left: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={containerRef} className="shrink-0 relative">
      <button
        onClick={(e) => {
          if (open) {
            setOpen(false);
          } else {
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            posRef.current = { top: rect.bottom + 2, left: rect.left };
            setOpen(true);
          }
        }}
        className="px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-background/50"
        title="New tab"
        data-testid="new-tab-button"
      >
        +
      </button>
      {open && (
        <div
          className="fixed z-[9999] rounded-md border bg-popover shadow-md py-1 min-w-[140px]"
          style={{ top: posRef.current.top, left: posRef.current.left }}
          data-testid="new-tab-menu"
        >
          <button onClick={() => { onSelect('cli'); setOpen(false); }} className="w-full text-left px-3 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground flex items-center gap-2" data-testid="menu-cli">
            <Bot className="h-3 w-3" /> Copilot CLI
          </button>
          <button onClick={() => { onSelect('shell'); setOpen(false); }} className="w-full text-left px-3 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground flex items-center gap-2" data-testid="menu-shell">
            <Terminal className="h-3 w-3" /> Terminal
          </button>
          <button onClick={() => { onSelect('powershell'); setOpen(false); }} className="w-full text-left px-3 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground flex items-center gap-2" data-testid="menu-powershell">
            <span className="text-[10px] font-bold w-3 text-center">PS</span> PowerShell
          </button>
        </div>
      )}
    </div>
  );
}
