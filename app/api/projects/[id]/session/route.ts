import { auth } from '@/lib/auth';
import { endSessionByProject } from '@/lib/cli-bridge';
import { NextResponse } from 'next/server';

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id: projectId } = await params;
  const killed = endSessionByProject(session.user.id, projectId);

  if (!killed) {
    return NextResponse.json({ error: 'No active session' }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
