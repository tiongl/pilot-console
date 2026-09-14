import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation, useParams } from 'react-router';
import { KanbanSquare, Target, CircleDot, GitPullRequest, MessageSquare, Compass } from 'lucide-react';

interface Project {
  id: string;
  name: string;
  repoPath: string;
}

const VIEW_TABS = [
  { seg: 'board', label: 'Board', icon: KanbanSquare },
  { seg: 'milestones', label: 'Milestones', icon: Target },
  { seg: 'issues', label: 'Issues', icon: CircleDot },
  { seg: 'pulls', label: 'Pull Requests', icon: GitPullRequest },
] as const;

/**
 * Dedicated, full-width project view hosting the GitHub-backed tabs (board,
 * milestones, issues, pull requests). Separate from the chat/terminal workspace
 * so it can be opened directly from the project tree.
 */
export default function ProjectViewLayout() {
  const { id = '' } = useParams<{ id: string }>();
  const { pathname } = useLocation();
  const [project, setProject] = useState<Project | null>(null);

  useEffect(() => {
    if (!id) return;
    fetch(`/api/projects/${id}`)
      .then((r) => r.json())
      .then((p) => setProject(p))
      .catch(() => {});
  }, [id]);

  const base = `/projects/${id}/view`;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-4 py-2">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold">{project?.name ?? 'Project'}</h2>
          <p className="truncate font-mono text-xs text-muted-foreground">{project?.repoPath ?? ''}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Link
            to={`/projects/${id}/lead`}
            className="flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            title="Chat with Project Lead"
          >
            <Compass className="h-3.5 w-3.5" />
            Project Lead
          </Link>
          <Link
            to={`/projects/${id}/chat`}
            className="flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            title="Back to chat workspace"
          >
            <MessageSquare className="h-3.5 w-3.5" />
            Chat
          </Link>
        </div>
      </div>

      <div className="flex items-center gap-1 border-b px-2">
        {VIEW_TABS.map(({ seg, label, icon: Icon }) => {
          const active = pathname === `${base}/${seg}` || pathname.startsWith(`${base}/${seg}/`);
          return (
            <Link
              key={seg}
              to={`${base}/${seg}`}
              className={`flex items-center gap-1.5 border-b-2 px-2.5 py-1.5 text-xs transition-colors ${
                active
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </Link>
          );
        })}
      </div>

      <div className="flex-1 overflow-hidden">
        <Outlet />
      </div>
    </div>
  );
}
