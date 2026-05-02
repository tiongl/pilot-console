import { useRef, useCallback } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';

/** Map syntax-highlighter language names to Monaco language IDs */
const MONACO_LANG: Record<string, string> = {
  typescript: 'typescript',
  javascript: 'javascript',
  python: 'python',
  ruby: 'ruby',
  go: 'go',
  rust: 'rust',
  java: 'java',
  csharp: 'csharp',
  cpp: 'cpp',
  json: 'json',
  yaml: 'yaml',
  markdown: 'markdown',
  css: 'css',
  scss: 'scss',
  xml: 'xml',
  bash: 'shell',
  powershell: 'powershell',
  sql: 'sql',
  dockerfile: 'dockerfile',
  ini: 'ini',
};

interface Props {
  content: string;
  language: string;
  onChange?: (value: string) => void;
  onSave?: () => void;
  readOnly?: boolean;
  fontSize?: number;
  darkMode?: boolean;
}

export default function MonacoFileEditor({
  content,
  language,
  onChange,
  onSave,
  readOnly = false,
  fontSize = 14,
  darkMode = true,
}: Props) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);

  const handleMount: OnMount = useCallback((ed) => {
    editorRef.current = ed;
    // Ctrl+S / Cmd+S to save
    ed.addCommand(
      // eslint-disable-next-line no-bitwise
      2048 | 49, // KeyMod.CtrlCmd | KeyCode.KeyS
      () => onSave?.(),
    );
    ed.focus();
  }, [onSave]);

  return (
    <Editor
      height="100%"
      language={MONACO_LANG[language] || language || 'plaintext'}
      value={content}
      theme={darkMode ? 'vs-dark' : 'vs'}
      onChange={(val) => onChange?.(val ?? '')}
      onMount={handleMount}
      options={{
        readOnly,
        fontSize,
        minimap: { enabled: false },
        lineNumbers: 'on',
        wordWrap: 'on',
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 2,
        renderWhitespace: 'selection',
        padding: { top: 8 },
      }}
      loading={<div className="flex items-center justify-center h-full text-muted-foreground text-sm">Loading editor…</div>}
    />
  );
}
