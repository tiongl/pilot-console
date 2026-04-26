import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { signOut } from '@/lib/auth';
import { listProjects } from '@/lib/project-store';
import { Button } from '@/components/ui/button';
import { Plus, Shield, LogOut } from 'lucide-react';
import ProjectNav from '@/components/nav/ProjectNav';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session) redirect('/login');

  const isAdmin = session.user?.role === 'admin';
  const projects = listProjects();

  return (
    <div className="flex h-screen bg-background">
      {/* Sidebar */}
      <aside className="flex w-60 flex-col border-r bg-muted/40 px-3 py-4">
        <div className="mb-4 px-3">
          <h1 className="text-lg font-bold">GC Clippy</h1>
          <p className="text-xs text-muted-foreground truncate">{session.user?.name ?? session.user?.email}</p>
        </div>

        <div className="flex items-center justify-between px-3 mb-2">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Projects</span>
          <Link href="/projects/new" className="text-muted-foreground hover:text-foreground transition-colors">
            <Plus className="h-4 w-4" />
          </Link>
        </div>

        <nav className="flex flex-col gap-0.5 flex-1 overflow-y-auto">
          <ProjectNav projects={projects} />
        </nav>

        <div className="flex flex-col gap-1 border-t pt-3 mt-2">
          {isAdmin && (
            <Link
              href="/admin"
              className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground transition-colors"
            >
              <Shield className="h-4 w-4" />
              Admin
            </Link>
          )}
          <form
            action={async () => {
              'use server';
              await signOut({ redirectTo: '/login' });
            }}
          >
            <Button variant="ghost" type="submit" className="w-full justify-start gap-3 px-3">
              <LogOut className="h-4 w-4" />
              Sign out
            </Button>
          </form>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex flex-1 flex-col overflow-hidden">{children}</main>
    </div>
  );
}
