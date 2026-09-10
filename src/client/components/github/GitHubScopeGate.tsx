import { AlertTriangle, KeyRound, Link2Off } from 'lucide-react';
import type { GitHubError } from '../../hooks/useGitHubResource';

/**
 * Renders an actionable explanation for the common GitHub error codes surfaced
 * by the server routes. Returns null when the error is not one it specializes
 * in, so callers can fall back to a generic error message.
 */
export function GitHubScopeGate({ error }: { error: GitHubError }): React.ReactElement | null {
  const code = error.code;

  if (code === 'missing-scope') {
    return (
      <Panel icon={<KeyRound className="h-5 w-5 text-amber-500" />} title="GitHub Projects scope required">
        <p>
          Projects V2 (boards, PRs-by-task) needs the <code className="font-mono">project</code> scope, which the
          server&rsquo;s GitHub token doesn&rsquo;t have yet. Milestones, Issues and Pull Requests still work without it.
        </p>
        <p className="mt-2">On the server, run:</p>
        <pre className="mt-1 rounded bg-muted px-3 py-2 font-mono text-xs">gh auth refresh -s project</pre>
        <p className="mt-2 text-xs text-muted-foreground">Then reload this view.</p>
      </Panel>
    );
  }

  if (code === 'not-authenticated') {
    return (
      <Panel icon={<KeyRound className="h-5 w-5 text-destructive" />} title="GitHub not authenticated">
        <p>
          The server&rsquo;s GitHub CLI isn&rsquo;t signed in. Run <code className="font-mono">gh auth login</code> on the
          server, then reload.
        </p>
      </Panel>
    );
  }

  if (code === 'no-link') {
    return (
      <Panel icon={<Link2Off className="h-5 w-5 text-muted-foreground" />} title="No GitHub Project linked">
        <p>
          This console project isn&rsquo;t linked to a GitHub Projects V2 board yet. Open project settings to pick one.
        </p>
      </Panel>
    );
  }

  if (code === 'no-remote' || code === 'not-found') {
    return (
      <Panel icon={<AlertTriangle className="h-5 w-5 text-destructive" />} title="GitHub repository not found">
        <p>{error.message}</p>
        <p className="mt-2 text-xs text-muted-foreground">
          Ensure the project&rsquo;s local repo has a GitHub <code className="font-mono">origin</code> remote.
        </p>
      </Panel>
    );
  }

  return null;
}

function Panel({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto mt-8 max-w-lg rounded-lg border bg-card p-5 text-sm">
      <div className="mb-2 flex items-center gap-2 font-semibold">
        {icon}
        {title}
      </div>
      <div className="text-muted-foreground">{children}</div>
    </div>
  );
}
