'use client';

import { useMemo, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { Check, Copy } from 'lucide-react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import MermaidDiagram from './MermaidDiagram';
import 'katex/dist/katex.min.css';

function CodeBlock({
  language,
  value,
  darkMode,
}: {
  language?: string;
  value: string;
  darkMode: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const isLong = value.split('\n').length > 80;

  const copyCode = () => {
    if (!navigator.clipboard) return;
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    });
  };

  return (
    <div className="group relative mb-3 overflow-hidden rounded border border-border">
      <div className="flex items-center justify-between border-b border-border bg-black/10 px-2 py-1 text-[10px] text-muted-foreground">
        <span>{language || 'text'}</span>
        <div className="flex items-center gap-2">
          {isLong && (
            <button type="button" onClick={() => setExpanded((value) => !value)} className="hover:text-foreground">
              {expanded ? 'Collapse' : 'Expand'}
            </button>
          )}
          <button type="button" onClick={copyCode} aria-label="Copy code" title="Copy code" className="hover:text-foreground">
            {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
          </button>
        </div>
      </div>
      <div className={isLong && !expanded ? 'max-h-96 overflow-hidden' : undefined}>
        <SyntaxHighlighter
          language={language || 'text'}
          style={darkMode ? oneDark : oneLight}
          customStyle={{ margin: 0, borderRadius: 0, background: 'transparent', fontSize: '0.85em' }}
          wrapLongLines
        >
          {value}
        </SyntaxHighlighter>
      </div>
    </div>
  );
}

function markdownComponents(darkMode: boolean): Components {
  return {
    table: ({ children }: { children?: ReactNode }) => (
      <div className="my-2 overflow-x-auto">
        <table className="w-full border-collapse border border-border text-sm">{children}</table>
      </div>
    ),
    thead: ({ children }: { children?: ReactNode }) => <thead className="bg-black/10 dark:bg-white/10">{children}</thead>,
    th: ({ children }: { children?: ReactNode }) => <th className="border border-border px-3 py-1.5 text-left font-semibold">{children}</th>,
    td: ({ children }: { children?: ReactNode }) => <td className="border border-border px-3 py-1.5">{children}</td>,
    blockquote: ({ children }: { children?: ReactNode }) => (
      <blockquote className="my-3 border-l-4 border-blue-500/60 bg-blue-500/5 px-4 py-2 italic">{children}</blockquote>
    ),
    a: ({ href, children }: { href?: string; children?: ReactNode }) => {
      const external = Boolean(href && (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')));
      return (
        <a
          href={href}
          target={external ? '_blank' : undefined}
          rel={external ? 'noopener noreferrer' : undefined}
          className="text-blue-400 underline hover:text-blue-300"
        >
          {children}
        </a>
      );
    },
    img: ({ src, alt }: { src?: string; alt?: string }) => (
      <img src={src} alt={alt ?? ''} loading="lazy" referrerPolicy="no-referrer" className="my-2 max-w-full rounded" />
    ),
    pre: ({ children }: { children?: ReactNode }) => <>{children}</>,
    code: ({ className, children }) => {
      const language = className?.match(/language-(\S+)/)?.[1]?.toLowerCase();
      const value = String(children).replace(/\n$/, '');
      if (!className) return <code className="rounded bg-black/10 px-1.5 py-0.5 font-mono text-[0.9em]">{children}</code>;
      if (language === 'mermaid' || language === 'mmd') {
        return <MermaidDiagram chart={value} darkMode={darkMode} className="h-[360px] min-h-[220px] max-h-[60vh]" />;
      }
      return <CodeBlock language={language} value={value} darkMode={darkMode} />;
    },
  };
}

export default function RichMarkdown({ content, darkMode }: { content: string; darkMode: boolean }) {
  const components = useMemo(() => markdownComponents(darkMode), [darkMode]);
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={components}
    >
      {content}
    </ReactMarkdown>
  );
}
