'use client';

import { useState, useEffect, useCallback, useMemo, useRef, useId, lazy, Suspense, type PointerEvent as ReactPointerEvent } from 'react';
import { Folder, File, ChevronRight, ChevronDown, ChevronLeft, X, Copy, Check, Image as ImageIcon, Eye, Code, Minus, Plus, WrapText, Hash, Search, Pencil, Save, Undo2, FilePlus, Maximize2, RefreshCw, FolderOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { toast } from 'sonner';
import { Light as SyntaxHighlighter } from 'react-syntax-highlighter';
import ts from 'react-syntax-highlighter/dist/esm/languages/hljs/typescript';
import js from 'react-syntax-highlighter/dist/esm/languages/hljs/javascript';
import python from 'react-syntax-highlighter/dist/esm/languages/hljs/python';
import go from 'react-syntax-highlighter/dist/esm/languages/hljs/go';
import rust from 'react-syntax-highlighter/dist/esm/languages/hljs/rust';
import java from 'react-syntax-highlighter/dist/esm/languages/hljs/java';
import json from 'react-syntax-highlighter/dist/esm/languages/hljs/json';
import yaml from 'react-syntax-highlighter/dist/esm/languages/hljs/yaml';
import css from 'react-syntax-highlighter/dist/esm/languages/hljs/css';
import scss from 'react-syntax-highlighter/dist/esm/languages/hljs/scss';
import xml from 'react-syntax-highlighter/dist/esm/languages/hljs/xml';
import bash from 'react-syntax-highlighter/dist/esm/languages/hljs/bash';
import powershell from 'react-syntax-highlighter/dist/esm/languages/hljs/powershell';
import sql from 'react-syntax-highlighter/dist/esm/languages/hljs/sql';
import markdown from 'react-syntax-highlighter/dist/esm/languages/hljs/markdown';
import ruby from 'react-syntax-highlighter/dist/esm/languages/hljs/ruby';
import csharp from 'react-syntax-highlighter/dist/esm/languages/hljs/csharp';
import cpp from 'react-syntax-highlighter/dist/esm/languages/hljs/cpp';
import dockerfile from 'react-syntax-highlighter/dist/esm/languages/hljs/dockerfile';
import ini from 'react-syntax-highlighter/dist/esm/languages/hljs/ini';
import { vs2015 } from 'react-syntax-highlighter/dist/esm/styles/hljs';
import { atomOneDark } from 'react-syntax-highlighter/dist/esm/styles/hljs';
import { atomOneLight } from 'react-syntax-highlighter/dist/esm/styles/hljs';
import { githubGist } from 'react-syntax-highlighter/dist/esm/styles/hljs';
import { monokai } from 'react-syntax-highlighter/dist/esm/styles/hljs';

const VIEWER_THEMES = {
  'VS Dark': { style: vs2015, bg: '#1e1e1e', text: 'text-gray-200' },
  'Atom Dark': { style: atomOneDark, bg: '#282c34', text: 'text-gray-200' },
  'Monokai': { style: monokai, bg: '#272822', text: 'text-gray-200' },
  'Atom Light': { style: atomOneLight, bg: '#fafafa', text: 'text-gray-800' },
  'GitHub': { style: githubGist, bg: '#ffffff', text: 'text-gray-800' },
} as const;
type ViewerThemeName = keyof typeof VIEWER_THEMES;

SyntaxHighlighter.registerLanguage('typescript', ts);
SyntaxHighlighter.registerLanguage('javascript', js);
SyntaxHighlighter.registerLanguage('python', python);
SyntaxHighlighter.registerLanguage('go', go);
SyntaxHighlighter.registerLanguage('rust', rust);
SyntaxHighlighter.registerLanguage('java', java);
SyntaxHighlighter.registerLanguage('json', json);
SyntaxHighlighter.registerLanguage('yaml', yaml);
SyntaxHighlighter.registerLanguage('css', css);
SyntaxHighlighter.registerLanguage('scss', scss);
SyntaxHighlighter.registerLanguage('xml', xml);
SyntaxHighlighter.registerLanguage('bash', bash);
SyntaxHighlighter.registerLanguage('powershell', powershell);
SyntaxHighlighter.registerLanguage('sql', sql);
SyntaxHighlighter.registerLanguage('markdown', markdown);
SyntaxHighlighter.registerLanguage('ruby', ruby);
SyntaxHighlighter.registerLanguage('csharp', csharp);
SyntaxHighlighter.registerLanguage('cpp', cpp);
SyntaxHighlighter.registerLanguage('dockerfile', dockerfile);
SyntaxHighlighter.registerLanguage('ini', ini);

const MonacoFileEditor = lazy(() => import('./MonacoFileEditor'));

interface FileEntry {
  name: string;
  type: 'dir' | 'file';
  size?: number;
}

interface FileViewerState {
  path: string;
  content: string | null;
  binary?: boolean;
  truncated?: boolean;
  size?: number;
  loading: boolean;
}

interface FileViewerHistoryEntry {
  path: string;
  markdownScrollTop?: number;
}

interface FileViewerHistory {
  entries: FileViewerHistoryEntry[];
  index: number;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  mjs: 'javascript', cjs: 'javascript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  cs: 'csharp', c: 'cpp', cpp: 'cpp', h: 'cpp', hpp: 'cpp',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini',
  md: 'markdown', mdx: 'markdown',
  css: 'css', scss: 'scss', less: 'scss',
  html: 'xml', htm: 'xml', svg: 'xml', xml: 'xml',
  sh: 'bash', zsh: 'bash', bash: 'bash', ps1: 'powershell',
  sql: 'sql', dockerfile: 'dockerfile',
  ini: 'ini', cfg: 'ini', conf: 'ini', env: 'ini',
};

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg']);

function getExt(filename: string): string {
  const base = filename.split('/').pop() ?? filename;
  if (base.toLowerCase() === 'dockerfile') return 'dockerfile';
  return base.split('.').pop()?.toLowerCase() ?? '';
}

function getLanguage(filename: string): string {
  return EXT_LANG[getExt(filename)] || '';
}

function isImageFile(filename: string): boolean {
  return IMAGE_EXTS.has(getExt(filename));
}

const HTML_EXTS = new Set(['html', 'htm']);

function isHtmlFile(filename: string): boolean {
  return HTML_EXTS.has(getExt(filename));
}

function isExternalMarkdownHref(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//');
}

function resolveMarkdownFileHref(currentPath: string, href: string): string | null {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('/') || isExternalMarkdownHref(trimmed)) {
    return null;
  }

  const pathOnly = trimmed.split('#')[0].split('?')[0].replace(/\\/g, '/');
  if (!pathOnly) return null;

  const parts = currentPath.split('/').slice(0, -1);
  for (const part of pathOnly.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }

  return parts.join('/');
}

