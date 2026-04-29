'use client';

import { useCallback, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { Wrench, Settings, ListTodo, History, Keyboard, GitBranch, Bookmark } from 'lucide-react';
import { Button } from '@/components/ui/button';
import SessionHistory from './SessionHistory';
import GitPanel from './GitPanel';
import SnippetPanel from './SnippetPanel';
import { useKeyboardShortcuts, ShortcutsHelpOverlay } from './KeyboardShortcuts';

interface Props {
  projectId: string;
  projectName: string;
  repoPath: string;
  children: React.ReactNode;
  todoPanel: React.ReactNode;
  onSnippetInsert?: (text: string) => void;
}

export default function ProjectHeader({ projectId, projectName, repoPath, children, todoPanel, onSnippetInsert }: Props) {
  const { pathname } = useLocation();
  const basePath = `/projects/${projectId}`;
  const isChat = pathname === `${basePath}/chat` || pathname === basePath;
  const [activePanel, setActivePanel] = useState<'none' | 'notes' | 'history' | 'git' | 'snippets'>('none');

  const toggleNotes = useCallback(() => setActivePanel(p => p === 'notes' ? 'none' : 'notes'), []);
  const toggleGit = useCallback(() => setActivePanel(p => p === 'git' ? 'none' : 'git'), []);
  const { showHelp, setShowHelp } = useKeyboardShortcuts({
    onToggleNotes: toggleNotes,
    onToggleGit: toggleGit,
  });

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-2">
        <div className="min-w-0">
          <Link to={`${basePath}/chat`} className="hover:underline">
            <h2 className="text-sm font-semibold truncate">{projectName}</h2>
          </Link>
          <p className="text-xs text-muted-foreground font-mono truncate">{repoPath}</p>
        </div>
        <div className="flex items-center gap-1 shrink-0 ml-4">
          {isChat && (
            <>
              <Button
                variant={activePanel === 'notes' ? 'secondary' : 'ghost'}
                size="icon"
                className="h-8 w-8"
                onClick={() => setActivePanel(p => p === 'notes' ? 'none' : 'notes')}
                title="Project TODO"
              >
                <ListTodo className="h-4 w-4" />
              </Button>
              <Button
                variant={activePanel === 'history' ? 'secondary' : 'ghost'}
                size="icon"
                className="h-8 w-8"
                onClick={() => setActivePanel(p => p === 'history' ? 'none' : 'history')}
                title="Session History"
              >
                <History className="h-4 w-4" />
              </Button>
              <Button
                variant={activePanel === 'git' ? 'secondary' : 'ghost'}
                size="icon"
                className="h-8 w-8"
                onClick={() => setActivePanel(p => p === 'git' ? 'none' : 'git')}
                title="Git Status (Ctrl+Shift+G)"
              >
                <GitBranch className="h-4 w-4" />
              </Button>
              <Button
                variant={activePanel === 'snippets' ? 'secondary' : 'ghost'}
                size="icon"
                className="h-8 w-8"
                onClick={() => setActivePanel(p => p === 'snippets' ? 'none' : 'snippets')}
                title="Snippets"
              >
                <Bookmark className="h-4 w-4" />
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setShowHelp(s => !s)}
            title="Keyboard Shortcuts (Ctrl+Shift+/)"
          >
            <Keyboard className="h-4 w-4" />
          </Button>
          <Link to={`${basePath}/skills`}>
            <Button variant={pathname.includes('/skills') ? 'secondary' : 'ghost'} size="icon" className="h-8 w-8" title="Skills & MCP">
              <Wrench className="h-4 w-4" />
            </Button>
          </Link>
          <Link to={`${basePath}/settings`}>
            <Button variant={pathname.includes('/settings') ? 'secondary' : 'ghost'} size="icon" className="h-8 w-8" title="Settings">
              <Settings className="h-4 w-4" />
            </Button>
          </Link>
        </div>
      </div>

      {/* Content area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex-1 flex overflow-hidden">
          <div className="flex-1 overflow-hidden">{children}</div>
          {isChat && activePanel !== 'none' && activePanel !== 'git' && (
            <div className="w-80 border-l overflow-hidden flex flex-col shrink-0">
              {activePanel === 'notes' && todoPanel}
              {activePanel === 'history' && <SessionHistory projectId={projectId} />}
              {activePanel === 'snippets' && <SnippetPanel projectId={projectId} onInsert={onSnippetInsert} />}
            </div>
          )}
        </div>
        {isChat && activePanel === 'git' && (
          <div className="h-[40%] min-h-[200px] border-t overflow-hidden flex flex-col shrink-0">
            <GitPanel projectId={projectId} />
          </div>
        )}
      </div>
      {showHelp && <ShortcutsHelpOverlay onClose={() => setShowHelp(false)} />}
    </div>
  );
}
