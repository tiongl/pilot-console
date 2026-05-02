import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { ArrowLeft, FileText, Code, FileCode } from 'lucide-react';

interface ReportRun {
  id: string;
  scheduleId: string;
  status: string;
  triggeredBy: string;
  startedAt: string | null;
  completedAt: string | null;
  rawOutput: string | null;
  renderedOutput: string | null;
  rendererType: string | null;
  exitCode: number | null;
  wasTruncated: boolean;
  error: string | null;
  promptSnapshot: string | null;
}

function MarkdownViewer({ content }: { content: string }) {
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

function JsonViewer({ content }: { content: string }) {
  return (
    <pre className="bg-muted rounded-lg p-4 overflow-auto text-xs font-mono whitespace-pre-wrap">
      {content}
    </pre>
  );
}

function PlaintextViewer({ content }: { content: string }) {
  return (
    <pre className="bg-muted rounded-lg p-4 overflow-auto text-sm font-mono whitespace-pre-wrap">
      {content}
    </pre>
  );
}

function HtmlViewer({ content }: { content: string }) {
  return (
    <iframe
      srcDoc={content}
      sandbox=""
      className="w-full min-h-[400px] border rounded-lg bg-white"
      title="Report HTML output"
    />
  );
}

function ReportContent({ run }: { run: ReportRun }) {
  const [showRaw, setShowRaw] = useState(false);
  const content = showRaw ? run.rawOutput : (run.renderedOutput || run.rawOutput);

  if (!content) {
    return <p className="text-muted-foreground">No output available.</p>;
  }

  const rendererType = showRaw ? 'plaintext' : (run.rendererType || 'plaintext');

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button
          variant={showRaw ? 'outline' : 'default'}
          size="sm"
          onClick={() => setShowRaw(false)}
        >
          <FileText className="h-3.5 w-3.5 mr-1" />
          Rendered
        </Button>
        <Button
          variant={showRaw ? 'default' : 'outline'}
          size="sm"
          onClick={() => setShowRaw(true)}
        >
          <Code className="h-3.5 w-3.5 mr-1" />
          Raw
        </Button>
        <a
          href={`/api/admin/runs/${run.id}/file`}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto"
        >
          <Button variant="outline" size="sm">
            <FileCode className="h-3.5 w-3.5 mr-1" />
            Open File
          </Button>
        </a>
      </div>

      {rendererType === 'markdown' && <MarkdownViewer content={content} />}
      {rendererType === 'json' && <JsonViewer content={content} />}
      {rendererType === 'html' && <HtmlViewer content={content} />}
      {(rendererType === 'plaintext' || !['markdown', 'json', 'html'].includes(rendererType)) && (
        <PlaintextViewer content={content} />
      )}
    </div>
  );
}

export default function ReportViewerPage() {
  const { id } = useParams<{ id: string }>();
  const [run, setRun] = useState<ReportRun | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    fetch(`/api/admin/runs/${id}`)
      .then(r => r.json())
      .then(data => setRun(data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <div className="p-8 text-muted-foreground">Loading...</div>;
  if (!run) return <div className="p-8 text-destructive">Report not found.</div>;

  return (
    <div className="flex flex-col gap-6 p-8 overflow-y-auto">
      <div className="flex items-center gap-4">
        <Link
          to={`/admin/schedules/${run.scheduleId}/runs`}
          className="text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <FileCode className="h-5 w-5" />
            <h2 className="text-2xl font-bold">Report</h2>
            <Badge variant={run.status === 'completed' ? 'default' : 'destructive'}>{run.status}</Badge>
            {run.rendererType && <Badge variant="outline">{run.rendererType}</Badge>}
          </div>
          <p className="text-muted-foreground text-sm mt-1">
            {run.startedAt ? `Started: ${new Date(run.startedAt).toLocaleString()}` : ''}
            {run.completedAt ? ` · Completed: ${new Date(run.completedAt).toLocaleString()}` : ''}
            {run.exitCode !== null ? ` · Exit code: ${run.exitCode}` : ''}
          </p>
        </div>
      </div>

      {run.promptSnapshot && (
        <div className="border rounded-lg p-3 bg-muted/30">
          <p className="text-xs font-medium text-muted-foreground mb-1">Prompt</p>
          <p className="text-sm">{run.promptSnapshot}</p>
        </div>
      )}

      {run.error && (
        <div className="border border-destructive rounded-lg p-3 bg-destructive/5">
          <p className="text-sm text-destructive">{run.error}</p>
        </div>
      )}

      <ReportContent run={run} />
    </div>
  );
}