function buildFileApiUrl(projectId: string, endpoint: 'files' | 'files-search' | 'file' | 'file-raw' | 'file-reveal', params: Record<string, string | undefined>, worktreeId?: string): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, value);
  }
  if (worktreeId) search.set('worktreeId', worktreeId);
  return `/api/projects/${projectId}/${endpoint}?${search.toString()}`;
}

function resolveMarkdownImageSrc(projectId: string, currentPath: string, src: string | undefined, worktreeId?: string): string | undefined {
  if (!src || isExternalMarkdownHref(src) || src.startsWith('/')) return src;

  const filePath = resolveMarkdownFileHref(currentPath, src);
  return filePath ? buildFileApiUrl(projectId, 'file-raw', { path: filePath }, worktreeId) : src;
}

function FileIcon({ name }: { name: string }) {
  if (isImageFile(name)) return <ImageIcon className="h-4 w-4 shrink-0 text-purple-400" />;
  return <File className="h-4 w-4 shrink-0 text-muted-foreground" />;
}

function CodeViewer({ content, language, truncated, size, fontSize, showLineNumbers, wrapLines, themeName }: {
  content: string; language: string; truncated?: boolean; size?: number;
  fontSize: number; showLineNumbers: boolean; wrapLines: boolean; themeName: ViewerThemeName;
}) {
  const theme = VIEWER_THEMES[themeName];
  const customStyle: React.CSSProperties = {
    margin: 0,
    padding: '1rem',
    fontSize: `${fontSize}px`,
    lineHeight: '1.5',
    background: 'transparent',
  };

  return (
    <>
      {language ? (
        <SyntaxHighlighter
          language={language}
          style={theme.style}
          showLineNumbers={showLineNumbers}
          lineNumberStyle={{ color: '#555', fontSize: `${Math.max(fontSize - 2, 9)}px`, minWidth: '2.5em', paddingRight: '1em' }}
          customStyle={customStyle}
          wrapLongLines={wrapLines}
        >
          {content}
        </SyntaxHighlighter>
      ) : (
        <pre className="font-mono p-4 whitespace-pre-wrap break-words leading-relaxed" style={{ fontSize: `${fontSize}px` }}>
          {content}
        </pre>
      )}
      {truncated && (
        <div className="px-4 pb-3 text-xs text-muted-foreground italic">
          — File truncated ({formatSize(size ?? 0)}) —
        </div>
      )}
    </>
  );
}

function ImageViewer({ projectId, worktreeId, filePath }: { projectId: string; worktreeId?: string; filePath: string }) {
  const url = buildFileApiUrl(projectId, 'file-raw', { path: filePath }, worktreeId);
  return (
    <div className="flex-1 flex items-center justify-center p-4 bg-[#1e1e1e]">
      <img src={url} alt={filePath} className="max-w-full max-h-full object-contain" />
    </div>
  );
}

const MERMAID_MIN_SCALE = 0.2;
const MERMAID_MAX_SCALE = 8;

