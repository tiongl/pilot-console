'use client';

import { useState, useEffect, useMemo } from 'react';
import { X, AlertCircle, Loader2 } from 'lucide-react';
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
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

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

const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', c: 'cpp', cpp: 'cpp',
  cxx: 'cpp', cc: 'cpp', h: 'cpp', hpp: 'cpp', cs: 'csharp', json: 'json', yaml: 'yaml', yml: 'yaml',
  xml: 'xml', html: 'xml', htm: 'xml', css: 'css', scss: 'scss', sass: 'scss',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash', ps1: 'powershell', sql: 'sql',
  md: 'markdown', dockerfile: 'dockerfile', docker: 'dockerfile',
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

function buildFileApiUrl(projectId: string, endpoint: string, params: Record<string, string | undefined>, worktreeId?: string): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, value);
  }
  if (worktreeId) search.set('worktreeId', worktreeId);
  return `/api/projects/${projectId}/${endpoint}?${search.toString()}`;
}

interface FilePreviewModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  filePath: string;
  worktreeId?: string;
}

interface FileContent {
  content: string | null;
  binary?: boolean;
  truncated?: boolean;
  size?: number;
  error?: string;
}

export default function FilePreviewModal({
  open,
  onOpenChange,
  projectId,
  filePath,
  worktreeId,
}: FilePreviewModalProps) {
  const [file, setFile] = useState<FileContent>({ content: null });
  const [loading, setLoading] = useState(true);

  const language = useMemo(() => getLanguage(filePath), [filePath]);
  const isImage = useMemo(() => isImageFile(filePath), [filePath]);

  useEffect(() => {
    if (!open) return;

    setLoading(true);
    setFile({ content: null });

    const fetchFile = async () => {
      try {
        const url = buildFileApiUrl(projectId, 'file', { path: filePath }, worktreeId);
        const res = await fetch(url);

        if (!res.ok) {
          setFile({ content: null, error: `Failed to load file (${res.status})` });
          return;
        }

        const data = await res.json();
        setFile({
          content: data.content,
          binary: data.binary,
          truncated: data.truncated,
          size: data.size,
        });
      } catch (err) {
        setFile({ content: null, error: `Error loading file: ${err instanceof Error ? err.message : 'Unknown error'}` });
      } finally {
        setLoading(false);
      }
    };

    fetchFile();
  }, [open, projectId, filePath, worktreeId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[80vh] p-0 flex flex-col">
        <DialogHeader className="px-6 pt-6 pb-2 flex flex-row items-center justify-between space-y-0">
          <DialogTitle className="text-sm font-mono truncate">{filePath}</DialogTitle>
          <button
            onClick={() => onOpenChange(false)}
            className="h-6 w-6 rounded hover:bg-muted flex items-center justify-center"
          >
            <X className="h-4 w-4" />
          </button>
        </DialogHeader>

        <div className="flex-1 overflow-hidden bg-[#1e1e1e]">
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : file.error ? (
            <div className="flex items-center gap-2 p-4 text-red-400">
              <AlertCircle className="h-5 w-5 shrink-0" />
              <span>{file.error}</span>
            </div>
          ) : file.binary ? (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              Binary file
            </div>
          ) : isImage ? (
            <div className="flex items-center justify-center p-4 h-full">
              <img
                src={buildFileApiUrl(projectId, 'file-raw', { path: filePath }, worktreeId)}
                alt={filePath}
                className="max-w-full max-h-full object-contain"
              />
            </div>
          ) : (
            <div className="overflow-auto h-full">
              <SyntaxHighlighter
                language={language || 'text'}
                style={vs2015}
                customStyle={{ margin: 0, borderRadius: 0, background: 'transparent', fontSize: '0.85em' }}
                wrapLongLines
              >
                {file.content || ''}
              </SyntaxHighlighter>
              {file.truncated && (
                <div className="px-4 py-3 text-xs text-muted-foreground italic border-t border-border">
                  — File truncated —
                </div>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
