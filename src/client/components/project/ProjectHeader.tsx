'use client';

import { useCallback, useState, useEffect } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { Wrench, ListTodo, History, Keyboard, Bookmark, Columns2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import SessionHistory from './SessionHistory';
import SnippetPanel from './SnippetPanel';
import { useKeyboardShortcuts, ShortcutsHelpOverlay } from './KeyboardShortcuts';
import { useProjectSplit, isValidSplitLayout } from '../../lib/project-split-context';

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
  const isChat = pathname.endsWith('/chat') || pathname === basePath;
  const [activePanel, setActivePanel] = useState<'none' | 'notes' | 'history' | 'snippets'>('none');
  const { layout, isSplit, setLayout } = useProjectSplit();
  const [showGridPicker, setShowGridPicker] = useState(false);
  const [gridHover, setGridHover] = useState<{ rows: number; cols: number } | null>(null);
  const gridPickerRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (!node.contains(e.target as Node)) setShowGridPicker(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const toggleNotes = useCallback(() => setActivePanel(p => p === 'notes' ? 'none' : 'notes'), []);
  const { showHelp, setShowHelp } = useKeyboardShortcuts({
    onToggleNotes: toggleNotes,
  });

  const [showSettings, setShowSettings] = useState(false);
  const [settingsName, setSettingsName] = useState('');
  const [settingsRepoPath, setSettingsRepoPath] = useState('');
  const [settingsDesc, setSettingsDesc] = useState('');
  const [settingsError, setSettingsError] = useState('');
  const [settingsSaving, setSettingsSaving] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    if (showSettings) {
      setSettingsName(projectName);
      setSettingsRepoPath(repoPath);
      setSettingsDesc('');
      setSettingsError('');
      fetch(`/api/projects/${projectId}`).then(r => r.json()).then(p => {
        setSettingsDesc(p.description ?? '');
      }).catch(() => {});
    }
  }, [showSettings, projectId, projectName, repoPath]);

  const handleSettingsSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSettingsError('');
    setSettingsSaving(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: settingsName, repoPath: settingsRepoPath, description: settingsDesc || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setShowSettings(false);
      window.location.reload();
    } catch (err) {
      setSettingsError((err as Error).message);
    } finally {
      setSettingsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm('Delete this project from Pilot Console? Your git repository will not be affected.')) return;
    await fetch(`/api/projects/${projectId}`, { method: 'DELETE' });
    navigate('/');
  };

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
          <div className="relative">
            <Button
              variant={isSplit ? 'secondary' : 'ghost'}
              size="icon"
              className="h-8 w-8"
              onClick={() => setShowGridPicker(v => !v)}
              title="Split layout"
            >
              <Columns2 className="h-4 w-4" />
            </Button>
            {showGridPicker && (
              <div
                ref={gridPickerRef}
                className="absolute top-full right-0 mt-1 z-50 bg-popover border rounded-md shadow-md p-2"
              >
                <div className="text-[10px] text-muted-foreground mb-1.5 text-center">
                  {gridHover ? `${gridHover.rows}×${gridHover.cols}` : `${layout.rows}×${layout.cols}`}
                </div>
                <div className="grid grid-cols-4 gap-1">
                  {Array.from({ length: 16 }, (_, idx) => {
                    const rows = Math.floor(idx / 4) + 1;
                    const cols = (idx % 4) + 1;
                    const valid = isValidSplitLayout(rows, cols);
                    const isSelected = layout.rows === rows && layout.cols === cols;
                    const isHovered = gridHover && rows <= gridHover.rows && cols <= gridHover.cols;
                    const hoverValid = gridHover ? isValidSplitLayout(gridHover.rows, gridHover.cols) : false;
                    return (
                      <button
                        key={idx}
                        className={`w-5 h-5 rounded-sm border text-[0px] transition-colors ${
                          isSelected
                            ? 'bg-primary border-primary'
                            : !valid
                              ? 'bg-muted/30 border-muted cursor-not-allowed opacity-30'
                              : isHovered && hoverValid
                                ? 'bg-primary/40 border-primary/60'
                                : 'bg-muted/50 border-border hover:border-primary/40'
                        }`}
                        disabled={!valid}
                        onMouseEnter={() => valid && setGridHover({ rows, cols })}
                        onMouseLeave={() => setGridHover(null)}
                        onClick={() => {
                          if (valid) {
                            setLayout({ rows, cols });
                            setShowGridPicker(false);
                            setGridHover(null);
                          }
                        }}
                      />
                    );
                  })}
                </div>
              </div>
            )}
          </div>
          <Button
            variant={showSettings ? 'secondary' : 'ghost'}
            size="icon"
            className="h-8 w-8"
            onClick={() => setShowSettings(v => !v)}
            title="Project Settings"
          >
            <Wrench className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Content area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex-1 flex overflow-hidden">
          <div className="flex-1 overflow-hidden">{children}</div>
          {isChat && activePanel !== 'none' && (
            <div className="w-80 border-l overflow-hidden flex flex-col shrink-0">
              {activePanel === 'notes' && todoPanel}
              {activePanel === 'history' && <SessionHistory projectId={projectId} />}
              {activePanel === 'snippets' && <SnippetPanel projectId={projectId} onInsert={onSnippetInsert} />}
            </div>
          )}
        </div>
      </div>
      {showHelp && <ShortcutsHelpOverlay onClose={() => setShowHelp(false)} />}

      <Dialog open={showSettings} onOpenChange={setShowSettings}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Project Settings</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSettingsSave} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="settings-name">Name</Label>
              <Input id="settings-name" value={settingsName} onChange={e => setSettingsName(e.target.value)} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="settings-repo">Repository Path</Label>
              <Input id="settings-repo" value={settingsRepoPath} onChange={e => setSettingsRepoPath(e.target.value)} className="font-mono text-sm" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="settings-desc">Description</Label>
              <Textarea id="settings-desc" value={settingsDesc} onChange={e => setSettingsDesc(e.target.value)} rows={2} />
            </div>
            {settingsError && <p className="text-sm text-destructive">{settingsError}</p>}
            <div className="flex items-center justify-between">
              <Button type="submit" disabled={settingsSaving}>
                {settingsSaving ? 'Saving…' : 'Save'}
              </Button>
              <Button type="button" variant="destructive" size="sm" onClick={handleDelete}>
                Delete Project
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
