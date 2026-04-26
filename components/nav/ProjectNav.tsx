'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { FolderOpen } from 'lucide-react';
import type { Project } from '@/types';

interface Props {
  projects: Project[];
}

export default function ProjectNav({ projects }: Props) {
  const [activeProjectIds, setActiveProjectIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch('/api/sessions/active');
        if (res.ok) {
          const data = (await res.json()) as {
            sessions: Array<{ projectId: string; sessionId: string }>;
          };
          if (!cancelled) {
            setActiveProjectIds(new Set(data.sessions.map((s) => s.projectId)));
          }
        }
      } catch {
        // ignore fetch errors
      }
    }

    poll();
    const interval = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (projects.length === 0) {
    return (
      <p className="px-3 py-4 text-xs text-muted-foreground text-center">
        No projects yet.{' '}
        <Link href="/projects/new" className="underline">
          Create one
        </Link>
      </p>
    );
  }

  return (
    <>
      {projects.map((project) => (
        <Link
          key={project.id}
          href={`/projects/${project.id}/chat`}
          className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground transition-colors"
        >
          <FolderOpen className="h-4 w-4 shrink-0" />
          <span className="truncate">{project.name}</span>
          {activeProjectIds.has(project.id) && (
            <span className="ml-auto h-2 w-2 shrink-0 rounded-full bg-green-500" />
          )}
        </Link>
      ))}
    </>
  );
}
