'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Folder, File, ChevronRight, ChevronDown, X, Copy, Check, Image as ImageIcon, Eye, Code, Minus, Plus, WrapText, Hash, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
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

function ImageViewer({ projectId, filePath }: { projectId: string; filePath: string }) {
  const url = `/api/projects/${projectId}/file-raw?path=${encodeURIComponent(filePath)}`;
  return (
    <div className="flex-1 flex items-center justify-center p-4 bg-[#1e1e1e]">
      <img src={url} alt={filePath} className="max-w-full max-h-full object-contain" />
    </div>
  );
}

export default function FileExplorer({ projectId, onClose, embedded }: { projectId: string; onClose?: () => void; embedded?: boolean }) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [dirContents, setDirContents] = useState<Map<string, FileEntry[]>>(new Map());
  const [viewer, setViewer] = useState<FileViewerState | null>(null);
  const [copied, setCopied] = useState(false);
  const [renderMarkdown, setRenderMarkdown] = useState(true);
  const [viewerFontSize, setViewerFontSize] = useState(() => parseInt(localStorage.getItem('clippy-viewer-fontsize') || '12'));
  const [viewerTheme, setViewerTheme] = useState<ViewerThemeName>(() => (localStorage.getItem('clippy-viewer-theme') as ViewerThemeName) || 'VS Dark');
  const [showLines, setShowLines] = useState(() => localStorage.getItem('clippy-viewer-lines') !== 'false');
  const [wrapLines, setWrapLines] = useState(() => localStorage.getItem('clippy-viewer-wrap') !== 'false');

  const updateFontSize = useCallback((delta: number) => {
    setViewerFontSize(s => { const n = Math.max(10, Math.min(24, s + delta)); localStorage.setItem('clippy-viewer-fontsize', String(n)); return n; });
  }, []);
  const updateTheme = useCallback((t: ViewerThemeName) => { setViewerTheme(t); localStorage.setItem('clippy-viewer-theme', t); }, []);
  const toggleLines = useCallback(() => { setShowLines(v => { localStorage.setItem('clippy-viewer-lines', String(!v)); return !v; }); }, []);
  const toggleWrap = useCallback(() => { setWrapLines(v => { localStorage.setItem('clippy-viewer-wrap', String(!v)); return !v; }); }, []);

  const activeThemeBg = VIEWER_THEMES[viewerTheme].bg;
  const activeThemeText = VIEWER_THEMES[viewerTheme].text;

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<{ path: string; type: 'file' | 'dir'; size?: number }[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doSearch = useCallback(async (q: string) => {
    if (!q.trim()) { setSearchResults(null); setSearchTruncated(false); return; }
    setSearchLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/files-search?q=${encodeURIComponent(q)}`);
      if (res.ok) {
        const data = await res.json();
        setSearchResults(data.results);
        setSearchTruncated(data.truncated ?? false);
      }
    } catch { /* ignore */ }
    setSearchLoading(false);
  }, [projectId]);

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
    const res = await fetch(`/api/projects/${projectId}/files?path=${encodeURIComponent(dirPath)}`);
    if (res.ok) {
      const data = await res.json();
      return data.items as FileEntry[];
    }
    return [];
  }, [projectId]);

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

  const openFile = useCallback(async (filePath: string) => {
    // For images, don't fetch content — show inline via raw endpoint
    if (isImageFile(filePath)) {
      setViewer({ path: filePath, content: null, binary: false, loading: false });
      return;
    }
    setViewer({ path: filePath, content: null, loading: true });
    try {
      const res = await fetch(`/api/projects/${projectId}/file?path=${encodeURIComponent(filePath)}`);
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
  }, [projectId]);

  const copyContent = useCallback(() => {
    if (viewer?.content) {
      navigator.clipboard.writeText(viewer.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }, [viewer]);

  // Close on Escape (modal mode only)
  useEffect(() => {
    if (embedded || !onClose) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, embedded]);

  const viewerLanguage = useMemo(() => viewer ? getLanguage(viewer.path) : '', [viewer?.path]);
  const viewerIsImage = useMemo(() => viewer ? isImageFile(viewer.path) : false, [viewer?.path]);
  const viewerIsMarkdown = useMemo(() => viewerLanguage === 'markdown', [viewerLanguage]);

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
        {!embedded && (
          <div className="flex items-center justify-between px-3 py-2 border-b">
            <span className="text-sm font-semibold">Files</span>
            {onClose && (
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClose}>
                <X className="h-4 w-4" />
              </Button>
            )}
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
                  {viewer.content && !viewerIsImage && !(viewerIsMarkdown && renderMarkdown) && (
                    <Button variant={showLines ? 'secondary' : 'ghost'} size="icon" className="h-7 w-7" onClick={toggleLines} title="Line numbers">
                      <Hash className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  {/* Wrap toggle */}
                  {viewer.content && !viewerIsImage && !(viewerIsMarkdown && renderMarkdown) && (
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
                  {/* Copy */}
                  {viewer.content && (
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={copyContent} title="Copy file content">
                      {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
                    </Button>
                  )}
                </div>
              </div>
              <div className="flex-1 overflow-auto" style={{ backgroundColor: activeThemeBg }}>
                {viewer.loading ? (
                  <div className="text-sm text-muted-foreground p-4">Loading…</div>
                ) : viewerIsImage ? (
                  <ImageViewer projectId={projectId} filePath={viewer.path} />
                ) : viewer.binary ? (
                  <div className="text-sm text-muted-foreground p-4">Binary file ({formatSize(viewer.size ?? 0)})</div>
                ) : viewer.content !== null && viewerIsMarkdown && renderMarkdown ? (
                  <div className={`p-6 overflow-auto leading-relaxed ${activeThemeText}`} style={{ fontSize: `${viewerFontSize}px` }}>
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
                          return isBlock
                            ? <code className="block bg-[#2d2d2d] rounded p-3 text-xs font-mono overflow-x-auto mb-3">{children}</code>
                            : <code className="bg-[#2d2d2d] rounded px-1.5 py-0.5 text-xs font-mono">{children}</code>;
                        },
                        pre: ({ children }) => <pre className="mb-3">{children}</pre>,
                        blockquote: ({ children }) => <blockquote className="border-l-4 border-blue-500/50 pl-4 italic text-muted-foreground mb-3">{children}</blockquote>,
                        a: ({ href, children }) => <a href={href} className="text-blue-400 underline hover:text-blue-300" target="_blank" rel="noopener noreferrer">{children}</a>,
                        hr: () => <hr className="border-border my-4" />,
                        table: ({ children }) => <div className="overflow-x-auto mb-3"><table className="border-collapse border border-border w-full text-sm">{children}</table></div>,
                        thead: ({ children }) => <thead className="bg-accent/50">{children}</thead>,
                        th: ({ children }) => <th className="border border-border px-3 py-1.5 text-left font-semibold">{children}</th>,
                        td: ({ children }) => <td className="border border-border px-3 py-1.5">{children}</td>,
                        del: ({ children }) => <del className="text-muted-foreground">{children}</del>,
                        input: ({ checked }) => <input type="checkbox" checked={checked} readOnly className="mr-1.5 align-middle" />,
                        img: ({ src, alt }) => <img src={src} alt={alt ?? ''} className="max-w-full rounded my-2" />,
                      }}
                    >{viewer.content}</ReactMarkdown>
                  </div>
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
