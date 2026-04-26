import { auth } from '@/lib/auth';
import { listSessionsForUser, getCopilotSessionDetail } from '@/lib/session-store';
import { NextResponse } from 'next/server';

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const sessions = listSessionsForUser(session.user.id);
  return NextResponse.json(sessions);
}
