'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { FolderOpen, Pin } from 'lucide-react';
import type { Project } from '@/types';

interface Props {
  projects: Project[];
}

export default function ProjectNav({ projects }: Props) {
  const [activeProjectIds, setActiveProjectIds] = useState<Set<string>>(new Set());
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetch('/api/projects')
      .then(r => r.ok ? r.json() : { projects: [] })
      .then((data: { projects: Array<{ id: string; pinned?: number }> }) => {
        setPinnedIds(new Set(data.projects.filter(p => p.pinned).map(p => p.id)));
      })
      .catch(() => {});
  }, []);

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

  const togglePin = useCallback(async (e: React.MouseEvent, projectId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const nowPinned = !pinnedIds.has(projectId);
    setPinnedIds(prev => {
      const next = new Set(prev);
      nowPinned ? next.add(projectId) : next.delete(projectId);
      return next;
    });
    try {
      await fetch(`/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned: nowPinned }),
      });
    } catch {}
  }, [pinnedIds]);

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

  // Sort: pinned first, then alphabetical
  const sorted = [...projects].sort((a, b) => {
    const aPinned = pinnedIds.has(a.id) ? 1 : 0;
    const bPinned = pinnedIds.has(b.id) ? 1 : 0;
    if (aPinned !== bPinned) return bPinned - aPinned;
    return a.name.localeCompare(b.name);
  });

  return (
    <>
      {sorted.map((project) => (
        <Link
          key={project.id}
          href={`/projects/${project.id}/chat`}
          className="group flex items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground transition-colors"
        >
          <FolderOpen className="h-4 w-4 shrink-0" />
          <span className="truncate flex-1">{project.name}</span>
          <button
            onClick={(e) => togglePin(e, project.id)}
            className={`h-4 w-4 shrink-0 transition-opacity ${
              pinnedIds.has(project.id)
                ? 'text-primary opacity-100'
                : 'text-muted-foreground opacity-0 group-hover:opacity-100'
            }`}
            title={pinnedIds.has(project.id) ? 'Unpin' : 'Pin to top'}
          >
            <Pin className="h-3.5 w-3.5" />
          </button>
          {activeProjectIds.has(project.id) && (
            <span className="h-2 w-2 shrink-0 rounded-full bg-green-500" />
          )}
        </Link>
      ))}
    </>
  );
}
