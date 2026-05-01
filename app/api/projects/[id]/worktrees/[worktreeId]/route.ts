import { auth } from '@/lib/auth';
import { getWorktreeById, deleteWorktree } from '@/lib/project-store';
import { NextResponse } from 'next/server';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; worktreeId: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id, worktreeId } = await params;
  const wt = getWorktreeById(worktreeId);
  if (!wt || wt.projectId !== id) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  return NextResponse.json(wt);
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; worktreeId: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id, worktreeId } = await params;
  try {
    deleteWorktree(worktreeId, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
