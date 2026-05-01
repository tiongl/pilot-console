import { auth } from '@/lib/auth';
import { getProjectById, listWorktrees, createWorktree } from '@/lib/project-store';
import { NextResponse } from 'next/server';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const project = getProjectById(id);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  return NextResponse.json({ worktrees: listWorktrees(id) });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const body = await req.json();
  const { name, branch, createNewBranch } = body as {
    name?: string;
    branch?: string;
    createNewBranch?: boolean;
  };

  if (!name?.trim() || !branch?.trim()) {
    return NextResponse.json({ error: 'name and branch are required' }, { status: 400 });
  }

  try {
    const worktree = createWorktree(id, name.trim(), branch.trim(), createNewBranch ?? false);
    return NextResponse.json(worktree, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
