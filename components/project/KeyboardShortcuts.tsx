'use client';

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';

interface ShortcutActions {
  onToggleNotes?: () => void;
  onToggleGit?: () => void;
  onToggleHelp?: () => void;
}

const SHORTCUTS = [
  { keys: 'Ctrl+Shift+K', description: 'Kill session' },
  { keys: 'Ctrl+Shift+T', description: 'New terminal tab' },
  { keys: 'Ctrl+Shift+N', description: 'Toggle notes panel' },
  { keys: 'Ctrl+Shift+G', description: 'Toggle git panel' },
  { keys: 'Ctrl + / Ctrl -', description: 'Font size up / down' },
  { keys: 'Ctrl+Shift+/', description: 'Show this help' },
];

export function useKeyboardShortcuts(actions: ShortcutActions) {
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (e.ctrlKey && e.shiftKey) {
        switch (e.key) {
          case 'N': e.preventDefault(); actions.onToggleNotes?.(); break;
          case 'G': e.preventDefault(); actions.onToggleGit?.(); break;
          case '?':
          case '/': e.preventDefault(); setShowHelp(s => !s); break;
        }
      }
    }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [actions]);

  return { showHelp, setShowHelp };
}

export function ShortcutsHelpOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="bg-background border rounded-lg shadow-lg p-6 max-w-sm w-full mx-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold">Keyboard Shortcuts</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-2">
          {SHORTCUTS.map(s => (
            <div key={s.keys} className="flex justify-between text-sm">
              <span className="text-muted-foreground">{s.description}</span>
              <kbd className="px-2 py-0.5 bg-muted rounded text-xs font-mono">{s.keys}</kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