function MermaidDiagram({ chart, darkMode }: { chart: string; darkMode: boolean }) {
  const id = useId().replace(/:/g, '');
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const [isFullscreen, setIsFullscreen] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const fittedViewRef = useRef({ scale: 1, x: 0, y: 0 });
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function renderDiagram() {
      setSvg(null);
      setError(null);
      try {
        const { default: mermaid } = await import('mermaid');
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: darkMode ? 'dark' : 'default',
        });
        const result = await mermaid.render(`mermaid-${id}`, chart);
        if (!cancelled) setSvg(result.svg);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    }

    renderDiagram();
    return () => { cancelled = true; };
  }, [chart, darkMode, id]);

  // A re-render invalidates any pan/zoom the user had applied.
  useEffect(() => { setView({ scale: 1, x: 0, y: 0 }); }, [chart]);

  // Mermaid emits `width="100%"` plus an inline `max-width`, so the rendered
  // box depends on layout context. The viewBox is the diagram's true size.
  const naturalSize = useMemo(() => {
    if (!svg) return null;
    const match = svg.match(/viewBox="([-\d.eE+\s]+)"/);
    if (!match) return null;
    const parts = match[1].trim().split(/\s+/).map(Number);
    if (parts.length !== 4 || !(parts[2] > 0) || !(parts[3] > 0)) return null;
    return { width: parts[2], height: parts[3] };
  }, [svg]);

  /**
   * Scale the diagram — up or down — until it fills the frame, and centre it.
   */
  const fit = useCallback(() => {
    const frame = frameRef.current;
    const content = contentRef.current;
    if (!frame || !content) return;
    const current = viewRef.current.scale || 1;
    const rect = content.getBoundingClientRect();
    const naturalWidth = naturalSize?.width ?? rect.width / current;
    const naturalHeight = naturalSize?.height ?? rect.height / current;
    if (!naturalWidth || !naturalHeight || !frame.clientWidth || !frame.clientHeight) return;
    // Mermaid sizes an SVG to its own content, which is often far smaller than
    // the frame — so fitting must be free to enlarge, not just shrink.
    const padding = 24;
    const scale = Math.min(
      MERMAID_MAX_SCALE,
      Math.max(
        MERMAID_MIN_SCALE,
        Math.min(
          Math.max(1, frame.clientWidth - padding) / naturalWidth,
          Math.max(1, frame.clientHeight - padding) / naturalHeight,
        ),
      ),
    );
    const fitted = {
      scale,
      x: Math.max(0, (frame.clientWidth - naturalWidth * scale) / 2),
      y: Math.max(0, (frame.clientHeight - naturalHeight * scale) / 2),
    };
    fittedViewRef.current = fitted;
    setView(fitted);
  }, [naturalSize]);

  // Fit once the SVG lands, and again when the frame resizes (e.g. fullscreen).
  useEffect(() => {
    if (!svg) return;
    const raf = requestAnimationFrame(fit);
    return () => cancelAnimationFrame(raf);
  }, [svg, fit]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !svg || typeof ResizeObserver === 'undefined') return;
    let first = true;
    const observer = new ResizeObserver(() => {
      // Skip the initial synchronous callback; the effect above already fit.
      if (first) { first = false; return; }
      fit();
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, [svg, fit]);

  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === frameRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  /** Zoom about a fixed point so the content under the cursor stays put. */
  const zoomAt = useCallback((factor: number, clientX?: number, clientY?: number) => {
    const frame = frameRef.current;
    setView((prev) => {
      const scale = Math.min(MERMAID_MAX_SCALE, Math.max(MERMAID_MIN_SCALE, prev.scale * factor));
      if (scale === prev.scale) return prev;
      const rect = frame?.getBoundingClientRect();
      const anchorX = clientX !== undefined && rect ? clientX - rect.left : (rect?.width ?? 0) / 2;
      const anchorY = clientY !== undefined && rect ? clientY - rect.top : (rect?.height ?? 0) / 2;
      const ratio = scale / prev.scale;
      return {
        scale,
        x: anchorX - (anchorX - prev.x) * ratio,
        y: anchorY - (anchorY - prev.y) * ratio,
      };
    });
  }, []);

  // Wheel zoom must be a non-passive native listener: React's onWheel is
  // registered passively, so preventDefault() there is ignored and the page
  // scrolls anyway.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !svg) return;
    const onWheel = (e: WheelEvent) => {
      // Plain wheel keeps scrolling the document; only Ctrl/⌘ + wheel zooms.
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY);
    };
    frame.addEventListener('wheel', onWheel, { passive: false });
    return () => frame.removeEventListener('wheel', onWheel);
  }, [svg, zoomAt]);

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    dragRef.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, originX: viewRef.current.x, originY: viewRef.current.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    setView((prev) => ({
      ...prev,
      x: drag.originX + (e.clientX - drag.startX),
      y: drag.originY + (e.clientY - drag.startY),
    }));
  }, []);

  const endDrag = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== e.pointerId) return;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement === frameRef.current) void document.exitFullscreen();
    else void frameRef.current?.requestFullscreen();
  }, []);

  if (error) {
    return (
      <pre className="mb-3 overflow-x-auto rounded bg-[#2d2d2d] p-3 text-xs text-red-300">
        Mermaid render error: {error}
      </pre>
    );
  }

  if (!svg) {
    return <div className="mb-3 rounded border border-border p-4 text-sm text-muted-foreground">Rendering Mermaid diagram...</div>;
  }

  const fitted = fittedViewRef.current;
  const zoomed =
    Math.abs(view.scale - fitted.scale) > 0.001 ||
    Math.abs(view.x - fitted.x) > 0.5 ||
    Math.abs(view.y - fitted.y) > 0.5;

  return (
    <div
      ref={frameRef}
      data-testid="mermaid-diagram"
      className={`group relative mb-3 overflow-hidden rounded border border-border bg-background ${isFullscreen ? 'h-screen w-screen' : 'h-[60vh] min-h-[240px]'}`}
    >
      <div
        className="h-full w-full cursor-grab touch-none active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={fit}
      >
        <div
          ref={contentRef}
          className="inline-block origin-top-left [&_svg]:block [&_svg]:h-full [&_svg]:w-full [&_svg]:max-w-none"
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            width: naturalSize ? `${naturalSize.width}px` : undefined,
            height: naturalSize ? `${naturalSize.height}px` : undefined,
          }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>

      <div className="absolute right-2 top-2 flex items-center gap-1 rounded border border-border bg-background/90 p-0.5 opacity-0 shadow-sm transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <Button variant="ghost" size="icon" className="h-6 w-6" title="Zoom out" aria-label="Zoom out"
          onClick={() => zoomAt(1 / 1.25)}>
          <Minus className="h-3.5 w-3.5" />
        </Button>
        <span className="min-w-[4ch] text-center text-[10px] tabular-nums text-muted-foreground">
          {Math.round(view.scale * 100)}%
        </span>
        <Button variant="ghost" size="icon" className="h-6 w-6" title="Zoom in" aria-label="Zoom in"
          onClick={() => zoomAt(1.25)}>
          <Plus className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="h-6 w-6" title="Fit to view (or double-click)" aria-label="Fit diagram to view"
          onClick={fit} disabled={!zoomed}>
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="h-6 w-6" title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen diagram'} aria-label="Toggle diagram fullscreen"
          onClick={toggleFullscreen}>
          <Maximize2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="pointer-events-none absolute bottom-1.5 left-2 text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
        Drag to pan · Ctrl/⌘ + scroll to zoom · double-click to fit
      </div>
    </div>
  );
}

/**
 * Per-project (and per-worktree) explorer state that should survive the
 * component being unmounted — switching routes, reopening the project, or
 * reloading the page.
 */
const EXPLORER_STATE_VERSION = 1;

interface PersistedExplorerState {
  version: number;
  openPath?: string;
  expandedDirs?: string[];
}

function explorerStateKey(projectId: string, worktreeId?: string): string {
  return `pilot-console-file-explorer:${projectId}${worktreeId ? `:${worktreeId}` : ''}`;
}

