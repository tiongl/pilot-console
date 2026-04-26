import { auth } from '@/lib/auth';
import { listProjects, createProject } from '@/lib/project-store';
import { NextResponse } from 'next/server';

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return NextResponse.json(listProjects());
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const { name, repoPath, description } = body as { name?: string; repoPath?: string; description?: string };

  if (!name?.trim() || !repoPath?.trim()) {
    return NextResponse.json({ error: 'name and repoPath are required' }, { status: 400 });
  }

  try {
    const project = createProject(name.trim(), repoPath.trim(), description?.trim());
    return NextResponse.json(project, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
