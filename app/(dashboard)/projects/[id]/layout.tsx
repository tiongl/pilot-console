import { getProjectById } from '@/lib/project-store';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { MessageSquare, History, Wrench, Settings } from 'lucide-react';

const subNavItems = [
  { suffix: '/chat', label: 'Chat', icon: MessageSquare },
  { suffix: '/sessions', label: 'Sessions', icon: History },
  { suffix: '/skills', label: 'Skills', icon: Wrench },
  { suffix: '/settings', label: 'Settings', icon: Settings },
];

export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const project = getProjectById(id);
  if (!project) notFound();

  const basePath = `/projects/${id}`;

  return (
    <div className="flex flex-col h-full">
      {/* Project header + sub-nav */}
      <div className="border-b px-6 pt-4 pb-0">
        <div className="mb-3">
          <h2 className="text-lg font-semibold">{project.name}</h2>
          <p className="text-xs text-muted-foreground font-mono truncate">{project.repoPath}</p>
        </div>
        <nav className="flex gap-4 -mb-px">
          {subNavItems.map(({ suffix, label, icon: Icon }) => (
            <Link
              key={suffix}
              href={`${basePath}${suffix}`}
              className="flex items-center gap-1.5 border-b-2 border-transparent px-1 pb-2 text-sm text-muted-foreground hover:text-foreground hover:border-foreground transition-colors"
            >
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          ))}
        </nav>
      </div>

      {/* Page content */}
      <div className="flex-1 overflow-hidden">{children}</div>
    </div>
  );
}