function loadExplorerState(projectId: string, worktreeId?: string): PersistedExplorerState | null {
  try {
    const raw = localStorage.getItem(explorerStateKey(projectId, worktreeId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedExplorerState;
    if (parsed?.version !== EXPLORER_STATE_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveExplorerState(projectId: string, worktreeId: string | undefined, state: Omit<PersistedExplorerState, 'version'>): void {
  try {
    localStorage.setItem(
      explorerStateKey(projectId, worktreeId),
      JSON.stringify({ version: EXPLORER_STATE_VERSION, ...state }),
    );
  } catch { /* quota exceeded — ignore */ }
}

export default function FileExplorer({ projectId, worktreeId, onClose, embedded }: { projectId: string; worktreeId?: string; onClose?: () => void; embedded?: boolean }) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [dirContents, setDirContents] = useState<Map<string, FileEntry[]>>(new Map());
  const [viewer, setViewer] = useState<FileViewerState | null>(null);
  const [copied, setCopied] = useState(false);
  const [renderMarkdown, setRenderMarkdown] = useState(true);
  const [renderHtml, setRenderHtml] = useState(true);
  const [viewerFontSize, setViewerFontSize] = useState(() => parseInt(localStorage.getItem('pilot-console-viewer-fontsize') || '12'));
  const [viewerTheme, setViewerTheme] = useState<ViewerThemeName>(() => (localStorage.getItem('pilot-console-viewer-theme') as ViewerThemeName) || 'VS Dark');
  const [showLines, setShowLines] = useState(() => localStorage.getItem('pilot-console-viewer-lines') !== 'false');
  const [wrapLines, setWrapLines] = useState(() => localStorage.getItem('pilot-console-viewer-wrap') !== 'false');

  // Editing state
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [revealingFile, setRevealingFile] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [newFilePrompt, setNewFilePrompt] = useState(false);
  const [newFilePath, setNewFilePath] = useState('');
  const [viewerHistory, setViewerHistory] = useState<FileViewerHistory>({ entries: [], index: -1 });
  const [isMarkdownFullscreen, setIsMarkdownFullscreen] = useState(false);
  const viewerScrollRef = useRef<HTMLDivElement>(null);
  const markdownViewerRef = useRef<HTMLDivElement>(null);
  const pendingMarkdownScrollTopRef = useRef<number | null>(null);
  const isDirty = isEditing && editContent !== originalContent;

  const updateFontSize = useCallback((delta: number) => {
    setViewerFontSize(s => { const n = Math.max(10, Math.min(24, s + delta)); localStorage.setItem('pilot-console-viewer-fontsize', String(n)); return n; });
  }, []);
  const updateTheme = useCallback((t: ViewerThemeName) => { setViewerTheme(t); localStorage.setItem('pilot-console-viewer-theme', t); }, []);
  const toggleLines = useCallback(() => { setShowLines(v => { localStorage.setItem('pilot-console-viewer-lines', String(!v)); return !v; }); }, []);
  const toggleWrap = useCallback(() => { setWrapLines(v => { localStorage.setItem('pilot-console-viewer-wrap', String(!v)); return !v; }); }, []);

  const activeThemeBg = VIEWER_THEMES[viewerTheme].bg;
  const activeThemeText = VIEWER_THEMES[viewerTheme].text;
  const viewerLanguage = useMemo(() => viewer ? getLanguage(viewer.path) : '', [viewer?.path]);
  const viewerIsImage = useMemo(() => viewer ? isImageFile(viewer.path) : false, [viewer?.path]);
  const viewerIsMarkdown = useMemo(() => viewerLanguage === 'markdown', [viewerLanguage]);
  const viewerIsHtml = useMemo(() => viewer ? isHtmlFile(viewer.path) : false, [viewer?.path]);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<{ path: string; type: 'file' | 'dir'; size?: number }[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doSearch = useCallback(async (q: string) => {
    if (!q.trim()) { setSearchResults(null); setSearchTruncated(false); return; }
    setSearchLoading(true);
    try {
      const res = await fetch(buildFileApiUrl(projectId, 'files-search', { q }, worktreeId));
      if (res.ok) {
        const data = await res.json();
        setSearchResults(data.results);
        setSearchTruncated(data.truncated ?? false);
      }
    } catch { /* ignore */ }
    setSearchLoading(false);
  }, [projectId, worktreeId]);

  const onSearchChange = useCallback((val: string) => {
    setSearchQuery(val);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => doSearch(val), 300);
  }, [doSearch]);

  const clearSearch = useCallback(() => {
    setSearchQuery('');
    setSearchResults(null);
    setSearchTruncated(false);
  }, []);

  const fetchDir = useCallback(async (dirPath: string) => {
    const res = await fetch(buildFileApiUrl(projectId, 'files', { path: dirPath }, worktreeId));
    if (res.ok) {
      const data = await res.json();
      return data.items as FileEntry[];
    }
    return [];
  }, [projectId, worktreeId]);

  useEffect(() => {
    setLoading(true);
    fetchDir('').then(items => {
      setEntries(items);
      setLoading(false);
    });
  }, [fetchDir]);

  const toggleDir = useCallback(async (dirPath: string) => {
    const newExpanded = new Set(expandedDirs);
    if (newExpanded.has(dirPath)) {
      newExpanded.delete(dirPath);
    } else {
      newExpanded.add(dirPath);
      if (!dirContents.has(dirPath)) {
        const items = await fetchDir(dirPath);
        setDirContents(prev => new Map(prev).set(dirPath, items));
      }
    }
    setExpandedDirs(newExpanded);
  }, [expandedDirs, dirContents, fetchDir]);

  const [refreshing, setRefreshing] = useState(false);
  const refreshTree = useCallback(async () => {
    setRefreshing(true);
    try {
      const rootItems = await fetchDir('');
      setEntries(rootItems);
      const expanded = Array.from(expandedDirs);
      const results = await Promise.all(expanded.map(async p => [p, await fetchDir(p)] as const));
      setDirContents(prev => {
        const next = new Map(prev);
        for (const [p, items] of results) next.set(p, items);
        return next;
      });
    } finally {
      setRefreshing(false);
    }
  }, [fetchDir, expandedDirs]);

  const isDirtyRef = useRef(false);
  isDirtyRef.current = isEditing && editContent !== originalContent;

  const getMarkdownScrollTop = useCallback(() => {
    const markdownEl = markdownViewerRef.current;
    if (document.fullscreenElement === markdownEl) {
      return markdownEl?.scrollTop ?? 0;
    }
    return viewerScrollRef.current?.scrollTop ?? markdownEl?.scrollTop ?? 0;
  }, []);

  const rememberCurrentMarkdownScroll = useCallback(() => {
    if (!viewerIsMarkdown || !viewer) return;
    const scrollTop = getMarkdownScrollTop();
    setViewerHistory(prev => {
      const current = prev.entries[prev.index];
      if (!current || current.path !== viewer.path) return prev;
      const entries = [...prev.entries];
      entries[prev.index] = { ...current, markdownScrollTop: scrollTop };
      return { ...prev, entries };
    });
  }, [getMarkdownScrollTop, viewer, viewerIsMarkdown]);

  const restoreMarkdownScrollAfterRender = useCallback((scrollTop?: number) => {
    pendingMarkdownScrollTopRef.current = scrollTop ?? 0;
  }, []);

  const openFile = useCallback(async (filePath: string, options: { recordHistory?: boolean; markdownScrollTop?: number } = {}) => {
    // Unsaved guard
    if (isDirtyRef.current) {
      if (!confirm('You have unsaved changes. Discard and open another file?')) return false;
    }
    if (options.recordHistory !== false) {
      setViewerHistory(prev => {
        if (prev.entries[prev.index]?.path === filePath) return prev;
        const entries = prev.entries.slice(0, prev.index + 1);
        entries.push({ path: filePath, markdownScrollTop: options.markdownScrollTop ?? 0 });
        return { entries, index: entries.length - 1 };
      });
    }
    restoreMarkdownScrollAfterRender(options.markdownScrollTop);
    setIsEditing(false);
    setEditContent('');
    setSaveError('');
    // For images, don't fetch content — show inline via raw endpoint
    if (isImageFile(filePath)) {
      setViewer({ path: filePath, content: null, binary: false, loading: false });
      return true;
    }
    setViewer({ path: filePath, content: null, loading: true });
    try {
      const res = await fetch(buildFileApiUrl(projectId, 'file', { path: filePath }, worktreeId));
      if (res.ok) {
        const data = await res.json();
        setViewer({
          path: filePath,
          content: data.content ?? null,
          binary: data.binary,
          truncated: data.truncated,
          size: data.size,
          loading: false,
        });
      } else {
        setViewer({ path: filePath, content: 'Error loading file', loading: false });
      }
    } catch {
      setViewer({ path: filePath, content: 'Error loading file', loading: false });
    }
    return true;
  }, [projectId, restoreMarkdownScrollAfterRender, worktreeId]);

  // Restore the previously open file and expanded folders. The tab itself keeps
  // this component mounted, but changing route/project/worktree — or reloading
  // — does not, so the state has to come back from storage.
  const restoredKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const key = explorerStateKey(projectId, worktreeId);
    if (restoredKeyRef.current === key) return;
    restoredKeyRef.current = key;

    const saved = loadExplorerState(projectId, worktreeId);
    if (!saved) return;

    let cancelled = false;
    (async () => {
      const dirs = saved.expandedDirs ?? [];
      if (dirs.length > 0) {
        const loaded = await Promise.all(dirs.map(async (p) => [p, await fetchDir(p)] as const));
        if (cancelled) return;
        setDirContents((prev) => {
          const next = new Map(prev);
          for (const [p, items] of loaded) next.set(p, items);
          return next;
        });
        setExpandedDirs(new Set(dirs));
      }
      if (saved.openPath && !cancelled) await openFile(saved.openPath);
    })();

    return () => { cancelled = true; };
  }, [fetchDir, openFile, projectId, worktreeId]);

  useEffect(() => {
    // Wait for the restore pass so an empty initial state cannot overwrite it.
    if (restoredKeyRef.current !== explorerStateKey(projectId, worktreeId)) return;
    saveExplorerState(projectId, worktreeId, {
      openPath: viewer?.path,
      expandedDirs: Array.from(expandedDirs),
    });
  }, [expandedDirs, projectId, viewer?.path, worktreeId]);

  const canGoBack = viewerHistory.index > 0;  const canGoForward = viewerHistory.index >= 0 && viewerHistory.index < viewerHistory.entries.length - 1;

  const navigateViewerHistory = useCallback(async (delta: -1 | 1) => {
    rememberCurrentMarkdownScroll();
    const targetIndex = viewerHistory.index + delta;
    const targetEntry = viewerHistory.entries[targetIndex];
    if (!targetEntry) return;

    const opened = await openFile(targetEntry.path, { recordHistory: false, markdownScrollTop: targetEntry.markdownScrollTop });
    if (opened) {
      setViewerHistory(prev => (
        prev.entries[targetIndex]?.path === targetEntry.path ? { ...prev, index: targetIndex } : prev
      ));
    }
  }, [openFile, rememberCurrentMarkdownScroll, viewerHistory.entries, viewerHistory.index]);

  const copyContent = useCallback(() => {
    if (viewer?.content) {
      navigator.clipboard.writeText(viewer.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }, [viewer]);

  const revealFileInSystem = useCallback(async () => {
    if (!viewer || revealingFile) return;
    setRevealingFile(true);
    try {
      const res = await fetch(buildFileApiUrl(projectId, 'file-reveal', { path: viewer.path }, worktreeId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: viewer.path }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || 'Failed to open file location');
      }
      toast.success('Opened file location');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setRevealingFile(false);
    }
  }, [projectId, revealingFile, viewer, worktreeId]);

  const canEdit = viewer && viewer.content !== null && !viewer.binary && !viewer.truncated && !isImageFile(viewer.path);

  const startEditing = useCallback(() => {
    if (!viewer?.content) return;
    setEditContent(viewer.content);
    setOriginalContent(viewer.content);
    setSaveError('');
    setIsEditing(true);
  }, [viewer]);

  const cancelEditing = useCallback(() => {
    if (isEditing && editContent !== originalContent) {
      if (!confirm('Discard unsaved changes?')) return;
    }
    setIsEditing(false);
    setEditContent('');
    setSaveError('');
  }, [isEditing, editContent, originalContent]);

  const saveFile = useCallback(async () => {
    if (!viewer) return;
    setSaving(true);
    setSaveError('');
    try {
      const res = await fetch(buildFileApiUrl(projectId, 'file', {}, worktreeId), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: viewer.path, content: editContent }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Save failed');
      }
      // Update viewer with new content
      setViewer(prev => prev ? { ...prev, content: editContent, size: new Blob([editContent]).size } : prev);
      setOriginalContent(editContent);
      setIsEditing(false);
    } catch (err) {
      setSaveError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [viewer, editContent, projectId, worktreeId]);

  const createNewFile = useCallback(async () => {
    const filePath = newFilePath.trim();
    if (!filePath) return;
    setSaving(true);
    setSaveError('');
    try {
      const res = await fetch(buildFileApiUrl(projectId, 'file', {}, worktreeId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath, content: '' }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Create failed');
      }
      setNewFilePrompt(false);
      setNewFilePath('');
      // Open the new file in editor mode
      setViewer({ path: filePath, content: '', loading: false, size: 0 });
      setEditContent('');
      setOriginalContent('');
      setIsEditing(true);
      // Refresh the file tree
      const items = await fetchDir('');
      setEntries(items);
    } catch (err) {
      setSaveError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [newFilePath, projectId, worktreeId, fetchDir]);

  const openMarkdownFullscreen = useCallback(() => {
    markdownViewerRef.current?.requestFullscreen();
  }, []);

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsMarkdownFullscreen(document.fullscreenElement === markdownViewerRef.current);
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  useEffect(() => {
    if (!viewer || viewer.loading || !viewerIsMarkdown || !renderMarkdown) return;
    const scrollTop = pendingMarkdownScrollTopRef.current;
    if (scrollTop === null) return;
    pendingMarkdownScrollTopRef.current = null;

    const frame = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        viewerScrollRef.current?.scrollTo({ top: scrollTop });
        markdownViewerRef.current?.scrollTo({ top: scrollTop });
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [renderMarkdown, viewer, viewerIsMarkdown]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.altKey) return;
      if (e.key === 'ArrowLeft' && canGoBack) {
        e.preventDefault();
        navigateViewerHistory(-1);
      } else if (e.key === 'ArrowRight' && canGoForward) {
        e.preventDefault();
        navigateViewerHistory(1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [canGoBack, canGoForward, navigateViewerHistory]);

  // Close on Escape (modal mode only)
  useEffect(() => {
    if (embedded || !onClose) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, embedded]);

  const renderTree = (items: FileEntry[], parentPath: string, depth: number) => {
    return items.map(item => {
      const itemPath = parentPath ? `${parentPath}/${item.name}` : item.name;
      const isExpanded = expandedDirs.has(itemPath);
      const isDir = item.type === 'dir';
      const children = dirContents.get(itemPath);

      return (
        <div key={itemPath}>
          <button
            className={`flex items-center gap-1.5 w-full text-left px-2 py-1 text-sm hover:bg-accent rounded-sm ${
              viewer?.path === itemPath ? 'bg-accent' : ''
            }`}
            style={{ paddingLeft: `${depth * 16 + 8}px` }}
            onClick={() => isDir ? toggleDir(itemPath) : openFile(itemPath)}
          >
            {isDir ? (
              <>
                {isExpanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                <Folder className="h-4 w-4 shrink-0 text-blue-400" />
              </>
            ) : (
              <>
                <span className="w-3.5 shrink-0" />
                <FileIcon name={item.name} />
              </>
            )}
            <span className="truncate">{item.name}</span>
            {!isDir && item.size !== undefined && (
              <span className="ml-auto text-xs text-muted-foreground shrink-0">{formatSize(item.size)}</span>
            )}
          </button>
          {isDir && isExpanded && children && renderTree(children, itemPath, depth + 1)}
        </div>
      );
    });
  };

  const innerContent = (
    <div className={embedded ? "flex h-full overflow-hidden" : "bg-background border rounded-lg shadow-xl flex w-[90vw] max-w-5xl h-[80vh] overflow-hidden"} onClick={e => e.stopPropagation()}>
      {/* File tree */}
      <div className="w-72 border-r flex flex-col shrink-0">
          <div className="flex items-center justify-between px-3 py-2 border-b">
            <span className="text-sm font-semibold">Files</span>
            <div className="flex items-center gap-0.5">
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={refreshTree} disabled={refreshing} title="Refresh">
                <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              </Button>
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => { setNewFilePrompt(true); setNewFilePath(''); setSaveError(''); }} title="New file">
                <FilePlus className="h-3.5 w-3.5" />
              </Button>
              {!embedded && onClose && (
                <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClose}>
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
        {newFilePrompt && (
          <div className="px-2 py-1.5 border-b bg-accent/30">
            <div className="text-xs text-muted-foreground mb-1">New file path:</div>
            <div className="flex items-center gap-1">
              <input
                type="text"
                value={newFilePath}
                onChange={e => setNewFilePath(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') createNewFile(); if (e.key === 'Escape') setNewFilePrompt(false); }}
                placeholder="e.g. src/utils/helper.ts"
                className="flex-1 text-xs bg-transparent border rounded px-2 py-1 outline-none text-foreground placeholder:text-muted-foreground"
                autoFocus
              />
              <Button variant="default" size="sm" className="h-6 text-xs" onClick={createNewFile} disabled={!newFilePath.trim() || saving}>
                {saving ? '…' : 'Create'}
              </Button>
              <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => setNewFilePrompt(false)}>
                ✕
              </Button>
            </div>
            {saveError && <div className="text-xs text-red-500 mt-1">{saveError}</div>}
          </div>
        )}
        <div className="px-2 py-1.5 border-b">
          <div className="flex items-center gap-1 border rounded px-2 py-1">
            <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => onSearchChange(e.target.value)}
              placeholder="Search files… (* wildcard)"
              className="flex-1 text-xs bg-transparent outline-none text-foreground placeholder:text-muted-foreground"
            />
            {searchQuery && (
              <button onClick={clearSearch} className="shrink-0">
                <X className="h-3 w-3 text-muted-foreground hover:text-foreground" />
              </button>
            )}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {searchResults !== null ? (
            // Search results mode
            searchLoading ? (
              <div className="text-sm text-muted-foreground px-3 py-2">Searching…</div>
            ) : searchResults.length === 0 ? (
              <div className="text-sm text-muted-foreground px-3 py-2">No matches</div>
            ) : (
              <>
                {searchResults.map(r => (
                  <button
                    key={r.path}
                    className={`flex items-center gap-1.5 w-full text-left px-2 py-1 text-xs hover:bg-accent rounded-sm ${
                      viewer?.path === r.path ? 'bg-accent' : ''
                    }`}
                    onClick={() => r.type === 'file' ? openFile(r.path) : toggleDir(r.path)}
                  >
                    {r.type === 'dir' ? (
                      <Folder className="h-4 w-4 shrink-0 text-blue-400" />
                    ) : (
                      <FileIcon name={r.path.split('/').pop() ?? r.path} />
                    )}
                    <span className="truncate font-mono">{r.path}</span>
                    {r.size !== undefined && (
                      <span className="ml-auto text-xs text-muted-foreground shrink-0">{formatSize(r.size)}</span>
                    )}
                  </button>
                ))}
                {searchTruncated && (
                  <div className="text-xs text-muted-foreground italic px-3 py-1">— 200+ results, refine search —</div>
                )}
              </>
            )
          ) : loading ? (
            <div className="text-sm text-muted-foreground px-3 py-2">Loading…</div>
          ) : entries.length === 0 ? (
            <div className="text-sm text-muted-foreground px-3 py-2">No files</div>
          ) : (
            renderTree(entries, '', 0)
          )}
        </div>
      </div>

        {/* File viewer */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {viewer ? (
            <>
              <div className="flex items-center justify-between px-4 py-1.5 border-b gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  {viewerIsImage ? <ImageIcon className="h-4 w-4 shrink-0 text-purple-400" /> : <File className="h-4 w-4 shrink-0 text-muted-foreground" />}
                  <span className="text-sm font-mono truncate">{viewer.path}</span>
                  {viewer.size !== undefined && (
                    <span className="text-xs text-muted-foreground shrink-0">({formatSize(viewer.size)})</span>
                  )}
                  {viewerLanguage && (
                    <span className="text-xs bg-accent px-1.5 py-0.5 rounded shrink-0">{viewerLanguage}</span>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => navigateViewerHistory(-1)}
                    disabled={!canGoBack}
                    title="Back (Alt+Left)"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => navigateViewerHistory(1)}
                    disabled={!canGoForward}
                    title="Forward (Alt+Right)"
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                  {/* Theme selector */}
                  {viewer.content && !viewerIsImage && (
                    <select
                      value={viewerTheme}
                      onChange={e => updateTheme(e.target.value as ViewerThemeName)}
                      className="h-6 text-xs bg-transparent border rounded px-1 outline-none text-foreground"
                      title="Theme"
                    >
                      {Object.keys(VIEWER_THEMES).map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  )}
                  {/* Font size */}
                  {viewer.content && !viewerIsImage && (
                    <div className="flex items-center gap-0.5 border rounded px-0.5">
                      <Button variant="ghost" size="icon" className="h-5 w-5" onClick={() => updateFontSize(-1)} disabled={viewerFontSize <= 10}>
                        <Minus className="h-3 w-3" />
                      </Button>
                      <span className="text-xs w-5 text-center tabular-nums">{viewerFontSize}</span>
                      <Button variant="ghost" size="icon" className="h-5 w-5" onClick={() => updateFontSize(1)} disabled={viewerFontSize >= 24}>
                        <Plus className="h-3 w-3" />
                      </Button>
                    </div>
                  )}
                  {/* Line numbers toggle */}
                  {viewer.content && !viewerIsImage && !(viewerIsMarkdown && renderMarkdown) && !(viewerIsHtml && renderHtml) && (
                    <Button variant={showLines ? 'secondary' : 'ghost'} size="icon" className="h-7 w-7" onClick={toggleLines} title="Line numbers">
                      <Hash className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  {/* Wrap toggle */}
                  {viewer.content && !viewerIsImage && !(viewerIsMarkdown && renderMarkdown) && !(viewerIsHtml && renderHtml) && (
                    <Button variant={wrapLines ? 'secondary' : 'ghost'} size="icon" className="h-7 w-7" onClick={toggleWrap} title="Word wrap">
                      <WrapText className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  {/* Markdown toggle */}
                  {viewerIsMarkdown && viewer.content && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => setRenderMarkdown(v => !v)}
                      title={renderMarkdown ? 'Show source' : 'Render markdown'}
                    >
                      {renderMarkdown ? <Code className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                  )}
                  {/* HTML toggle */}
                  {viewerIsHtml && viewer.content && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => setRenderHtml(v => !v)}
                      title={renderHtml ? 'Show source' : 'Render HTML'}
                    >
                      {renderHtml ? <Code className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                  )}
                  {viewerIsMarkdown && viewer.content && renderMarkdown && !isEditing && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={openMarkdownFullscreen}
                      title="Fullscreen markdown preview"
                    >
                      <Maximize2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  {/* Copy */}
                  {viewer.content && !isEditing && (
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={copyContent} title="Copy file content">
                      {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
                    </Button>
                  )}
                  {viewer && !viewer.loading && !isEditing && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={revealFileInSystem}
                      disabled={revealingFile}
                      title="Show file in file system"
                    >
                      <FolderOpen className="h-4 w-4" />
                    </Button>
                  )}
                  {/* Edit toggle */}
                  {canEdit && !isEditing && (
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={startEditing} title="Edit file">
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  {/* Save & Cancel (editing mode) */}
                  {isEditing && (
                    <>
                      <Button
                        variant="default"
                        size="sm"
                        className="h-7 text-xs gap-1"
                        onClick={saveFile}
                        disabled={saving || !isDirty}
                        title="Save (Ctrl+S)"
                      >
                        <Save className="h-3.5 w-3.5" />
                        {saving ? 'Saving…' : 'Save'}
                      </Button>
                      <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={cancelEditing} title="Cancel editing">
                        <Undo2 className="h-3.5 w-3.5" />
                        Cancel
                      </Button>
                    </>
                  )}
                </div>
              </div>
              {saveError && (
                <div className="px-4 py-1 text-xs text-red-500 bg-red-500/10 border-b">{saveError}</div>
              )}
              {isDirty && (
                <div className="px-4 py-0.5 text-xs text-yellow-600 bg-yellow-500/10 border-b">Unsaved changes</div>
              )}
              <div ref={viewerScrollRef} className="flex-1 overflow-auto" style={{ backgroundColor: isEditing ? undefined : activeThemeBg }}>
                {viewer.loading ? (
                  <div className="text-sm text-muted-foreground p-4">Loading…</div>
                ) : isEditing ? (
                  <Suspense fallback={<div className="text-sm text-muted-foreground p-4">Loading editor…</div>}>
                    <MonacoFileEditor
                      content={editContent}
                      language={viewerLanguage}
                      onChange={setEditContent}
                      onSave={saveFile}
                      fontSize={viewerFontSize}
                      darkMode={viewerTheme.toLowerCase().includes('dark') || viewerTheme === 'Monokai'}
                    />
                  </Suspense>
                ) : viewerIsImage ? (
                  <ImageViewer projectId={projectId} worktreeId={worktreeId} filePath={viewer.path} />
                ) : viewer.binary ? (
                  <div className="text-sm text-muted-foreground p-4">Binary file ({formatSize(viewer.size ?? 0)})</div>
                ) : viewer.content !== null && viewerIsMarkdown && renderMarkdown ? (
                  <div
                    ref={markdownViewerRef}
                    className={`p-6 overflow-auto leading-relaxed ${activeThemeText}`}
                    style={{ fontSize: `${viewerFontSize}px`, backgroundColor: activeThemeBg }}
                  >
                    {isMarkdownFullscreen && (
                      <div className="sticky top-0 z-10 mb-4 flex items-center gap-2 rounded-md border border-border bg-background/95 px-3 py-2 text-xs text-muted-foreground shadow">
                        <span className="font-medium text-foreground">Markdown navigation</span>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 gap-1 px-2 text-xs"
                          onClick={() => navigateViewerHistory(-1)}
                          disabled={!canGoBack}
                        >
                          <ChevronLeft className="h-3 w-3" />
                          Back
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 gap-1 px-2 text-xs"
                          onClick={() => navigateViewerHistory(1)}
                          disabled={!canGoForward}
                        >
                          Forward
                          <ChevronRight className="h-3 w-3" />
                        </Button>
                        <span className="ml-auto">Alt+Left / Alt+Right • Esc exits fullscreen</span>
                      </div>
                    )}
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        h1: ({ children }) => <h1 className="text-2xl font-bold mb-4 mt-2 border-b border-border pb-2">{children}</h1>,
                        h2: ({ children }) => <h2 className="text-xl font-semibold mb-3 mt-4 border-b border-border pb-1">{children}</h2>,
                        h3: ({ children }) => <h3 className="text-lg font-semibold mb-2 mt-3">{children}</h3>,
                        h4: ({ children }) => <h4 className="text-base font-semibold mb-2 mt-2">{children}</h4>,
                        p: ({ children }) => <p className="mb-3">{children}</p>,
                        ul: ({ children }) => <ul className="list-disc pl-6 mb-3 space-y-1">{children}</ul>,
                        ol: ({ children }) => <ol className="list-decimal pl-6 mb-3 space-y-1">{children}</ol>,
                        li: ({ children }) => <li className="leading-relaxed">{children}</li>,
                        code: ({ className, children }) => {
                          const isBlock = className?.includes('language-');
                          const language = className?.match(/language-(\S+)/)?.[1]?.toLowerCase();
                          if (isBlock && (language === 'mermaid' || language === 'mmd')) {
                            return (
                              <MermaidDiagram
                                chart={String(children).replace(/\n$/, '')}
                                darkMode={viewerTheme.toLowerCase().includes('dark') || viewerTheme === 'Monokai'}
                              />
                            );
                          }
                          return isBlock
                            ? <code className="block bg-[#2d2d2d] rounded p-3 text-xs font-mono overflow-x-auto mb-3">{children}</code>
                            : <code className="bg-[#2d2d2d] rounded px-1.5 py-0.5 text-xs font-mono">{children}</code>;
                        },
                        pre: ({ children }) => <pre className="mb-3">{children}</pre>,
                        blockquote: ({ children }) => <blockquote className="border-l-4 border-blue-500/50 pl-4 italic text-muted-foreground mb-3">{children}</blockquote>,
                        a: ({ href, children }) => {
                          const linkedFilePath = href ? resolveMarkdownFileHref(viewer.path, href) : null;
                          return (
                            <a
                              href={href}
                              className="text-blue-400 underline hover:text-blue-300"
                              target={linkedFilePath ? undefined : '_blank'}
                              rel={linkedFilePath ? undefined : 'noopener noreferrer'}
                              onClick={(e) => {
                                 e.stopPropagation();
                                 if (!linkedFilePath) return;
                                 e.preventDefault();
                                 rememberCurrentMarkdownScroll();
                                 openFile(linkedFilePath);
                               }}
                            >
                              {children}
                            </a>
                          );
                        },
                        hr: () => <hr className="border-border my-4" />,
                        table: ({ children }) => <div className="overflow-x-auto mb-3"><table className="border-collapse border border-border w-full text-sm">{children}</table></div>,
                        thead: ({ children }) => <thead className="bg-accent/50">{children}</thead>,
                        th: ({ children }) => <th className="border border-border px-3 py-1.5 text-left font-semibold">{children}</th>,
                        td: ({ children }) => <td className="border border-border px-3 py-1.5">{children}</td>,
                        del: ({ children }) => <del className="text-muted-foreground">{children}</del>,
                        input: ({ checked }) => <input type="checkbox" checked={checked} readOnly className="mr-1.5 align-middle" />,
                        img: ({ src, alt }) => (
                          <img
                            src={resolveMarkdownImageSrc(projectId, viewer.path, src, worktreeId)}
                            alt={alt ?? ''}
                            className="max-w-full rounded my-2"
                          />
                        ),
                      }}
                    >{viewer.content}</ReactMarkdown>
                  </div>
                ) : viewer.content !== null && viewerIsHtml && renderHtml ? (
                  <iframe
                    title={viewer.path}
                    srcDoc={viewer.content}
                    sandbox=""
                    className="h-full w-full border-0 bg-white"
                  />
                ) : viewer.content !== null ? (
                  <CodeViewer content={viewer.content} language={viewerLanguage} truncated={viewer.truncated} size={viewer.size} fontSize={viewerFontSize} showLineNumbers={showLines} wrapLines={wrapLines} themeName={viewerTheme} />
                ) : (
                  <div className="text-sm text-muted-foreground p-4">Could not load file</div>
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
              Select a file to view
            </div>
          )}
        </div>
      </div>
  );

  if (embedded) return innerContent;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      {innerContent}
    </div>
  );
}
